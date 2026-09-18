import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  deterDaysFromEnv,
  deterSinceDate,
  deterWfsUrl,
  filterDeterSince,
  normalizeDeterCollection,
} from '../../src/data/deterModel.js';
import { readCappedResponseText } from './common/http.js';

/**
 * INPE DETER (Amazon deforestation/degradation alerts) proxy with a memory +
 * disk cache. Keyless: TerraBrasilis publishes the WFS openly.
 *
 * Upstream: https://terrabrasilis.dpi.inpe.br/geoserver/deter-amz/deter_amz/ows
 * (GetFeature, GeoJSON, `CQL_FILTER=view_date>='YYYY-MM-DD'`).
 *
 * DETER publishes in weekly batches, so the proxy refreshes every 6 h and
 * answers the trailing `DETER_DAYS` window (default 30, max 120). Features are
 * compacted server-side (class, date, place, area, centroid, rings) so the
 * browser never parses GeoServer's verbose properties. A fresh-enough disk
 * cache (.gev-cache/deter.json) survives dev-server restarts; a stale cache is
 * served when upstream fails, re-clamped to the window at serve time so it can
 * never hand out alerts older than the configured window. Single-flight
 * refresh. Pattern mirrors inpeProxy.
 *
 * Routes:
 *   GET /api/deter        → {fetchedAt, stale, ttlMs, since, days, count, features}
 *   GET /api/deter/status → {lastFetch, count, stale, ttlMs, since, days}
 *
 * @returns {import('vite').Plugin}
 */
export function deterProxy() {
  const TTL_MS = 6 * 3600_000;
  // 30 days of Amazon alerts was ~4 MB in September 2026; 48 MB is a runaway
  // guard for a mis-set window, not a budget.
  const MAX_UPSTREAM_BYTES = 48 * 1024 * 1024;
  const UPSTREAM_TIMEOUT_MS = 120_000; // a cold GeoServer took 12 s; be patient
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'deter.json');

  /** @type {?{at: number, days: number, since: string, features: Array<object>}} */
  let mem = null;
  let diskChecked = false;
  /** @type {?Promise<?object>} single-flight refresh */
  let inflight = null;

  const selectedDays = () => deterDaysFromEnv(process.env.DETER_DAYS);

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (
        Number.isFinite(parsed?.at) &&
        Number.isFinite(parsed?.days) &&
        Array.isArray(parsed?.features)
      ) {
        mem = parsed;
      }
    } catch {
      /* no disk cache yet */
    }
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[deter-proxy] cache write failed:', err?.message || err);
    }
  }

  async function refreshUpstream(days) {
    const now = Date.now();
    const since = deterSinceDate(now, days);
    const res = await fetch(deterWfsUrl({ since }), {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { tooLarge, text } = await readCappedResponseText(
      res,
      MAX_UPSTREAM_BYTES,
    );
    if (tooLarge) throw new Error('upstream body over cap');
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      // GeoServer answers an XML ServiceException with 200 for a bad filter.
      throw new Error('non-JSON upstream response');
    }
    const features = normalizeDeterCollection(payload);
    if (features === null) throw new Error('malformed WFS response');
    return { at: now, days, since, features };
  }

  /** Cache entry → response payload, re-clamped to the window at serve time. */
  function buildPayload(entry, stale) {
    const since = deterSinceDate(Date.now(), entry.days);
    const features = filterDeterSince(entry.features, since);
    return {
      fetchedAt: entry.at,
      stale,
      ttlMs: TTL_MS,
      since,
      days: entry.days,
      count: features.length,
      features,
    };
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/deter', async (req, res) => {
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
        const days = selectedDays();
        await readDiskOnce();

        if (subPath === '/status') {
          sendJson(200, {
            lastFetch: mem ? mem.at : null,
            count: mem ? mem.features.length : null,
            stale: mem ? Date.now() - mem.at >= TTL_MS : false,
            ttlMs: TTL_MS,
            since: deterSinceDate(Date.now(), days),
            days,
          });
          return;
        }

        // A cache built for a shorter window than the one now configured
        // cannot answer it; a longer one can (it is clamped at serve time).
        const entry = mem;
        const entryMatches = entry && entry.days >= days;
        if (entryMatches && Date.now() - entry.at < TTL_MS) {
          sendJson(200, buildPayload({ ...entry, days }, false));
          return;
        }
        if (!inflight) {
          inflight = refreshUpstream(days)
            .then(async (fresh) => {
              mem = fresh;
              await writeDisk(fresh);
              return fresh;
            })
            .catch((err) => {
              console.warn(
                `[deter-proxy] refresh failed (${err?.message || err}) — serving cache if any`,
              );
              return null;
            })
            .finally(() => {
              inflight = null;
            });
        }
        const pending = inflight;
        const fresh = await pending;
        if (fresh) {
          sendJson(200, buildPayload(fresh, false));
        } else if (entry) {
          sendJson(200, buildPayload({ ...entry, days }, true));
        } else {
          sendJson(502, { error: 'deter fetch failed and no cache available' });
        }
      } catch (err) {
        console.warn('[deter-proxy] error:', err?.message || err);
        sendJson(500, { error: 'deter proxy error' });
      }
    });
  };
  return {
    name: 'deter-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
