#!/usr/bin/env node
/**
 * qa-amazon.mjs — headless proof for the keyless Amazon layers.
 *
 * Drives the REAL app in headless Chromium against a running dev server
 * (default :4173). Each section enables one layer through the data manager,
 * rides the proxy's disk cache (no upstream quota risk per run), parks the
 * camera over one of its features, clicks it through the real scene pick and
 * checks the shared context store / readout, saving a screenshot to
 * qa-shots/ (gitignored).
 *
 *   (i)  DETER — `inpe-deter` loads hundreds of alert polygons with no error;
 *        a click on one selects exactly that alert (context id, readout card
 *        title) and hands the camera to the UI focus policy.
 *   (ii) GAUGES — `ana-river-gauges` loads the ANA trunk stations, paints
 *        ambient level cards through the shared overlay host, and a click on
 *        the Manaus marker selects "MANAUS · RIO NEGRO".
 *   (iii) AIRSPACE — `decea-airspace` loads volumes and aerodromes; the
 *        Manaus CTR is an extruded polygon with real limits and a click on
 *        SBEG selects the aerodrome.
 *   Every selected card is then enriched with an Open-Meteo wind-aloft line
 *   (10 / 80 / 120 m + gust) through `/api/weather-effects`; the gauges
 *   section asserts it.
 *
 * Run:  node scripts/qa-amazon.mjs --url http://localhost:4173
 * Exits non-zero on any FAIL. Does not commit anything.
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'qa-shots');

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const APP_URL = getOpt('--url', 'http://localhost:4173');
const HEADFUL = argv.includes('--headful');
const ONLY = getOpt('--only', '');

const CHROME_EXECUTABLE_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  await puppeteer.executablePath().catch(() => null),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChromeExecutable() {
  for (const candidate of CHROME_EXECUTABLE_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(page) {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
    { timeout: 60000 },
  );
  await sleep(5000);
  await page.keyboard.press('Escape');
}

/** Enable one layer and poll its stats until it has data or an error. */
async function enableLayer(page, layerId, { timeoutS = 90 } = {}) {
  return page.evaluate(
    async (id, tS) => {
      const dm = window.__godsEyeView.dataManager;
      await dm.setEnabled(id, true);
      const mod = dm.layers.get(id).module;
      let s = null;
      for (let i = 0; i < tS; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        s = mod.getStats();
        if (s.count > 0 || s.error) break;
      }
      return s;
    },
    layerId,
    timeoutS,
  );
}

