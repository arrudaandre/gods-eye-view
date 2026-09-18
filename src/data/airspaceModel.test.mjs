import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIRSPACE_DEFAULT_BBOX,
  AIRSPACE_LAYERS,
  airspaceAnalystRecord,
  airspaceCardCopy,
  airspaceWfsUrl,
  normalizeAirspaceCollection,
  normalizeAirspaceFeature,
  parseBbox,
  verticalLimit,
} from './airspaceModel.js';

const RING = [
  [-60.2, -3.2],
  [-59.8, -3.2],
  [-59.8, -2.8],
  [-60.2, -2.8],
  [-60.2, -3.2],
];
const layerOf = (kind) => AIRSPACE_LAYERS.find((layer) => layer.kind === kind);

test('bbox parsing is bounded and defaults to Amazonas', () => {
  assert.deepEqual(parseBbox(undefined), AIRSPACE_DEFAULT_BBOX);
  assert.deepEqual(parseBbox('-61,-4,-59,-2'), {
    west: -61,
    south: -4,
    east: -59,
    north: -2,
  });
  assert.deepEqual(
    parseBbox('-59,-4,-61,-2'),
    AIRSPACE_DEFAULT_BBOX,
    'inside-out',
  );
  assert.deepEqual(parseBbox('a,b,c,d'), AIRSPACE_DEFAULT_BBOX);
  assert.deepEqual(parseBbox('-200,-4,-59,-2'), AIRSPACE_DEFAULT_BBOX);
});

test('WFS URL names the layer, the bbox axis order and JSON output', () => {
  const url = airspaceWfsUrl('ICA:CTR', {
    west: -61,
    south: -4,
    east: -59,
    north: -2,
  });
  assert.match(
    url,
    /^https:\/\/geoaisweb\.decea\.mil\.br\/geoserver\/ICA\/ows\?/,
  );
  assert.match(url, /typeName=ICA%3ACTR/);
  assert.match(url, /bbox=-61%2C-4%2C-59%2C-2%2CEPSG%3A4326/);
  assert.match(url, /maxFeatures=3000/);
  assert.throws(
    () => airspaceWfsUrl('DROP TABLE', AIRSPACE_DEFAULT_BBOX),
    TypeError,
  );
});

test('vertical limits translate SFC, FT MSL, FL and AGL into metres and labels', () => {
  assert.deepEqual(verticalLimit(0, 'FT', 'SFC'), {
    metres: 0,
    label: 'SFC',
    ground: true,
  });
  assert.deepEqual(verticalLimit(2000, 'FT', 'MSL'), {
    metres: 610,
    label: '2000 ft',
    ground: false,
  });
  assert.deepEqual(verticalLimit(145, 'FL', 'STD'), {
    metres: 4420,
    label: 'FL145',
    ground: false,
  });
  assert.deepEqual(verticalLimit(400, 'FT', 'AGL'), {
    metres: 122,
    label: '400 ft AGL',
    ground: true,
  });
  assert.deepEqual(verticalLimit(0, 'FT', 'MSL'), {
    metres: 0,
    label: 'SFC',
    ground: true,
  });
  assert.equal(verticalLimit('abc', 'FT', 'MSL'), null);
  assert.deepEqual(verticalLimit(2000, 'FT', 'SFC'), {
    metres: 610,
    label: '2000 ft AGL',
    ground: true,
  });
  assert.deepEqual(verticalLimit(null, 'FT', 'SFC'), {
    metres: 0,
    label: 'SFC',
    ground: true,
  });
});

