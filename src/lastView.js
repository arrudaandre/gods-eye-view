/**
 * Last camera view — "reopen where I left off" for the local operator.
 *
 * Layer enablement has been durable for a long time (`gev:layer-state:v2`,
 * LayerStateCoordinator), but the camera only ever lived in the share-link
 * hash, so every plain `localhost:4173` load flew back to Austin. This module
 * owns the durable pose: pure functions, no Cesium, degrees in and out, so the
 * write path (ShareLinkManager, on the same debounce as the hash) and the
 * startup read (app/controls.js) share one codec and one validation.
 *
 * Precedence is fixed and small: an incoming share link always wins (its
 * author chose that view); otherwise the saved view; otherwise the Austin
 * fly-in. A saved view is NOT share state — the first-run launcher and the
 * local layer preferences behave exactly as on any other plain load.
 */

export const LAST_VIEW_STORAGE_KEY = 'gev:last-view:v1';
const LAST_VIEW_VERSION = 1;
/** Above this the globe is a dot; a saved pose there is a corrupt write. */
const MAX_ALTITUDE_M = 50_000_000;

/**
 * Validate and round a pose. Rounding matches the share-link hash (4 decimal
 * places ≈ 11 m, whole metres, whole degrees) so reopening never drifts the
 * camera by a hair on every save/restore cycle.
 * @param {*} input - `{lat, lon, alt, heading, pitch, roll}` in degrees/metres.
 * @returns {?{lat: number, lon: number, alt: number, heading: number, pitch: number, roll: number}}
 */
export function normalizeLastView(input) {
  if (!input || typeof input !== 'object') return null;
  const lat = Number(input.lat);
  const lon = Number(input.lon);
  const alt = Number(input.alt);
  if (![lat, lon, alt].every(Number.isFinite)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (alt <= 0 || alt > MAX_ALTITUDE_M) return null;
  const angle = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
  const heading = ((Math.round(angle(input.heading, 0)) % 360) + 360) % 360;
  const pitch = Math.max(
    -90,
    Math.min(90, Math.round(angle(input.pitch, -35))),
  );
  // Cesium reports a near-zero roll as 359.99°, which the share hash rounds to
  // 360; wrapping into [-180, 180) keeps that a valid 0 instead of a rejected
  // pose that would silently freeze the store at the previous view.
  const roll =
    ((((Math.round(angle(input.roll, 0)) + 180) % 360) + 360) % 360) - 180;
  return {
    lat: Number(lat.toFixed(4)),
    lon: Number(lon.toFixed(4)),
    alt: Math.round(alt),
    heading,
    pitch,
    roll,
  };
}

/** Stable storage representation (versioned so a future pose shape can migrate). */
export function serializeLastView(view) {
  const normalized = normalizeLastView(view);
  if (!normalized) return null;
  return JSON.stringify({ v: LAST_VIEW_VERSION, ...normalized });
}

/** Parse a stored representation; anything malformed or foreign reads as "no view". */
export function parseLastView(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.v !== LAST_VIEW_VERSION) return null;
    return normalizeLastView(parsed);
  } catch {
    return null;
  }
}

/**
 * `globalThis.localStorage` is a getter that throws in some private modes and
 * under storage-blocking policies, so it is only ever touched behind try.
 */
export function defaultLastViewStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** Read the saved view, or null when absent, blocked or malformed. */
export function readLastView(storage = defaultLastViewStorage()) {
  try {
    return parseLastView(storage?.getItem?.(LAST_VIEW_STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * Persist a pose. Skips the write when nothing changed (camera.changed fires
 * on every settle, and some browsers flush localStorage to disk per write).
 * @returns {boolean} true when storage now holds this view.
 */
export function writeLastView(storage, view) {
  const serialized = serializeLastView(view);
  if (!serialized || !storage) return false;
  try {
    if (storage.getItem?.(LAST_VIEW_STORAGE_KEY) === serialized) return true;
    storage.setItem?.(LAST_VIEW_STORAGE_KEY, serialized);
    return true;
  } catch {
    return false; // unavailable or quota-limited — the session still works
  }
}

/**
 * Which camera opens the session. Kept as a pure decision so the startup
 * wiring in app/controls.js stays a three-way switch with a test.
 * @param {{hasShareState?: boolean, lastView?: ?object}} input
 * @returns {'share'|'last-view'|'default'}
 */
export function chooseStartupCamera({
  hasShareState = false,
  lastView = null,
}) {
  if (hasShareState) return 'share';
  if (normalizeLastView(lastView)) return 'last-view';
  return 'default';
}
