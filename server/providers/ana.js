import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  ANA_INVENTORY_URL,
  anaTelemetryUrl,
  knownStation,
  parseAnaTelemetryXml,
  parseStationCodes,
  summarizeReadings,
} from '../../src/data/anaTelemetry.js';
import { readCappedResponseText } from './common/http.js';

/**
 * ANA river-gauge telemetry proxy (Brazil) with a memory + disk cache.
 * Keyless: the legacy SOAP endpoint at telemetriaws1.ana.gov.br answers GET
 * requests with an XML DataSet and no authentication.
 *
 * Upstream per station:
 *   https://telemetriaws1.ana.gov.br/ServiceANA.asmx/DadosHidrometeorologicos?codEstacao=…&dataInicio=dd/mm/yyyy&dataFim=dd/mm/yyyy
 *
 * Stations come from `ANA_STATIONS` (default: the Solimões–Amazonas–Negro
 * trunk, see src/data/anaTelemetry.js). Each refresh fetches the trailing
 * three calendar days for every station SEQUENTIALLY (a public server with no
 * quota API deserves one request at a time), summarizes the series
 * (level, 24 h trend, 48 h sparkline) and caches for 15 minutes in memory and
 * `.gev-cache/ana-gauges.json`. A station the table does not know is resolved
 * against the 4 MB inventory (cached 7 days on disk); one that stays unknown
 * is skipped, not fatal. Partial success still caches; total failure serves
 * stale. Single-flight refresh.
 *
 * Routes:
 *   GET /api/ana-gauges        → {fetchedAt, stale, ttlMs, count, stations}
 *   GET /api/ana-gauges/status → {lastFetch, count, stale, ttlMs, codes}
 *
 * @returns {import('vite').Plugin}
 */
