import { createGeoFeatureLayer } from './core.js';
import {
  airspaceAnalystRecord,
  airspaceCardCopy,
  airspaceKind,
} from '../../data/airspaceModel.js';

export const AIRSPACE_LAYER_ID = 'decea-airspace';
export const AIRSPACE_UPDATE_INTERVAL_MS = 6 * 3600_000;
/** Aerodrome labels stay readable to here; beyond it the dots suffice. */
const AERODROME_LABEL_MAX_DISTANCE_M = 150_000;

/**
 * Volumes extrude between their limits (SFC-based ones follow the ground);
 * aerodromes and heliports are clamped points with an ICAO label.
 */
export function airspaceFeatureStyle(feature) {
  const kind = airspaceKind(feature?.kind);
  if (feature.kind === 'AD' || feature.kind === 'HP') {
    const isHeliport = feature.kind === 'HP';
    return {
      marker: {
        color: kind.color,
        pixelSize: isHeliport ? 6 : feature.category === 'INTL' ? 10 : 8,
        alpha: 0.95,
        clampToGround: true,
      },
      label: {
        text: feature.icao || feature.name || '',
        color: kind.color,
        maxDistanceM: isHeliport
          ? AERODROME_LABEL_MAX_DISTANCE_M / 3
          : AERODROME_LABEL_MAX_DISTANCE_M,
      },
    };
  }
  return {
    fill: kind.color,
    fillAlpha: kind.alpha,
    outline: kind.color,
    outlineAlpha: 0.9,
    heightM: feature.lowerM,
    extrudedHeightM: feature.upperM,
    lowerReference: feature.lowerGround ? 'ground' : 'msl',
  };
}

/** Compose the DECEA airspace layer over an `/api/airspace` feed. */
export function createAirspaceLayer({ feed, services, ...options } = {}) {
  return createGeoFeatureLayer({
    id: AIRSPACE_LAYER_ID,
    name: 'Airspace (DECEA)',
    icon: '⬡',
    source: 'DECEA GEOAISWEB',
    contextSource: 'DECEA / ICA GeoAISWEB',
    updateInterval: AIRSPACE_UPDATE_INTERVAL_MS,
    feed,
    services,
    present: {
      style: airspaceFeatureStyle,
      describe: airspaceCardCopy,
      contextLabel: (feature) => airspaceCardCopy(feature).title,
      contextProperties: (feature) => ({
        kind: feature.kind,
        kindLabel: airspaceKind(feature.kind).label,
        ident: feature.ident || feature.icao || null,
        name: feature.name,
        lower: feature.lowerLabel ?? null,
        upper: feature.upperLabel ?? null,
        lowerM: feature.lowerM ?? null,
        upperM: feature.upperM ?? null,
        fir: feature.fir ?? null,
        effective: feature.effective ?? null,
        city: feature.city ?? null,
        use: feature.use ?? null,
      }),
      analystRecord: airspaceAnalystRecord,
      // A volume is framed from afar; an aerodrome like a ground feature.
      focusKind: 'volume',
      focusKindFor: (feature) =>
        feature.kind === 'AD' || feature.kind === 'HP' ? 'feature' : 'volume',
      anchorHeightM: (feature) =>
        Number.isFinite(feature.upperM) ? Math.min(feature.upperM, 20_000) : 0,
    },
    ...options,
  });
}