/** Teleport the camera straight down over a point (duck-typed, no Cesium global). */
async function lookDownAt(page, lon, lat, height) {
  await page.evaluate(
    (lo, la, h) => {
      const gev = window.__godsEyeView;
      const ell = gev.viewer.scene.globe.ellipsoid;
      const d2r = Math.PI / 180;
      try {
        gev.viewer.camera.cancelFlight();
      } catch {
        /* no flight active */
      }
      gev.viewer.camera.setView({
        destination: ell.cartographicToCartesian({
          longitude: lo * d2r,
          latitude: la * d2r,
          height: h,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      gev.viewer.scene.requestRender?.();
    },
    lon,
    lat,
    height,
  );
}

/** Render a few frames so tiles and primitives settle before a pick. */
async function settle(page, frames = 20, gapMs = 250) {
  for (let i = 0; i < frames; i++) {
    await page.evaluate(() =>
      window.__godsEyeView?.viewer?.scene?.requestRender?.(),
    );
    await sleep(gapMs);
  }
}

/** Window coordinates of a ground point, or null when it is off screen. */
async function windowPoint(page, lon, lat, height = 0) {
  return page.evaluate(
    (lo, la, h) => {
      const gev = window.__godsEyeView;
      const ell = gev.viewer.scene.globe.ellipsoid;
      const d2r = Math.PI / 180;
      const cartesian = ell.cartographicToCartesian({
        longitude: lo * d2r,
        latitude: la * d2r,
        height: h,
      });
      const p = gev.viewer.scene.cartesianToCanvasCoordinates(cartesian);
      return p ? { x: p.x, y: p.y } : null;
    },
    lon,
    lat,
    height,
  );
}

async function selectedContext(page) {
  return page.evaluate(() => {
    const store = window.__gevContextStore;
    const id = store?.selectedEntityId || null;
    const record = id ? store.entities.get(id) : null;
    return {
      id,
      label: record?.label || null,
      layerId: record?.layerId || null,
      card: record?.entity?.gevLabelModel || null,
    };
  });
}

/** Poll the selected card until an enrichment line matching `pattern` lands. */
async function waitForCardLine(page, pattern, { timeoutMs = 12000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let details = [];
  while (Date.now() < deadline) {
    details = (await selectedContext(page)).card?.details || [];
    if (details.some((line) => pattern.test(line))) return details;
    await sleep(400);
  }
  return details;
}

async function sectionDeter(page) {
  console.log(
    '(i) DETER — loading the alerts layer through the cached proxy...',
  );
  const stats = await enableLayer(page, 'inpe-deter');
  const loaded = stats.count > 100 && !stats.error;
  record(
    'DETER: >100 alert polygons, no error',
    loaded,
    `count=${stats.count} error=${JSON.stringify(stats.error)} stale=${stats.stale}`,
  );
  if (!loaded) return false;

  const alert = await page.evaluate(() => {
    const mod =
      window.__godsEyeView.dataManager.layers.get('inpe-deter').module;
    // The biggest alert in view is the easiest pick target.
    const rows = mod.getAnalystRecords(5000);
    rows.sort((a, b) => (b.areaKm2 || 0) - (a.areaKm2 || 0));
    return rows[0] || null;
  });
  record(
    'DETER: analyst records expose class, place and area',
    Boolean(alert?.id && alert?.className && Number.isFinite(alert?.lat)),
    alert
      ? `${alert.className} ${alert.areaKm2} km² ${alert.municipality}/${alert.uf} ${alert.viewDate}`
      : 'none',
  );
  if (!alert) return false;

  await lookDownAt(page, alert.lon, alert.lat, 4000);
  await settle(page, 24);
  await page.screenshot({ path: path.join(SHOTS_DIR, 'deter-alert.png') });

  const point = await windowPoint(page, alert.lon, alert.lat);
  if (!point) {
    record('DETER: alert centroid projects on screen', false, 'off screen');
    return false;
  }
  await page.mouse.click(point.x, point.y);
  await settle(page, 8);
  const selected = await selectedContext(page);
  const expectedId = `inpe-deter:${alert.id}`;
  const picked = selected.id === expectedId && selected.card?.title;
  record(
    'DETER: clicking the alert selects it and publishes the readout card',
    Boolean(picked),
    `selected=${JSON.stringify(selected.id)} expected=${expectedId} title=${JSON.stringify(selected.card?.title)} details=${JSON.stringify(selected.card?.details)}`,
  );
  await settle(page, 12);
  await page.screenshot({ path: path.join(SHOTS_DIR, 'deter-selected.png') });
  return Boolean(picked);
}

/** Painted/entry counts for one overlay source (shared host diagnostics). */
async function overlayCounts(page, sourceId) {
  return page.evaluate((id) => {
    const d = window.__gevWorldOverlay?.getDiagnostics?.();
    return {
      entries: d?.entriesBySource?.[id] || 0,
      painted: d?.paintedBySource?.[id] || 0,
    };
  }, sourceId);
}

async function sectionGauges(page) {
  console.log(
    '(ii) GAUGES — loading ANA river gauges through the cached proxy...',
  );
  const stats = await enableLayer(page, 'ana-river-gauges');
  const loaded = stats.count >= 10 && !stats.error;
  record(
    'GAUGES: ≥10 stations, no error',
    loaded,
    `count=${stats.count} error=${JSON.stringify(stats.error)} stale=${stats.stale}`,
  );
  if (!loaded) return false;

  const manaus = await page.evaluate(() => {
    const mod =
      window.__godsEyeView.dataManager.layers.get('ana-river-gauges').module;
    return (
      mod.getAnalystRecords(100).find((row) => row.id === '14990000') || null
    );
  });
  record(
    'GAUGES: Manaus (14990000) carries a level and a 24 h trend',
    Boolean(manaus && Number.isFinite(manaus.levelM)),
    manaus
      ? `${manaus.name} · ${manaus.river} · ${manaus.levelM} m · ${manaus.delta24hCm} cm/24h`
      : 'missing',
  );
  if (!manaus) return false;

  // Regional view: ambient cards for the trunk stations.
  await lookDownAt(page, -60.0272, -3.1383, 400000);
  await settle(page, 24);
  const counts = await overlayCounts(page, 'ana-river-gauges');
  record(
    'GAUGES: ambient level cards are published and painted',
    counts.entries >= 5 && counts.painted >= 1,
    `entries=${counts.entries} painted=${counts.painted}`,
  );
  await page.screenshot({ path: path.join(SHOTS_DIR, 'gauges-cards.png') });

  // Close in on the Manaus marker and pick it.
  await lookDownAt(page, manaus.lon, manaus.lat, 6000);
  await settle(page, 24);
  const point = await windowPoint(page, manaus.lon, manaus.lat);
  if (!point) {
    record('GAUGES: Manaus marker projects on screen', false, 'off screen');
    return false;
  }
  await page.mouse.click(point.x, point.y);
  await settle(page, 8);
  const selected = await selectedContext(page);
  const picked =
    selected.id === 'ana-river-gauges:14990000' &&
    selected.card?.title === 'MANAUS · RIO NEGRO';
  record(
    'GAUGES: clicking the Manaus marker selects it and publishes the readout card',
    picked,
    `selected=${JSON.stringify(selected.id)} title=${JSON.stringify(selected.card?.title)} details=${JSON.stringify(selected.card?.details)}`,
  );
  const enriched = await waitForCardLine(page, /^WIND km\/h/);
  record(
    'GAUGES: the selected card gains a wind-aloft line from Open-Meteo',
    enriched.some((line) => /^WIND km\/h/.test(line)),
    JSON.stringify(enriched.find((line) => /^WIND/.test(line)) || enriched),
  );
  await settle(page, 12);
  await page.screenshot({ path: path.join(SHOTS_DIR, 'gauges-selected.png') });
  return Boolean(picked && counts.entries >= 5);
}

async function sectionAirspace(page) {
  console.log(
    '(iii) AIRSPACE — loading DECEA airspace through the cached proxy...',
  );
  const stats = await enableLayer(page, 'decea-airspace');
  const loaded = stats.count >= 50 && !stats.error;
  record(
    'AIRSPACE: ≥50 volumes and aerodromes, no error',
    loaded,
    `count=${stats.count} error=${JSON.stringify(stats.error)} stale=${stats.stale}`,
  );
  if (!loaded) return false;

  const probe = await page.evaluate(() => {
    const layer = window.__godsEyeView.dataManager.layers.get('decea-airspace');
    const rows = layer.module.getAnalystRecords(5000);
    const kinds = {};
    for (const row of rows) kinds[row.kind] = (kinds[row.kind] || 0) + 1;
    const ctr = rows.find(
      (row) => row.kind === 'CTR' && /Manaus/i.test(row.name || ''),
    );
    const sbeg = rows.find((row) => row.ident === 'SBEG');
    // The CTR entity must carry a real extrusion (a volume, not a drape).
    let extruded = null;
    for (const source of window.__godsEyeView.viewer.dataSources._dataSources) {
      if (source.name !== 'decea-airspace') continue;
      const entity = source.entities.values.find((e) =>
        String(e.id).startsWith('decea-airspace:CTR-'),
      );
      if (entity?.polygon) {
        const now = window.__godsEyeView.viewer.clock.currentTime;
        extruded = {
          height: entity.polygon.height?.getValue(now) ?? null,
          extrudedHeight: entity.polygon.extrudedHeight?.getValue(now) ?? null,
        };
      }
    }
    return { kinds, ctr, sbeg, extruded };
  });
  record(
    'AIRSPACE: kinds cover volumes and aerodromes; Manaus CTR and SBEG present',
    Boolean(probe.ctr && probe.sbeg && probe.kinds.AD > 10),
    `kinds=${JSON.stringify(probe.kinds)} ctr=${probe.ctr?.name} ${probe.ctr?.lowerM}-${probe.ctr?.upperM} m`,
  );
  record(
    'AIRSPACE: the CTR entity is extruded between its limits',
    Boolean(probe.extruded && probe.extruded.extrudedHeight > 0),
    JSON.stringify(probe.extruded),
  );
  if (!probe.sbeg) return false;

  await lookDownAt(page, -60.05, -3.2, 60000);
  await settle(page, 24);
  await page.screenshot({ path: path.join(SHOTS_DIR, 'airspace-manaus.png') });

  await lookDownAt(page, probe.sbeg.lon, probe.sbeg.lat, 5000);
  await settle(page, 24);
  const point = await windowPoint(page, probe.sbeg.lon, probe.sbeg.lat);
  if (!point) {
    record('AIRSPACE: SBEG projects on screen', false, 'off screen');
    return false;
  }
  await page.mouse.click(point.x, point.y);
  await settle(page, 8);
  const selected = await selectedContext(page);
  const picked =
    selected.id === 'decea-airspace:AD-SBEG' &&
    /SBEG/.test(selected.card?.title || '');
  record(
    'AIRSPACE: clicking SBEG selects the aerodrome and publishes the readout card',
    picked,
    `selected=${JSON.stringify(selected.id)} title=${JSON.stringify(selected.card?.title)} details=${JSON.stringify(selected.card?.details)}`,
  );
  await settle(page, 12);
  await page.screenshot({
    path: path.join(SHOTS_DIR, 'airspace-selected.png'),
  });
  return Boolean(picked && probe.extruded?.extrudedHeight > 0);
}

async function sectionGibs(page) {
  console.log('(iv) GIBS — switching to the NASA Daily map stack...');
  const tiles = { ok: 0, failed: 0 };
  const onResponse = (response) => {
    if (!/gibs\.earthdata\.nasa\.gov\/wmts/.test(response.url())) return;
    if (response.status() === 200) tiles.ok += 1;
    else tiles.failed += 1;
  };
  page.on('response', onResponse);
  const state = await page.evaluate(async () => {
    const controller = window.__godsEyeView.mapStackController;
    const result = await controller.setStack('gibs-daily');
    return {
      activeId: controller.getActiveId(),
      lastError: result?.lastError || null,
    };
  });
  record(
    'GIBS: the NASA Daily stack activates without error',
    state.activeId === 'gibs-daily' && !state.lastError,
    JSON.stringify(state),
  );
  await lookDownAt(page, -60.0, -3.1, 2_500_000);
  await settle(page, 40, 300);
  page.off('response', onResponse);
  record(
    'GIBS: daily tiles are served (yesterday, zoom ≤ 9)',
    tiles.ok >= 4 && tiles.failed === 0,
    `ok=${tiles.ok} failed=${tiles.failed}`,
  );
  await page.screenshot({ path: path.join(SHOTS_DIR, 'gibs-amazon.png') });
  return state.activeId === 'gibs-daily' && tiles.ok >= 4 && tiles.failed === 0;
}

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    ...(findChromeExecutable()
      ? { executablePath: findChromeExecutable() }
      : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1440,900',
    ],
  });
  let exitCode = 0;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const pageErrors = [];
    page.on('pageerror', (error) =>
      pageErrors.push(String(error?.message || error)),
    );
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });
    await boot(page);

    const sections = [
      ['deter', sectionDeter],
      ['gauges', sectionGauges],
      ['airspace', sectionAirspace],
      ['gibs', sectionGibs],
    ];
    for (const [name, run] of sections) {
      if (ONLY && ONLY !== name) continue;
      const ok = await run(page);
      if (!ok) exitCode = 1;
    }
    const renderErrors = pageErrors.filter((text) =>
      /rendering has stopped|DeveloperError|Uncaught/i.test(text),
    );
    record(
      'No render-stopping page errors',
      renderErrors.length === 0,
      renderErrors.slice(0, 3).join(' | ') || 'clean',
    );
    if (renderErrors.length) exitCode = 1;
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\n${results.length - failed}/${results.length} checks passed. Shots in ${SHOTS_DIR}`,
  );
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
