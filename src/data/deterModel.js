/**
 * INPE DETER (Amazon biome deforestation and degradation alerts) — pure
 * helpers shared by the server proxy and the browser layer. No Cesium, no
 * fetch, no DOM, so `node --test` can exercise the whole normalization path.
 *
 * Upstream is the TerraBrasilis WFS (GeoServer) behind
 * https://terrabrasilis.dpi.inpe.br/. One alert is one MultiPolygon with the
 * detection class, the acquisition date (`view_date`), the satellite/sensor
 * pair, the municipality and the area inside that municipality in km².
 */

export const DETER_WFS_BASE =
  'https://terrabrasilis.dpi.inpe.br/geoserver/deter-amz/deter_amz/ows';
export const DETER_TYPE_NAME = 'deter-amz:deter_amz';
export const DETER_DEFAULT_DAYS = 30;
export const DETER_MAX_DAYS = 120;
const DAY_MS = 24 * 3600_000;

/**
 * DETER classes as INPE spells them, with the label the cards use and a
 * colour ramp that keeps clear-cut and mining the loudest. `rank` orders the
 * classes when one feature has to stand for several (never happens upstream,
 * kept for the analyst summary).
 */
export const DETER_CLASSES = Object.freeze({
  DESMATAMENTO_CR: Object.freeze({
    label: 'Clear-cut',
    color: '#ff3b3b',
    rank: 6,
  }),
  DESMATAMENTO_VEG: Object.freeze({
    label: 'Clear-cut (vegetation left)',
    color: '#ff6a3b',
    rank: 5,
  }),
  MINERACAO: Object.freeze({ label: 'Mining', color: '#d14bff', rank: 5 }),
  CICATRIZ_DE_QUEIMADA: Object.freeze({
    label: 'Burn scar',
    color: '#ffb02e',
    rank: 3,
  }),
  DEGRADACAO: Object.freeze({
    label: 'Degradation',
    color: '#ffe066',
    rank: 2,
  }),
  CS_DESORDENADO: Object.freeze({
    label: 'Selective logging',
    color: '#7fd4ff',
    rank: 1,
  }),
  CS_GEOMETRICO: Object.freeze({
    label: 'Selective logging (geometric)',
    color: '#4fa8ff',
    rank: 1,
  }),
});
export const DETER_UNKNOWN_CLASS = Object.freeze({
  label: 'Alert',
  color: '#c0c0c0',
  rank: 0,
});

/** Class descriptor for an INPE class name; unknown spellings get a grey. */
export function deterClass(classname) {
  const key = String(classname || '')
    .trim()
    .toUpperCase();
  return DETER_CLASSES[key] || DETER_UNKNOWN_CLASS;
}

/**
 * Trailing-window length from the `DETER_DAYS` environment variable. Bounded
 * so a typo cannot ask the public WFS for years of polygons.
 */
export function deterDaysFromEnv(value) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(n)) return DETER_DEFAULT_DAYS;
  return Math.max(1, Math.min(DETER_MAX_DAYS, n));
}

/** ISO date (UTC) `days` before `nowMs`, the lower bound of the WFS filter. */
export function deterSinceDate(nowMs, days) {
  const since = new Date(nowMs - Math.max(0, days) * DAY_MS);
  return since.toISOString().slice(0, 10);
}

/**
 * Full GetFeature URL. GeoServer (Tomcat) rejects a raw `>` or `'` in the
 * query string with 400, so the CQL filter goes through URLSearchParams.
 */
export function deterWfsUrl({ since, base = DETER_WFS_BASE } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(since || '')))
    throw new TypeError('A YYYY-MM-DD lower bound is required');
  const params = new URLSearchParams({
    service: 'WFS',
    version: '1.0.0',
    request: 'GetFeature',
    typeName: DETER_TYPE_NAME,
    outputFormat: 'application/json',
    CQL_FILTER: `view_date>='${since}'`,
  });
  return `${base}?${params}`;
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundOrNull(value, decimals) {
  const n = finiteOrNull(value);
  return n === null ? null : Number(n.toFixed(decimals));
}

function cleanText(value, max = 80) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, max) : null;
}

function isLonLat(pair) {
  return (
    Array.isArray(pair) &&
    Number.isFinite(pair[0]) &&
    Number.isFinite(pair[1]) &&
    pair[0] >= -180 &&
    pair[0] <= 180 &&
    pair[1] >= -90 &&
    pair[1] <= 90
  );
}