export function anaGaugesProxy() {
  const TTL_MS = 15 * 60_000;
  const WINDOW_MS = 3 * 24 * 3600_000;
  const INVENTORY_TTL_MS = 7 * 24 * 3600_000;
  const MAX_STATION_BYTES = 4 * 1024 * 1024; // a 3-day series is ~100 KB
  const MAX_INVENTORY_BYTES = 32 * 1024 * 1024; // ~4 MB in 2026
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'ana-gauges.json');
  const INVENTORY_PATH = path.join(CACHE_DIR, 'ana-inventory.json');

  /** @type {?{at: number, codes: Array<string>, stations: Array<object>}} */
  let mem = null;
  let diskChecked = false;
  /** @type {?Promise<?object>} single-flight refresh */
  let inflight = null;
  /** @type {?{at: number, stations: Record<string, object>}} */
  let inventory = null;

  const selectedCodes = () => parseStationCodes(process.env.ANA_STATIONS);
  const sameCodes = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (
        Number.isFinite(parsed?.at) &&
        Array.isArray(parsed?.codes) &&
        Array.isArray(parsed?.stations)
      )
        mem = parsed;
    } catch {
      /* no disk cache yet */
    }
    try {
      const parsed = JSON.parse(await fsp.readFile(INVENTORY_PATH, 'utf8'));
      if (Number.isFinite(parsed?.at) && parsed?.stations) inventory = parsed;
    } catch {
      /* no inventory cache yet */
    }
  }

  async function writeJson(file, entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(file, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[ana-proxy] cache write failed:', err?.message || err);
    }
  }

  async function fetchText(url, maxBytes, timeoutMs) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { tooLarge, text } = await readCappedResponseText(res, maxBytes);
    if (tooLarge) throw new Error('upstream body over cap');
    return text;
  }

  /** Inventory rows keyed by code: {name, river, lat, lon}. */
  function parseInventory(text) {
    const stations = {};
    const blocks = text.match(/<Table\b[^>]*>[\s\S]*?<\/Table>/g) || [];
    for (const block of blocks) {
      const get = (tag) =>
        (new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block)?.[1] || '').trim();
      const code = get('CodEstacao');
      const lat = Number(get('Latitude'));
      const lon = Number(get('Longitude'));
      if (
        !/^\d{8}$/.test(code) ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lon)
      )
        continue;
      stations[code] = {
        name: titleCase(get('NomeEstacao')),
        river: titleCase(get('NomeRio')),
        lat,
        lon,
      };
    }
    return stations;
  }

  function titleCase(text) {
    return String(text || '')
      .toLowerCase()
      .replace(
        /(^|[\s(-])([a-záéíóúâêôãõç])/g,
        (m, sep, ch) => sep + ch.toUpperCase(),
      )
      .trim();
  }

  /** Resolve unknown codes through the inventory (fetched at most weekly). */
  async function resolveStations(codes) {
    const unknown = codes.filter((code) => !knownStation(code));
    if (
      unknown.length &&
      (!inventory || Date.now() - inventory.at > INVENTORY_TTL_MS)
    ) {
      try {
        const text = await fetchText(
          ANA_INVENTORY_URL,
          MAX_INVENTORY_BYTES,
          60_000,
        );
        inventory = { at: Date.now(), stations: parseInventory(text) };
        await writeJson(INVENTORY_PATH, inventory);
      } catch (err) {
        console.warn(
          '[ana-proxy] inventory fetch failed:',
          err?.message || err,
        );
      }
    }
    const resolved = [];
    for (const code of codes) {
      const known = knownStation(code) || inventory?.stations?.[code];
      if (!known) {
        console.warn(`[ana-proxy] station ${code} unknown — skipped`);
        continue;
      }
      resolved.push({ code, ...known });
    }
    return resolved;
  }

  async function refreshUpstream(codes) {
    const now = Date.now();
    const stations = [];
    let okCount = 0;
    for (const station of await resolveStations(codes)) {
      try {
        const text = await fetchText(
          anaTelemetryUrl(station.code, now - WINDOW_MS, now),
          MAX_STATION_BYTES,
          30_000,
        );
        const readings = parseAnaTelemetryXml(text);
        if (readings === null) throw new Error('non-XML upstream response');
        stations.push({
          ...station,
          ok: true,
          readings,
          summary: summarizeReadings(readings, now),
        });
        okCount += 1;
      } catch (err) {
        console.warn(
          `[ana-proxy] ${station.code} fetch failed:`,
          err?.message || err,
        );
        stations.push({ ...station, ok: false, readings: [], summary: null });
      }
    }
    if (!okCount) throw new Error('all ANA stations failed');
    return { at: now, codes, stations };
  }

  function buildPayload(entry, stale) {
    return {
      fetchedAt: entry.at,
      stale,
      ttlMs: TTL_MS,
      count: entry.stations.filter((s) => s.summary).length,
      stations: entry.stations,
    };
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/ana-gauges', async (req, res) => {
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
        const codes = selectedCodes();
        await readDiskOnce();

        if (subPath === '/status') {
          sendJson(200, {
            lastFetch: mem ? mem.at : null,
            count: mem ? mem.stations.length : null,
            stale: mem ? Date.now() - mem.at >= TTL_MS : false,
            ttlMs: TTL_MS,
            codes,
          });
          return;
        }

        const entry = mem;
        const entryMatches = entry && sameCodes(entry.codes, codes);
        if (entryMatches && Date.now() - entry.at < TTL_MS) {
          sendJson(200, buildPayload(entry, false));
          return;
        }
        if (!inflight) {
          inflight = refreshUpstream(codes)
            .then(async (fresh) => {
              mem = fresh;
              await writeJson(CACHE_PATH, fresh);
              return fresh;
            })
            .catch((err) => {
              console.warn(
                `[ana-proxy] refresh failed (${err?.message || err}) — serving cache if any`,
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
          sendJson(502, { error: 'ana fetch failed and no cache available' });
      } catch (err) {
        console.warn('[ana-proxy] error:', err?.message || err);
        sendJson(500, { error: 'ana proxy error' });
      }
    });
  };
  return {
    name: 'ana-gauges-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
