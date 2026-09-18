import { ambientCardEntry, createGeoFeatureLayer } from './core.js';
import { gaugeAnalystRecord, gaugeCardCopy } from '../../data/anaTelemetry.js';

export const GAUGES_LAYER_ID = 'ana-river-gauges';
export const GAUGES_UPDATE_INTERVAL_MS = 15 * 60_000;

/** Snapshot stations → geo-features (a point each, no polygons). */
export function gaugeFeatures(payload) {
  const stations = Array.isArray(payload?.stations) ? payload.stations : null;
  if (!stations) return null;
  return stations
    .filter(
      (station) =>
        /^\d{8}$/.test(String(station?.code || '')) &&
        Number.isFinite(station?.lat) &&
        Number.isFinite(station?.lon),
    )
    .map((station) => ({
      id: String(station.code),
      code: String(station.code),
      name: station.name || station.code,
      river: station.river || null,
      lat: station.lat,
      lon: station.lon,
      ok: station.ok !== false,
      summary: station.summary || null,
      polygons: [],
    }));
}

/** A ground-clamped marker whose colour follows the 24 h trend. */
export function gaugeFeatureStyle(feature) {
  const { accent } = gaugeCardCopy(feature);
  return {
    marker: {
      color: accent,
      pixelSize: feature.summary ? 9 : 6,
      alpha: feature.summary ? 1 : 0.6,
      clampToGround: true,
    },
  };
}

/** Compose the river-gauge layer over an `/api/ana-gauges` feed. */
export function createRiverGaugesLayer({ feed, services, ...options } = {}) {
  return createGeoFeatureLayer({
    id: GAUGES_LAYER_ID,
    name: 'Amazon River Gauges',
    icon: '≈',
    source: 'ANA TELEMETRIA · LIVE',
    contextSource: 'ANA / SNIRH telemetry',
    updateInterval: GAUGES_UPDATE_INTERVAL_MS,
    feed: {
      async getSnapshot(request) {
        const payload = await feed.getSnapshot(request);
        const features = gaugeFeatures(payload);
        if (!features) throw new Error('Malformed gauge snapshot');
        return { ...payload, features };
      },
    },
    services,
    present: {
      style: gaugeFeatureStyle,
      describe: (feature) => gaugeCardCopy(feature, { selected: true }),
      contextLabel: (feature) => gaugeCardCopy(feature).title,
      contextProperties: (feature) => ({
        code: feature.code,
        name: feature.name,
        river: feature.river,
        levelM: feature.summary?.levelM ?? null,
        delta24hCm: feature.summary?.delta24hCm ?? null,
        rain24hMm: feature.summary?.rain24hMm ?? null,
        observedAt: feature.summary?.at
          ? new Date(feature.summary.at).toISOString()
          : null,
      }),
      overlayEntry: (feature, { id, source, position }) => {
        // A silent station keeps its grey marker but earns no card: the card
        // is the reading, and "NO READING" over half the basin is noise.
        if (!feature.summary) return null;
        const copy = gaugeCardCopy(feature);
        return ambientCardEntry({
          id,
          source,
          position,
          title: copy.title,
          details: copy.details,
          accent: copy.accent,
          // Manaus first when cards compete for the same pixels.
          priority: feature.code === '14990000' ? 100 : 10,
        });
      },
      analystRecord: gaugeAnalystRecord,
      focusKind: 'feature',
      anchorHeightM: () => 0,
    },
    ...options,
  });
}
