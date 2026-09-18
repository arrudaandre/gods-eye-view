/**
 * DECEA GeoAISWEB airspace — pure helpers shared by the `/api/airspace`
 * proxy and the airspace layer. No fetch, no DOM, no Cesium.
 *
 * GeoAISWEB (https://geoaisweb.decea.mil.br/) is the Brazilian AIS
 * (aeronautical information) GeoServer: controlled airspace (CTR, TMA, ATZ),
 * the special-use areas (P prohibited, R restricted, D danger) and every
 * registered aerodrome and heliport, each with the AIRAC effective date.
 * Vertical limits come in two spellings depending on the layer family, so
 * the normalizer below is the only place that reads them.
 */

export const AIRSPACE_WFS_BASE =
  'https://geoaisweb.decea.mil.br/geoserver/ICA/ows';
export const AIRSPACE_DEFAULT_BBOX = Object.freeze({
  // Amazonas state with a margin: Manaus TMA/CTR, the SBAZ FIR interior,
  // Roraima's approaches and the Solimões restricted areas.
  west: -73.9,
  south: -9.9,
  east: -56.0,
  north: 2.3,
});
export const AIRSPACE_MAX_FEATURES = 3000;
const FT_TO_M = 0.3048;

/**
 * The layers the proxy walks, in draw order (volumes first, points last).
 * `family` picks the attribute spelling; `kind` is the presentation key.
 */
export const AIRSPACE_LAYERS = Object.freeze([
  Object.freeze({ typeName: 'ICA:TMA', kind: 'TMA', family: 'airspace' }),
  Object.freeze({ typeName: 'ICA:CTR', kind: 'CTR', family: 'airspace' }),
  Object.freeze({ typeName: 'ICA:ATZ', kind: 'ATZ', family: 'airspace' }),
  Object.freeze({ typeName: 'ICA:eac_p', kind: 'P', family: 'eac' }),
  Object.freeze({ typeName: 'ICA:eac_r', kind: 'R', family: 'eac' }),
  Object.freeze({ typeName: 'ICA:eac_d', kind: 'D', family: 'eac' }),
  Object.freeze({ typeName: 'ICA:airport', kind: 'AD', family: 'aerodrome' }),
  Object.freeze({ typeName: 'ICA:heliport', kind: 'HP', family: 'aerodrome' }),
]);

/**
 * Presentation per kind: label, colour, fill alpha. Controlled airspace is
 * stacked (Manaus has four TMA slabs over its CTR) and the camera usually
 * sits INSIDE it, so those fills stay faint; special-use areas are the ones
 * a drone pilot must see, so they are louder.
 */
export const AIRSPACE_KINDS = Object.freeze({
  TMA: Object.freeze({
    label: 'Terminal area',
    color: '#4fa8ff',
    alpha: 0.05,
    rank: 1,
  }),
  CTR: Object.freeze({
    label: 'Control zone',
    color: '#7fd4ff',
    alpha: 0.1,
    rank: 2,
  }),
  ATZ: Object.freeze({
    label: 'Aerodrome traffic zone',
    color: '#c48bff',
    alpha: 0.14,
    rank: 3,
  }),
  P: Object.freeze({
    label: 'Prohibited area',
    color: '#ff3b3b',
    alpha: 0.28,
    rank: 6,
  }),
  R: Object.freeze({
    label: 'Restricted area',
    color: '#ff8c2e',
    alpha: 0.24,
    rank: 5,
  }),
  D: Object.freeze({
    label: 'Danger area',
    color: '#ffd23b',
    alpha: 0.2,
    rank: 4,
  }),
  AD: Object.freeze({
    label: 'Aerodrome',
    color: '#ffffff',
    alpha: 1,
    rank: 0,
  }),
  HP: Object.freeze({ label: 'Heliport', color: '#7fe0c4', alpha: 1, rank: 0 }),
});

export function airspaceKind(kind) {
  return AIRSPACE_KINDS[kind] || AIRSPACE_KINDS.TMA;
}

/**
 * Bounding box from `AIRSPACE_BBOX` ("west,south,east,north" in degrees).
 * Anything malformed or inside-out falls back to the Amazonas default.
 */
export function parseBbox(value) {
  const parts = String(value ?? '')
    .split(',')
    .map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)))
    return { ...AIRSPACE_DEFAULT_BBOX };
  const [west, south, east, north] = parts;
  if (
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north
  )
    return { ...AIRSPACE_DEFAULT_BBOX };
  return { west, south, east, north };
}

/** GetFeature URL for one layer clipped to the bbox (WFS 1.0.0 = lon,lat). */
export function airspaceWfsUrl(typeName, bbox, base = AIRSPACE_WFS_BASE) {
  if (!/^ICA:[A-Za-z_]+$/.test(String(typeName)))
    throw new TypeError('A GeoAISWEB type name is required');
  const params = new URLSearchParams({
    service: 'WFS',
    version: '1.0.0',
    request: 'GetFeature',
    typeName,
    outputFormat: 'application/json',
    maxFeatures: String(AIRSPACE_MAX_FEATURES),
    bbox: `${bbox.west},${bbox.south},${bbox.east},${bbox.north},EPSG:4326`,
  });
  return `${base}?${params}`;
}

