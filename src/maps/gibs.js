/**
 * NASA GIBS (Global Imagery Browse Services) daily true-colour imagery —
 * pure helpers for the "NASA Daily" map stack. No Cesium here so the date
 * policy and URL grammar can be unit-tested.
 *
 * GIBS serves each day's VIIRS corrected-reflectance mosaic as a WMTS layer
 * keyed by date, keyless, public domain, CORS `*`. The Web Mercator matrix
 * set for the 250 m products stops at zoom 9 (a zoom-10 request is a 400).
 */

export const GIBS_WMTS_BASE =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
export const GIBS_TRUE_COLOR_LAYER =
  'VIIRS_SNPP_CorrectedReflectance_TrueColor';
export const GIBS_TILE_MATRIX_SET = 'GoogleMapsCompatible_Level9';
export const GIBS_MAXIMUM_LEVEL = 9;
export const GIBS_ATTRIBUTION_HTML =
  'Daily imagery: <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA GIBS</a> / Worldview (VIIRS SNPP corrected reflectance), public domain';
const DAY_MS = 24 * 3600_000;

/**
 * The imagery day for "now": yesterday in UTC. GIBS publishes today's
 * mosaic in strips as orbits come in, so the last COMPLETE day is the one
 * that shows the whole globe without a black seam; late-evening UTC would
 * already show most of today, but a partial day reads as broken.
 */
export function gibsImageryDate(nowMs = Date.now()) {
  return new Date(nowMs - DAY_MS).toISOString().slice(0, 10);
}

/** RESTful WMTS template Cesium fills in ({TileMatrix}/{TileRow}/{TileCol}). */
export function gibsTileTemplate({
  layer = GIBS_TRUE_COLOR_LAYER,
  date,
  base = GIBS_WMTS_BASE,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')))
    throw new TypeError('A YYYY-MM-DD imagery date is required');
  if (!/^[A-Za-z0-9_]+$/.test(String(layer || '')))
    throw new TypeError('A GIBS layer identifier is required');
  return `${base}/${layer}/default/${date}/${GIBS_TILE_MATRIX_SET}/{TileMatrix}/{TileRow}/{TileCol}.jpg`;
}
