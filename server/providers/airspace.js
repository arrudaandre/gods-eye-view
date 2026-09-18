import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  AIRSPACE_LAYERS,
  airspaceWfsUrl,
  normalizeAirspaceCollection,
  parseBbox,
} from '../../src/data/airspaceModel.js';
import { readCappedResponseText } from './common/http.js';

/**
 * DECEA GeoAISWEB airspace proxy (Brazil) with a memory + disk cache.
 * Keyless: the ICA GeoServer answers WFS GetFeature openly.
 *
 * Upstream per layer:
 *   https://geoaisweb.decea.mil.br/geoserver/ICA/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=ICA:<layer>&outputFormat=application/json&bbox=<w,s,e,n>,EPSG:4326
 *
 * Walks TMA, CTR, ATZ, prohibited/restricted/danger areas, aerodromes and
 * heliports SEQUENTIALLY inside `AIRSPACE_BBOX` (default Amazonas state),
 * normalizes every feature with the pure `src/data/airspaceModel.js`
 * (vertical limits → metres + labels, ident/name, point or rings) and caches
 * 24 h in memory and `.gev-cache/airspace.json` — airspace changes on the
 * 28-day AIRAC cycle, not per request. Partial success caches with the
 * failed layers marked; total failure serves stale. Single-flight refresh.
 *
 * Routes:
 *   GET /api/airspace        → {fetchedAt, stale, ttlMs, bbox, layers, count, features}
 *   GET /api/airspace/status → {lastFetch, count, stale, ttlMs, bbox}
 *
 * @returns {import('vite').Plugin}
 */
export function airspaceProxy() {
  const TTL_MS = 24 * 3600_000;
  const MAX_LAYER_BYTES = 48 * 1024 * 1024; // Brazil-wide airports are ~3 MB
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'airspace.json');

  /** @type {?{at: number, bbox: object, layers: Array<object>, features: Array<object>}} */
  let mem = null;
  let diskChecked = false;
  /** @type {?Promise<?object>} single-flight refresh */
  let inflight = null;

  const selectedBbox = () => parseBbox(process.env.AIRSPACE_BBOX);
  const sameBbox = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (
        Number.isFinite(parsed?.at) &&
        parsed?.bbox &&
        Array.isArray(parsed?.layers) &&
        Array.isArray(parsed?.features)
      )
        mem = parsed;
    } catch {
      /* no disk cache yet */
    }
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[airspace-proxy] cache write failed:', err?.message || err);
    }
  }

  async function fetchLayer(layer, bbox) {
    const res = await fetch(airspaceWfsUrl(layer.typeName, bbox), {
      signal: AbortSignal.timeout(90_000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { tooLarge, text } = await readCappedResponseText(
      res,
      MAX_LAYER_BYTES,
    );
    if (tooLarge) throw new Error('upstream body over cap');
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('non-JSON upstream response');
    }
    const features = normalizeAirspaceCollection(layer, payload);
    if (features === null) throw new Error('malformed WFS response');
    return features;
  }

  async function refreshUpstream(bbox) {
    const now = Date.now();
    const layers = [];
    const features = [];
    for (const layer of AIRSPACE_LAYERS) {
      try {
        const rows = await fetchLayer(layer, bbox);
        for (const row of rows) features.push(row);
        layers.push({
          typeName: layer.typeName,
          kind: layer.kind,
          count: rows.length,
          ok: true,
        });
      } catch (err) {
        console.warn(
          `[airspace-proxy] ${layer.typeName} fetch failed:`,
          err?.message || err,
        );
        layers.push({
          typeName: layer.typeName,
          kind: layer.kind,
          count: 0,
          ok: false,
        });
      }
    }
    if (!layers.some((l) => l.ok))
      throw new Error('all GeoAISWEB layers failed');
    return { at: now, bbox, layers, features };
  }

  function buildPayload(entry, stale) {
    return {
      fetchedAt: entry.at,
      stale,
      ttlMs: TTL_MS,
      bbox: entry.bbox,
      layers: entry.layers,
      count: entry.features.length,
      features: entry.features,
    };
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/airspace', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      try {
        const subPath = String(req.url || '').split('?')[0];
        const bbox = selectedBbox();
        await readDiskOnce();

        if (subPath === '/status') {
          sendJson(200, {
            lastFetch: mem ? mem.at : null,
            count: mem ? mem.features.length : null,
            stale: mem ? Date.now() - mem.at >= TTL_MS : false,
            ttlMs: TTL_MS,
            bbox,
          });
          return;
        }

        const entry = mem;
        const entryMatches = entry && sameBbox(entry.bbox, bbox);
        if (entryMatches && Date.now() - entry.at < TTL_MS) {
          sendJson(200, buildPayload(entry, false));
          return;
        }
        if (!inflight) {
          inflight = refreshUpstream(bbox)
            .then(async (fresh) => {
              mem = fresh;
              await writeDisk(fresh);
              return fresh;
            })
            .catch((err) => {
              console.warn(
                `[airspace-proxy] refresh failed (${err?.message || err}) — serving cache if any`,
              );
              return null;
            })
            .finally(() => {
              inflight = null;
            });
        }
        const pending = inflight;
        const fresh = await pending;
        if (fresh) sendJson(200, buildPayload(fresh, false));
        else if (entry) sendJson(200, buildPayload(entry, true));
        else
          sendJson(502, {
            error: 'airspace fetch failed and no cache available',
          });
      } catch (err) {
        console.warn('[airspace-proxy] error:', err?.message || err);
        sendJson(500, { error: 'airspace proxy error' });
      }
    });
  };
  return {
    name: 'airspace-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
