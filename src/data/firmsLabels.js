/**
 * @module firmsLabels
 * @description FIRMS-specific presentation formatting retained after the
 * dedicated card canvas moved into the shared world-overlay host.
 */

/** Shipped ambient FIRMS card ceiling. Selected fires bypass this cohort. */
export const FIRMS_AMBIENT_COHORT_LIMIT = 18;
export const FIRMS_OVERLAY_SOURCE_ID = 'firms';

/**
 * Refetch-stable identity for one fire detection, including its source feed.
 * The prefix is the record's `feedId` (stamped by adaptFirmsRecords from the
 * layer namespace) so a second fires instance — INPE, which also ingests the
 * VIIRS satellites — never shares a context-store id with NASA FIRMS for the
 * same physical detection. Records without a feedId read as FIRMS.
 */
export function fireDetectionKey(fire) {
  const lat = Number.isFinite(fire?.lat) ? fire.lat.toFixed(4) : 'x';
  const lon = Number.isFinite(fire?.lon) ? fire.lon.toFixed(4) : 'x';
  const acq =
    Number.isFinite(fire?.acqMs) && fire.acqMs > 0 ? String(fire.acqMs) : '0';
  const source =
    satelliteShortName(fire?.satellite) ||
    String(fire?.sensor || '')
      .trim()
      .toUpperCase() ||
    'x';
  const feed =
    typeof fire?.feedId === 'string' && fire.feedId
      ? fire.feedId
      : FIRMS_OVERLAY_SOURCE_ID;
  return `${feed}:${lat}:${lon}:${acq}:${source}`;
}

/** Severity accent palette — matches the FIRMS glow-sprite color stops. */
const ACCENT_RGB = Object.freeze({
  red: '224, 82, 82',
  orange: '240, 178, 62',
  yellow: '244, 227, 108',
});

/**
 * Severity stop name → "r, g, b" accent string (defaults to yellow).
 * @param {string} stopName - 'red' | 'orange' | 'yellow'.
 * @returns {string}
 */
export function accentForSeverity(stopName) {
  return ACCENT_RGB[stopName] || ACCENT_RGB.yellow;
}

/** Raw FIRMS satellite code → short display name (N = Suomi NPP). */
export function satelliteShortName(satellite) {
  const s = String(satellite || '')
    .trim()
    .toUpperCase();
  if (s === 'N20' || s === 'NOAA-20') return 'N20';
  if (s === 'N21' || s === 'NOAA-21') return 'N21';
  if (s === 'N' || s === 'NPP' || s === 'SUOMI NPP') return 'SNPP';
  // INPE Programa Queimadas spellings (daily CSV, 2026-09-18): NPP-375/NPP-375D
  // (Suomi NPP), AQUA_M-T/AQUA_M-M and TERRA_M-T/TERRA_M-M (MODIS afternoon/
  // morning passes), GOES-19, METOP-B/C. The generic 6-char slice below would
  // print "GOES-1" / "TERRA_" / "METOP-", so these get explicit short names.
  if (/^NPP-375D?$/.test(s)) return 'SNPP';
  if (/^AQUA_M-[TM]$/.test(s)) return 'AQUA';
  if (/^TERRA_M-[TM]$/.test(s)) return 'TERRA';
  const goes = /^GOES-(\d{1,2})$/.exec(s);
  if (goes) return `G${goes[1]}`;
  const metop = /^METOP-([A-C])$/.exec(s);
  if (metop) return `MET-${metop[1]}`;
  return s ? s.slice(0, 6) : '';
}