function cleanText(value, max = 80) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, max) : null;
}

/**
 * One vertical limit → metres plus the label pilots read.
 * `unit` is FT or FL; `reference` is SFC, GND, MSL, STD or AGL. FL is a
 * pressure altitude, taken as MSL at ISA (close enough to draw a volume).
 * SFC/GND (or a zero-foot AGL) means "the ground under the polygon".
 */
export function verticalLimit(value, unit, reference) {
  const ref = String(reference || '')
    .trim()
    .toUpperCase();
  const u = String(unit || '')
    .trim()
    .toUpperCase();
  const n = Number(value);
  // GeoAISWEB writes "2000 FT, ref SFC" for an upper limit measured from the
  // surface (Manaus CTR 1); only a zero or blank value means the surface
  // itself. Both are ground-relative.
  if ((ref === 'SFC' || ref === 'GND') && !(Number.isFinite(n) && n > 0)) {
    return { metres: 0, label: 'SFC', ground: true };
  }
  if (!Number.isFinite(n)) return null;
  if (u === 'FL') {
    return {
      metres: Math.round(n * 100 * FT_TO_M),
      label: `FL${String(Math.round(n)).padStart(3, '0')}`,
      ground: false,
    };
  }
  const feet = u === 'M' ? n / FT_TO_M : n;
  const metres = Math.round(feet * FT_TO_M);
  if (ref === 'AGL' || ref === 'GND' || ref === 'SFC') {
    return { metres, label: `${Math.round(feet)} ft AGL`, ground: true };
  }
  if (metres === 0) return { metres: 0, label: 'SFC', ground: true };
  return {
    metres,
    label:
      `${Math.round(feet)} ft${ref === 'MSL' ? '' : ` ${ref}`.replace(/ $/, '')}`.trim(),
    ground: false,
  };
}

function readLimits(family, props) {
  if (family === 'eac') {
    // eac_*: upperlimit/lowerlimit numeric, uom_ulimit/uom_llimit units.
    return {
      lower: verticalLimit(
        props.lowerlimit,
        props.uom_llimit,
        Number(props.lowerlimit) === 0 ? 'SFC' : 'MSL',
      ),
      upper: verticalLimit(props.upperlimit, props.uom_ulimit, 'MSL'),
    };
  }
  // CTR/TMA/ATZ: `upperlimit` numeric in `uplimituni`, ref `codedistve`;
  // `lowerlimi1` numeric in `lowerlimit` (yes, the unit), ref `codedistv1`.
  return {
    lower: verticalLimit(props.lowerlimi1, props.lowerlimit, props.codedistv1),
    upper: verticalLimit(props.upperlimit, props.uplimituni, props.codedistve),
  };
}

function isLonLat(pair) {
  return (
    Array.isArray(pair) &&
    Number.isFinite(pair[0]) &&
    Number.isFinite(pair[1]) &&
    Math.abs(pair[0]) <= 180 &&
    Math.abs(pair[1]) <= 90
  );
}

function ringPoints(ring) {
  if (!Array.isArray(ring)) return null;
  const points = [];
  for (const pair of ring) {
    if (!isLonLat(pair)) continue;
    const last = points[points.length - 1];
    if (last && last[0] === pair[0] && last[1] === pair[1]) continue;
    points.push([pair[0], pair[1]]);
  }
  if (points.length > 1) {
    const [f, l] = [points[0], points[points.length - 1]];
    if (f[0] === l[0] && f[1] === l[1]) points.pop();
  }
  return points.length >= 3 ? points : null;
}

function polygonsOf(geometry) {
  const raw =
    geometry?.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  const polygons = [];
  for (const rings of Array.isArray(raw) ? raw : []) {
    if (!Array.isArray(rings)) continue;
    const outer = ringPoints(rings[0]);
    if (!outer) continue;
    const clean = [outer];
    for (let i = 1; i < rings.length; i++) {
      const hole = ringPoints(rings[i]);
      if (hole) clean.push(hole);
    }
    polygons.push(clean);
  }
  return polygons;
}

function centroidOf(polygons) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const rings of polygons)
    for (const [x, y] of rings[0]) {
      sx += x;
      sy += y;
      n++;
    }
  return n ? [sx / n, sy / n] : null;
}

function pointOf(geometry) {
  if (geometry?.type === 'Point' && isLonLat(geometry.coordinates))
    return geometry.coordinates;
  if (
    geometry?.type === 'MultiPoint' &&
    Array.isArray(geometry.coordinates) &&
    isLonLat(geometry.coordinates[0])
  )
    return geometry.coordinates[0];
  return null;
}

/**
 * Compact one GeoAISWEB feature. Volumes need a drawable polygon and both
 * limits; aerodromes need a point. Null otherwise.
 */
