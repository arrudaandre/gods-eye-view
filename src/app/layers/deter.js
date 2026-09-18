import * as Cesium from 'cesium';
import { createDeterLayer } from '../../layers/geofeatures/deter.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as focus from '../../worldFocus.js';
import { refreshTrackedReadout } from '../../data/trackedReadout.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Services every geo-feature layer binds to in the standalone application. */
export const geoFeatureServices = Object.freeze({
  render,
  context,
  focus,
  readout: { refreshTrackedReadout },
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