/** Planar shoelace area of a ring in square degrees (sign carries winding). */
function ringArea(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/**
 * One ring as distinct [lon, lat] vertices, or null when it cannot enclose
 * anything. DETER rings repeat vertices back to back and sometimes collapse
 * to a line; Cesium's ground-clamping code takes the centre of such a ring
 * and dies on the NaN ("cartesian has a NaN component"), so degenerate rings
 * are dropped here, once, where a unit test can see them.
 */
export function cleanRing(ring) {
  if (!Array.isArray(ring)) return null;
  const points = [];
  for (const pair of ring) {
    if (!isLonLat(pair)) continue;
    const last = points[points.length - 1];
    if (last && last[0] === pair[0] && last[1] === pair[1]) continue;
    points.push([pair[0], pair[1]]);
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length > 1 && first[0] === last[0] && first[1] === last[1])
    points.pop();
  if (points.length < 3) return null;
  if (Math.abs(ringArea(points)) < 1e-14) return null;
  return points;
}

/**
 * Rings of a Polygon/MultiPolygon as arrays of polygons, each an array of
 * rings, each a list of [lon, lat]. Invalid rings are dropped; a polygon with
 * no valid outer ring is dropped too.
 */
export function polygonsOf(geometry) {
  if (!geometry) return [];
  const raw =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  if (!Array.isArray(raw)) return [];
  const polygons = [];
  for (const rings of raw) {
    if (!Array.isArray(rings)) continue;
    // The first ring is the outer boundary; without it the holes mean nothing.
    const outer = cleanRing(rings[0]);
    if (!outer) continue;
    const clean = [outer];
    for (let i = 1; i < rings.length; i++) {
      const hole = cleanRing(rings[i]);
      if (hole) clean.push(hole);
    }
    polygons.push(clean);
  }
  return polygons;
}

/**
 * Area-weighted centroid of the outer rings (planar shoelace on degrees —
 * the alerts are tens of hectares, so the projection error is negligible).
 * Falls back to a vertex average for degenerate rings.
 * @returns {[number, number]|null} [lon, lat]
 */
export function polygonsCentroid(polygons) {
  let sumX = 0;
  let sumY = 0;
  let sumA = 0;
  let vx = 0;
  let vy = 0;
  let vn = 0;
  for (const rings of polygons) {
    const outer = rings[0];
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < outer.length; i++) {
      const [x0, y0] = outer[i];
      const [x1, y1] = outer[(i + 1) % outer.length];
      const cross = x0 * y1 - x1 * y0;
      a += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
      vx += x0;
      vy += y0;
      vn++;
    }
    if (Math.abs(a) > 1e-12) {
      const area = Math.abs(a) / 2;
      sumX += (cx / (3 * a)) * area;
      sumY += (cy / (3 * a)) * area;
      sumA += area;
    }
  }
  if (sumA > 0) return [sumX / sumA, sumY / sumA];
  if (vn > 0) return [vx / vn, vy / vn];
  return null;
}

/**
 * Compact one WFS feature into what the layer needs. Returns null for a
 * feature with no drawable geometry or no acquisition date.
 */
export function normalizeDeterFeature(feature, index = 0) {
  const props = feature?.properties || {};
  const polygons = polygonsOf(feature?.geometry);
  if (!polygons.length) return null;
  const viewDate = cleanText(props.view_date, 10);
  if (!viewDate || !/^\d{4}-\d{2}-\d{2}$/.test(viewDate)) return null;
  const centroid = polygonsCentroid(polygons);
  if (!centroid) return null;
  const id = cleanText(props.gid ?? feature?.id, 40) || `deter-${index}`;
  return {
    id,
    classname: cleanText(props.classname, 40) || 'UNKNOWN',
    viewDate,
    satellite: cleanText(props.satellite, 32),
    sensor: cleanText(props.sensor, 32),
    municipality: cleanText(props.municipality, 80),
    uf: cleanText(props.uf, 4),
    uc: cleanText(props.uc, 120),
    // areamunkm is the alert's area inside the municipality; DETER splits
    // alerts on municipal borders, so for one row it is the alert's area.
    areaKm2: roundOrNull(props.areamunkm, 4),
    ucAreaKm2: roundOrNull(props.areauckm, 4),
    publishMonth: cleanText(props.publish_month, 10),
    lon: Number(centroid[0].toFixed(5)),
    lat: Number(centroid[1].toFixed(5)),
    polygons,
  };
}

/**
 * Normalize a whole GetFeature response. Null when the payload is not a
 * FeatureCollection (GeoServer answers an XML ServiceException with 200 for
 * a bad filter, and that must not become an empty-but-fresh cache).
 */
export function normalizeDeterCollection(payload) {
  if (!payload || payload.type !== 'FeatureCollection') return null;
  if (!Array.isArray(payload.features)) return null;
  const features = [];
  payload.features.forEach((feature, index) => {
    const normalized = normalizeDeterFeature(feature, index);
    if (normalized) features.push(normalized);
  });
  return features;
}

/** Keep only alerts acquired on or after `since` (YYYY-MM-DD). */
export function filterDeterSince(features, since) {
  if (!since) return features;
  return features.filter((feature) => feature.viewDate >= since);
}

/** Area copy: "0.42 km²" or "8.1 ha" below a tenth of a square kilometre. */
export function formatDeterArea(areaKm2) {
  if (!Number.isFinite(areaKm2) || areaKm2 <= 0) return null;
  if (areaKm2 < 0.1) return `${(areaKm2 * 100).toFixed(1)} ha`;
  return `${areaKm2.toFixed(2)} km²`;
}

/** Title and detail lines for the selected-alert readout card. */
export function deterCardCopy(feature) {
  const cls = deterClass(feature?.classname);
  const area = formatDeterArea(feature?.areaKm2);
  const title = [cls.label.toUpperCase(), area].filter(Boolean).join(' · ');
  const where = [feature?.municipality, feature?.uf].filter(Boolean).join(', ');
  const details = [];
  const first = [where, feature?.viewDate].filter(Boolean).join(' · ');
  if (first) details.push(first);
  const sensor = [feature?.satellite, feature?.sensor]
    .filter(Boolean)
    .join(' ');
  if (feature?.uc) details.push(`UC ${feature.uc}`);
  if (sensor) details.push(sensor);
  return { title, details, accent: cls.color };
}

/** Plain record for the analyst engine (numeric/text fields, no geometry). */
export function deterAnalystRecord(feature, index) {
  return {
    index,
    id: feature.id,
    classname: feature.classname,
    className: deterClass(feature.classname).label,
    viewDate: feature.viewDate,
    municipality: feature.municipality,
    uf: feature.uf,
    areaKm2: feature.areaKm2,
    satellite: feature.satellite,
    lat: feature.lat,
    lon: feature.lon,
  };
}
