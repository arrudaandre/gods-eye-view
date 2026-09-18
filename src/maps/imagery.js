import * as Cesium from 'cesium';
import {
  GIBS_ATTRIBUTION_HTML,
  GIBS_MAXIMUM_LEVEL,
  GIBS_TILE_MATRIX_SET,
  GIBS_TRUE_COLOR_LAYER,
  gibsImageryDate,
  gibsTileTemplate,
} from './gibs.js';

// Attribution and service rights are documented in DATA_SOURCES.md.
export const ESRI_ATTRIBUTION_HTML =
  '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a>';

export function createOsmImagery() {
  return new Cesium.OpenStreetMapImageryProvider({
    url: 'https://tile.openstreetmap.org/',
    credit: '© OpenStreetMap contributors',
  });
}

export function createEsriImagery() {
  return Cesium.ArcGisMapServerImageryProvider.fromUrl(
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    {
      credit:
        'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      enablePickFeatures: false,
    },
  );
}

/**
 * NASA GIBS daily true colour (VIIRS SNPP) for the last complete UTC day:
 * yesterday's smoke, clouds and flood extent over the whole globe, keyless.
 * Web Mercator matrix set, 250 m products stop at zoom 9; Cesium upsamples
 * the last level beyond that instead of requesting tiles that 400.
 */
export function createGibsImagery({ nowMs = Date.now() } = {}) {
  return new Cesium.WebMapTileServiceImageryProvider({
    url: gibsTileTemplate({ date: gibsImageryDate(nowMs) }),
    layer: GIBS_TRUE_COLOR_LAYER,
    style: 'default',
    format: 'image/jpeg',
    tileMatrixSetID: GIBS_TILE_MATRIX_SET,
    maximumLevel: GIBS_MAXIMUM_LEVEL,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    credit: new Cesium.Credit(GIBS_ATTRIBUTION_HTML, false),
  });
}

export function createIonImagery(style, accessToken) {
  accessToken = String(accessToken || '').trim();
  if (!accessToken) throw new Error('Ion imagery requires an explicit token');
  return Cesium.IonImageryProvider.fromAssetId(style, { accessToken });
}
