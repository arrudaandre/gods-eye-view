import { createGeoFeatureLayer } from './core.js';
import {
  deterAnalystRecord,
  deterCardCopy,
  deterClass,
} from '../../data/deterModel.js';

export const DETER_LAYER_ID = 'inpe-deter';
export const DETER_UPDATE_INTERVAL_MS = 6 * 3600_000;

/** Ground-draped alert polygon plus a class-coloured marker findable from afar. */
export function deterFeatureStyle(feature) {
  const cls = deterClass(feature?.classname);
  const area = Number(feature?.areaKm2);
  return {
    fill: cls.color,
    fillAlpha: 0.55,
    marker: {
      color: cls.color,
      pixelSize: Number.isFinite(area) && area >= 1 ? 7 : 5,
      alpha: 0.95,
      clampToGround: true,
      // Up close the draped polygon itself is the signal; the dot would only
      // hide it.
      maxDistanceM: 2_500_000,
    },
  };
}

/** Compose the DETER alerts layer over a `/api/deter` feed. */
export function createDeterLayer({ feed, services, ...options } = {}) {
  return createGeoFeatureLayer({
    id: DETER_LAYER_ID,
    name: 'DETER Amazon Alerts',
    icon: '◩',
    source: 'INPE DETER · TERRABRASILIS',
    contextSource: 'INPE DETER / TerraBrasilis',
    updateInterval: DETER_UPDATE_INTERVAL_MS,
    feed,
    services,
    present: {
      style: deterFeatureStyle,
      describe: deterCardCopy,
      contextLabel: (feature) => deterCardCopy(feature).title,
      analystRecord: deterAnalystRecord,
      focusKind: 'feature',
      anchorHeightM: () => 0,
    },
    ...options,
  });
}
