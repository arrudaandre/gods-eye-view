import * as Cesium from 'cesium';
import { createRiverGaugesLayer } from '../../layers/geofeatures/gauges.js';
import { geoFeatureServices } from './deter.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Bind the ANA gauge feed to the application's scene service owners. */
export function createApplicationRiverGauges({ source, ...options }) {
  return createRiverGaugesLayer({
    feed: source,
    services: {
      ...geoFeatureServices,
      overlayHost: {
        setEntries: setOverlayEntries,
        setVisible: setOverlaySourceVisible,
        clearSource: clearOverlaySource,
      },
    },
    isPointerFree,
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    ...options,
  });
}
