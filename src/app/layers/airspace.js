import * as Cesium from 'cesium';
import { createAirspaceLayer } from '../../layers/geofeatures/airspace.js';
import { geoFeatureServices } from './deter.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Bind the DECEA airspace feed to the application's scene service owners. */
export function createApplicationAirspace({ source, ...options }) {
  return createAirspaceLayer({
    feed: source,
    services: geoFeatureServices,
    isPointerFree,
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    ...options,
  });
}
