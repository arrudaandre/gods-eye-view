import {
  createOpenSkySource,
  createAdsbLolSource,
  createAisStreamSource,
} from '../sources/live/standalone.js';
import { createCctvSource } from '../layers/cctv/source.js';
import { createRadioSource } from '../layers/radio/source.js';
import { createTransitSource } from '../layers/transit/source.js';
import { createTrafficSource } from '../layers/traffic/source.js';
import { createBikeshareSource } from '../layers/bikeshare/source.js';
import { createInstallationSource } from '../layers/installations/source.js';
import { createSatelliteSource } from '../layers/satellites/source.js';
import { createLaunchSource } from '../layers/launches/source.js';
import { createOverpassAlprSource } from '../layers/alpr/source.js';
import { createFirmsSource } from '../layers/firms/source.js';
import { createJsonSnapshotSource } from '../layers/geofeatures/source.js';
import { createReferenceSources } from '../sources/reference.js';
export { createReferenceSources as createStandaloneReferenceSources } from '../sources/reference.js';

/** Select standalone providers without starting their acquisition. */
export function createStandaloneLayerSources() {
  return {
    ...createReferenceSources(),
    flights: createOpenSkySource(),
    military: createAdsbLolSource(),
    vessels: createAisStreamSource({
      apiUrl: import.meta.env?.VITE_AIS_LIVE_API_URL || '/api/ais-live',
    }),
    cctv: createCctvSource(),
    radio: createRadioSource(),
    traffic: createTrafficSource(),
    transit: createTransitSource(),
    bikeshare: createBikeshareSource(),
    installations: createInstallationSource(),
    satellites: createSatelliteSource(),
    launches: createLaunchSource(),
    alpr: createOverpassAlprSource(),
    firms: createFirmsSource(),
    // Same snapshot contract as /api/firms, served by the keyless INPE proxy.
    inpe: createFirmsSource({ url: '/api/inpe', label: 'INPE' }),
    deter: createJsonSnapshotSource({ url: '/api/deter', label: 'DETER' }),
    gauges: createJsonSnapshotSource({ url: '/api/ana-gauges', label: 'ANA' }),
    airspace: createJsonSnapshotSource({
      url: '/api/airspace',
      label: 'GeoAISWEB',
    }),
  };
}