export function normalizeAirspaceFeature(layer, feature, index = 0) {
  const props = feature?.properties || {};
  if (layer.family === 'aerodrome') {
    const coords =
      pointOf(feature?.geometry) ||
      (Number.isFinite(Number(props.longitude_dec)) &&
      Number.isFinite(Number(props.latitude_dec))
        ? [Number(props.longitude_dec), Number(props.latitude_dec)]
        : null);
    if (!coords) return null;
    const icao = cleanText(props.localidade_id, 8);
    return {
      id: `${layer.kind}-${icao || props.gid || index}`,
      kind: layer.kind,
      icao,
      name: cleanText(props.nome, 80),
      city: cleanText(props.cidade, 60),
      uf: cleanText(props.uf, 4),
      use: cleanText(props.tipo_util, 8), // PUB / PRIV
      category: cleanText(props.cat_sigla, 8), // INTL / NAC
      operation: cleanText(props.opr, 24), // VFR IFR / VFR DIURNA
      elevationM:
        String(props.elev_uom || '').toUpperCase() === 'FT'
          ? Math.round(Number(props.elevacao) * FT_TO_M)
          : Number.isFinite(Number(props.elevacao))
            ? Math.round(Number(props.elevacao))
            : null,
      effective: cleanText(props.efetivacao, 12),
      lon: Number(coords[0].toFixed(5)),
      lat: Number(coords[1].toFixed(5)),
      polygons: [],
    };
  }
  const polygons = polygonsOf(feature?.geometry);
  if (!polygons.length) return null;
  const { lower, upper } = readLimits(layer.family, props);
  if (!lower || !upper || upper.metres <= lower.metres) return null;
  const centroid = centroidOf(polygons);
  if (!centroid) return null;
  const isEac = layer.family === 'eac';
  const ident = cleanText(isEac ? props.id : props.ident, 16);
  const name = cleanText(isEac ? props.nome : props.nam, 60);
  return {
    id: `${layer.kind}-${ident || props.gid || index}`,
    kind: layer.kind,
    ident,
    name,
    fir: cleanText(isEac ? props.fir : props.relatedfir, 8),
    lowerM: lower.metres,
    upperM: upper.metres,
    lowerLabel: lower.label,
    upperLabel: upper.label,
    lowerGround: lower.ground,
    effective: cleanText(isEac ? props.efetivacao : props.effectived, 12),
    remark: cleanText(isEac ? props.observacao : props.txtrmk_loc, 160),
    lon: Number(centroid[0].toFixed(5)),
    lat: Number(centroid[1].toFixed(5)),
    polygons,
  };
}

/** Normalize one layer's GetFeature response; null when it is not GeoJSON. */
export function normalizeAirspaceCollection(layer, payload) {
  if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features))
    return null;
  const out = [];
  payload.features.forEach((feature, index) => {
    const normalized = normalizeAirspaceFeature(layer, feature, index);
    if (normalized) out.push(normalized);
  });
  return out;
}

/** Title and detail lines for the selected-feature readout. */
export function airspaceCardCopy(feature) {
  const kind = airspaceKind(feature?.kind);
  if (feature?.kind === 'AD' || feature?.kind === 'HP') {
    const title = [feature.icao, feature.name]
      .filter(Boolean)
      .join(' · ')
      .toUpperCase();
    const details = [];
    const first = [
      kind.label,
      feature.use === 'PRIV'
        ? 'private'
        : feature.use === 'PUB'
          ? 'public'
          : null,
      feature.category,
    ]
      .filter(Boolean)
      .join(' · ');
    if (first) details.push(first);
    const second = [
      [feature.city, feature.uf].filter(Boolean).join(', '),
      Number.isFinite(feature.elevationM) ? `${feature.elevationM} m` : null,
      feature.operation,
    ]
      .filter(Boolean)
      .join(' · ');
    if (second) details.push(second);
    return {
      title: title || kind.label.toUpperCase(),
      details,
      accent: kind.color,
    };
  }
  const title = [feature?.ident, feature?.name]
    .filter(Boolean)
    .join(' · ')
    .toUpperCase();
  const details = [
    `${kind.label} · ${feature?.lowerLabel} – ${feature?.upperLabel}`,
  ];
  const where = [
    feature?.fir ? `FIR ${feature.fir}` : null,
    feature?.effective ? `AIRAC ${feature.effective.replace(/Z$/, '')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (where) details.push(where);
  if (feature?.remark) details.push(feature.remark);
  return {
    title: title || kind.label.toUpperCase(),
    details,
    accent: kind.color,
  };
}

/** Plain record for the analyst engine. */
export function airspaceAnalystRecord(feature, index) {
  return {
    index,
    id: feature.id,
    kind: feature.kind,
    kindLabel: airspaceKind(feature.kind).label,
    ident: feature.ident || feature.icao || null,
    name: feature.name,
    lowerM: feature.lowerM ?? null,
    upperM: feature.upperM ?? null,
    lat: feature.lat,
    lon: feature.lon,
  };
}
