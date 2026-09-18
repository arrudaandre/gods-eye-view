import * as Cesium from 'cesium';
import { createDeterLayer } from '../../layers/geofeatures/deter.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as focus from '../../worldFocus.js';
import { refreshTrackedReadout } from '../../data/trackedReadout.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { applicationServices } from '../../services/application.js';
import { windAloftLine } from '../../data/regionalModel.js';

/**
 * Point weather for a selected feature: the same `/api/weather-effects`
 * Open-Meteo lookup the cockpit clouds use, reduced to one wind-aloft line
 * (10 / 80 / 120 m + gust). Returns [] when the lookup has nothing to say.
 */
export async function windAloftForPoint(
  { latitude, longitude },
  { signal } = {},
) {
  const payload = await applicationServices.weather.getConditions(
    latitude,
    longitude,
    { signal },
  );
  const line = windAloftLine(payload?.weather);
  return line ? [line] : [];
}

/** Services every geo-feature layer binds to in the standalone application. */
export const geoFeatureServices = Object.freeze({
  render,
  context,
  focus,
  readout: { refreshTrackedReadout },
  enrich: windAloftForPoint,
});

/** Bind the DETER feed to the application's scene service owners. */
export function createApplicationDeter({ source, ...options }) {
  return createDeterLayer({
    feed: source,
    services: geoFeatureServices,
    isPointerFree,
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    ...options,
  });
}