test('CTR, restricted areas and aerodromes normalize from their own spellings', () => {
  const ctr = normalizeAirspaceFeature(layerOf('CTR'), {
    geometry: { type: 'Polygon', coordinates: [RING] },
    properties: {
      gid: 1003,
      typ: 'CTR',
      ident: 'SBMN_01',
      nam: 'Manaus 1',
      codedistve: 'SFC',
      uplimituni: 'FT',
      codedistv1: 'SFC',
      lowerlimit: 'FT',
      upperlimit: 2000,
      lowerlimi1: 0,
      relatedfir: 'SBAZ',
      effectived: '2025-10-30Z',
    },
  });
  assert.equal(ctr.id, 'CTR-SBMN_01');
  assert.equal(ctr.kind, 'CTR');
  assert.equal(ctr.lowerM, 0);
  assert.equal(ctr.lowerGround, true);
  assert.equal(ctr.upperM, 610);
  assert.equal(ctr.upperLabel, '2000 ft AGL', 'ref SFC with a value = AGL');
  assert.equal(ctr.fir, 'SBAZ');
  assert.equal(ctr.polygons[0][0].length, 4, 'closing vertex removed');
  assert.equal(ctr.lon, -60);
  assert.equal(ctr.lat, -3);

  const tma = normalizeAirspaceFeature(layerOf('TMA'), {
    geometry: { type: 'Polygon', coordinates: [RING] },
    properties: {
      ident: 'SBWN_03',
      nam: 'Manaus 3',
      codedistve: 'STD',
      uplimituni: 'FL',
      codedistv1: 'STD',
      lowerlimit: 'FL',
      upperlimit: 195,
      lowerlimi1: 65,
    },
  });
  assert.equal(tma.lowerM, 1981);
  assert.equal(tma.lowerLabel, 'FL065');
  assert.equal(tma.upperLabel, 'FL195');
  assert.equal(tma.lowerGround, false);

  const restricted = normalizeAirspaceFeature(layerOf('R'), {
    geometry: { type: 'MultiPolygon', coordinates: [[RING]] },
    properties: {
      id: 'SBR704',
      nome: 'SOLIMÕES',
      tipo: 'R',
      uom_ulimit: 'FT',
      uom_llimit: 'FT',
      upperlimit: 1500,
      lowerlimit: 0,
      fir: 'SBAZ',
      efetivacao: '2025-10-30Z',
    },
  });
  assert.equal(restricted.id, 'R-SBR704');
  assert.equal(restricted.name, 'SOLIMÕES');
  assert.equal(restricted.lowerLabel, 'SFC');
  assert.equal(restricted.upperM, 457);

  const airport = normalizeAirspaceFeature(layerOf('AD'), {
    geometry: { type: 'MultiPoint', coordinates: [[-60.0506, -3.0411]] },
    properties: {
      localidade_id: 'SBEG',
      nome: 'Eduardo Gomes',
      tipo_util: 'PUB',
      cat_sigla: 'INTL',
      opr: 'VFR IFR',
      elevacao: 80.4,
      elev_uom: 'M',
      cidade: 'Manaus',
      uf: 'AM',
    },
  });
  assert.equal(airport.id, 'AD-SBEG');
  assert.equal(airport.icao, 'SBEG');
  assert.equal(airport.elevationM, 80);
  assert.equal(airport.lon, -60.0506);
  assert.deepEqual(airport.polygons, []);

  const heliport = normalizeAirspaceFeature(layerOf('HP'), {
    geometry: null,
    properties: {
      localidade_id: 'SDEH',
      nome: 'Hospital Zona Norte',
      longitude_dec: -60.03,
      latitude_dec: -2.998,
    },
  });
  assert.equal(
    heliport.id,
    'HP-SDEH',
    'decimal coordinates stand in for a missing geometry',
  );

  assert.equal(
    normalizeAirspaceFeature(layerOf('CTR'), {
      geometry: { type: 'Polygon', coordinates: [RING] },
      properties: {
        upperlimit: 0,
        lowerlimi1: 0,
        uplimituni: 'FT',
        lowerlimit: 'FT',
        codedistve: 'MSL',
        codedistv1: 'SFC',
      },
    }),
    null,
    'a volume with no height is dropped',
  );
  assert.equal(
    normalizeAirspaceFeature(layerOf('AD'), { geometry: null, properties: {} }),
    null,
  );
});

test('collections reject non-GeoJSON and card copy reads like the readout', () => {
  assert.equal(
    normalizeAirspaceCollection(layerOf('CTR'), '<ServiceException/>'),
    null,
  );
  const rows = normalizeAirspaceCollection(layerOf('D'), {
    type: 'FeatureCollection',
    features: [
      {
        geometry: { type: 'Polygon', coordinates: [RING] },
        properties: {
          id: 'SBD332',
          nome: 'VOO LIVRE CASTELO',
          uom_ulimit: 'FL',
          uom_llimit: 'FT',
          upperlimit: 80,
          lowerlimit: 0,
          fir: 'SBCW',
          observacao: 'Paragliding',
        },
      },
      'junk',
    ],
  });
  assert.equal(rows.length, 1);
  const copy = airspaceCardCopy(rows[0]);
  assert.equal(copy.title, 'SBD332 · VOO LIVRE CASTELO');
  assert.deepEqual(copy.details, [
    'Danger area · SFC – FL080',
    'FIR SBCW',
    'Paragliding',
  ]);
  assert.equal(copy.accent, '#ffd23b');

  const airport = normalizeAirspaceFeature(layerOf('AD'), {
    geometry: { type: 'Point', coordinates: [-60.0506, -3.0411] },
    properties: {
      localidade_id: 'SBEG',
      nome: 'Eduardo Gomes',
      tipo_util: 'PUB',
      cat_sigla: 'INTL',
      opr: 'VFR IFR',
      elevacao: 80.4,
      elev_uom: 'M',
      cidade: 'Manaus',
      uf: 'AM',
    },
  });
  const airportCopy = airspaceCardCopy(airport);
  assert.equal(airportCopy.title, 'SBEG · EDUARDO GOMES');
  assert.deepEqual(airportCopy.details, [
    'Aerodrome · public · INTL',
    'Manaus, AM · 80 m · VFR IFR',
  ]);
  assert.deepEqual(airspaceAnalystRecord(rows[0], 2), {
    index: 2,
    id: 'D-SBD332',
    kind: 'D',
    kindLabel: 'Danger area',
    ident: 'SBD332',
    name: 'VOO LIVRE CASTELO',
    lowerM: 0,
    upperM: 2438,
    lat: -3,
    lon: -60,
  });
});
