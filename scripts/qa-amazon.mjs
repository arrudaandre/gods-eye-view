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
 *   (i) DETER — `inpe-deter` loads hundreds of alert polygons with no error;
 *       a click on one selects exactly that alert (context id, readout card
 *       title) and hands the camera to the UI focus policy.
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

    const sections = [['deter', sectionDeter]];
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
