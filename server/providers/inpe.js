import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { filterTrailing24h } from '../../src/data/firmsCsv.js';
import {
  filterByBiome,
  inpeDailyFileName,
  parseBiomeList,
  parseInpeCsv,
} from '../../src/data/inpeCsv.js';
import { readCappedResponseText } from './common/http.js';

/**
 * INPE Programa Queimadas (Brazil) active-fire proxy with a memory + disk
 * cache — the keyless Amazon sibling of the NASA FIRMS proxy, answering the
 * same `{fetchedAt, stale, ttlMs, sources, count, fires}` contract so the
 * browser reuses the fires layer unchanged.
 *
 * Upstream: https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil/focos_diario_br_YYYYMMDD.csv
 *
 * One file per UTC day, regenerated through the day, so today AND yesterday
 * are fetched (sequentially, as a courtesy to a public server with no quota
 * API) and clamped to the trailing 24 h via src/data/firmsCsv.js. Rows are
 * filtered to INPE_FIRES_BIOMES (default "Amazônia") before caching, which
 * keeps the payload near 10k detections instead of ~27k for all of Brazil.
 * TTL 20 min, single-flight refresh, serve-stale-on-failure, and a
 * fresh-enough disk cache (.gev-cache/inpe.json) prevents any upstream fetch
 * across dev-server restarts. Pattern mirrors firmsProxy; there is no key.
 *
 * Routes:
 *   GET /api/inpe        → {fetchedAt, stale, ttlMs, biomes, sources, count, fires}
 *   GET /api/inpe/status → {lastFetch, count, stale, ttlMs, biomes}
 *
 * @returns {import('vite').Plugin}
 */
export function inpeProxy() {
  const TTL_MS = 20 * 60_000;
  const DAY_MS = 24 * 3600_000;
  const UPSTREAM_BASE =
    'https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil/';
  // A full-Brazil day was 336 KB at dawn and ~4 MB late in the burning
  // season (2026-09-17: 26,731 rows); 64 MB is a runaway guard, not a budget.
  const MAX_UPSTREAM_BYTES = 64 * 1024 * 1024;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'inpe.json');

  /** @type {?{at: number, biomes: ?Array<string>, sources: Array<object>, fires: Array<object>}} */
  let mem = null;
  let diskChecked = false;
  /** @type {?Promise<?{at: number, biomes: ?Array<string>, sources: Array<object>, fires: Array<object>}>} single-flight refresh */
  let inflight = null;

  const selectedBiomes = () => parseBiomeList(process.env.INPE_FIRES_BIOMES);
  const sameBiomes = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (
        Number.isFinite(parsed?.at) &&
        Array.isArray(parsed?.sources) &&
        Array.isArray(parsed?.fires)
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
      console.warn('[inpe-proxy] cache write failed:', err?.message || err);
    }
  }

  /** Today's and yesterday's daily files for the UTC day containing `nowMs`. */
  function dailySources(nowMs) {
    return [inpeDailyFileName(nowMs - DAY_MS), inpeDailyFileName(nowMs)];
  }

  /**
   * Fetch + parse one daily file. Throws on HTTP error (today's file 404s for
   * a while after 00:00 UTC — that is a normal partial-success case), an
   * oversized body, or a non-CSV body (the server answers HTML for a missing
   * file behind some redirects).
   */
  async function fetchSource(source) {
    const res = await fetch(UPSTREAM_BASE + source, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { tooLarge, text } = await readCappedResponseText(
      res,
      MAX_UPSTREAM_BYTES,
    );
    if (tooLarge) throw new Error('upstream body over cap');
    const records = parseInpeCsv(text);
    if (records === null) throw new Error('non-CSV upstream response');
    return records;
  }

  /**
   * Refresh both daily files sequentially (never in parallel). Partial
   * success (≥1 file ok) still produces a cacheable entry with the failed
   * file marked ok:false; total failure throws so the caller can serve stale.
   */
  async function refreshUpstream(biomes) {
    const now = Date.now();
    const sources = [];
    const fires = [];
    for (const source of dailySources(now)) {
      try {
        const records = filterTrailing24h(
          filterByBiome(await fetchSource(source), biomes),
          now,
        );
        // NOT fires.push(...records): a spread passes each record as an
        // argument and V8 caps that around 125k (see firms.js).
        for (const record of records) fires.push(record);
        sources.push({ source, count: records.length, ok: true });
      } catch (err) {
        console.warn(
          `[inpe-proxy] ${source} fetch failed:`,
          err?.message || err,
        );
        sources.push({ source, count: 0, ok: false });
      }
    }
    if (!sources.some((s) => s.ok)) throw new Error('all INPE sources failed');
    return { at: now, biomes, sources, fires };
  }

  /**
   * Cache entry → response payload. Fires are RE-filtered to the trailing
   * 24 h at serve time so a stale cache never serves >24h-old detections.
   */
  function buildPayload(entry, stale) {
    const fires = filterTrailing24h(entry.fires, Date.now());
    return {
      fetchedAt: entry.at,
      stale,
      ttlMs: TTL_MS,
      biomes: entry.biomes ?? null,
      sources: entry.sources,
      count: fires.length,
      fires,
    };
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/inpe', async (req, res) => {
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
        const biomes = selectedBiomes();
        await readDiskOnce();

        if (subPath === '/status') {
          sendJson(200, {
            lastFetch: mem ? mem.at : null,
            count: mem ? mem.fires.length : null,
            stale: mem ? Date.now() - mem.at >= TTL_MS : false,
            ttlMs: TTL_MS,
            biomes,
          });
          return;
        }

        // A cache built for another biome selection (INPE_FIRES_BIOMES
        // changed between restarts) is only good as a stale fallback.
        const entry = mem;
        const entryMatches = entry && sameBiomes(entry.biomes ?? null, biomes);
        if (entryMatches && Date.now() - entry.at < TTL_MS) {
          sendJson(200, buildPayload(entry, false));
          return;
        }
        // Stale or missing → refresh, single-flight (concurrent requests
        // share one upstream pass). Capture the promise locally BEFORE
        // awaiting: the .finally() nulls `inflight` the moment it settles.
        if (!inflight) {
          inflight = refreshUpstream(biomes)
            .then(async (fresh) => {
              mem = fresh;
              await writeDisk(fresh);
              return fresh;
            })
            .catch((err) => {
              console.warn(
                `[inpe-proxy] refresh failed (${err?.message || err}) — serving cache if any`,
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
          sendJson(200, buildPayload(entry, true)); // upstream down — stale beats empty
        } else {
          sendJson(502, {
            error: 'inpe fetch failed and no cache available',
          });
        }
      } catch (err) {
        console.warn('[inpe-proxy] error:', err?.message || err);
        sendJson(500, { error: 'inpe proxy error' });
      }
    });
  };
  return {
    name: 'inpe-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
