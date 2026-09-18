import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DETER_DEFAULT_DAYS,
  DETER_MAX_DAYS,
  deterCardCopy,
  deterClass,
  deterDaysFromEnv,
  deterSinceDate,
  deterWfsUrl,
  filterDeterSince,
  formatDeterArea,
  normalizeDeterCollection,
  normalizeDeterFeature,
  cleanRing,
  polygonsCentroid,
  polygonsOf,
} from './deterModel.js';

const SQUARE = [
  [
    [-60.0, -3.0],
    [-59.9, -3.0],
    [-59.9, -2.9],
    [-60.0, -2.9],
    [-60.0, -3.0],
  ],
];

function feature(
  overrides = {},
  geometry = { type: 'Polygon', coordinates: SQUARE },
) {
  return {
    type: 'Feature',
    id: 'deter_amz.1',
    geometry,
    properties: {
      gid: '32479_curr',
      classname: 'DESMATAMENTO_CR',
      view_date: '2026-09-03',
      sensor: 'WFI',
      satellite: 'AMAZONIA-1',
      areauckm: 0,
      uc: null,
      areamunkm: 0.42,
      municipality: 'Iracema',
      uf: 'RR',
      publish_month: '2026-09-01',
      ...overrides,
    },
  };
}

test('DETER window comes from the environment, bounded and defaulted', () => {
  assert.equal(deterDaysFromEnv(undefined), DETER_DEFAULT_DAYS);
  assert.equal(deterDaysFromEnv(''), DETER_DEFAULT_DAYS);
  assert.equal(deterDaysFromEnv('abc'), DETER_DEFAULT_DAYS);
  assert.equal(deterDaysFromEnv('7'), 7);
  assert.equal(deterDaysFromEnv('0'), 1);
  assert.equal(deterDaysFromEnv('9999'), DETER_MAX_DAYS);
});

test('since date and WFS URL encode the CQL filter for GeoServer', () => {
  const now = Date.UTC(2026, 8, 18, 12, 0, 0);
  assert.equal(deterSinceDate(now, 30), '2026-08-19');
  assert.equal(deterSinceDate(now, 0), '2026-09-18');
  const url = deterWfsUrl({ since: '2026-08-19' });
  assert.match(
    url,
    /^https:\/\/terrabrasilis\.dpi\.inpe\.br\/geoserver\/deter-amz\/deter_amz\/ows\?/,
  );
  assert.match(url, /typeName=deter-amz%3Adeter_amz/);
  assert.match(url, /CQL_FILTER=view_date%3E%3D%272026-08-19%27/);
  assert.doesNotMatch(url, /[>']/);
  assert.throws(() => deterWfsUrl({ since: 'yesterday' }), TypeError);
});

test('polygons and centroid handle Polygon, MultiPolygon and junk rings', () => {
  assert.equal(polygonsOf(null).length, 0);
  assert.equal(polygonsOf({ type: 'Point', coordinates: [1, 2] }).length, 0);
  assert.equal(polygonsOf({ type: 'Polygon', coordinates: SQUARE }).length, 1);
  const multi = polygonsOf({
    type: 'MultiPolygon',
    coordinates: [SQUARE, [[[1, 1]]], 'junk'],
  });
  assert.equal(
    multi.length,
    1,
    'a ring with fewer than 3 valid points is dropped',
  );
  const degenerate = polygonsOf({
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [-60.1046, 1.1412],
          [-60.1046, 1.1412],
          [-60.1046, 1.1412],
          [-60.1046, 1.1412],
        ],
      ],
      [
        [
          [-60.0, -3.0],
          [-59.9, -3.0],
          [-59.8, -3.0],
          [-60.0, -3.0],
        ],
      ],
      [
        ...SQUARE,
        [
          [1, 1],
          [1, 1],
          [1, 1],
        ],
      ],
    ],
  });
  assert.equal(
    degenerate.length,
    1,
    'a collapsed ring and a zero-area line are dropped; a bad hole is dropped',
  );
  assert.equal(degenerate[0].length, 1);
  assert.equal(degenerate[0][0].length, 4, 'closing vertex removed');
  assert.deepEqual(
    cleanRing([
      [0, 0],
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ]),
    [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
  );
  const [lon, lat] = polygonsCentroid(multi);
  assert.ok(Math.abs(lon - -59.95) < 1e-9);
  assert.ok(Math.abs(lat - -2.95) < 1e-9);
  assert.equal(polygonsCentroid([]), null);
});

test('normalizeDeterFeature compacts one alert and rejects undated or empty ones', () => {
  const normalized = normalizeDeterFeature(feature());
  assert.equal(normalized.id, '32479_curr');
  assert.equal(normalized.classname, 'DESMATAMENTO_CR');
  assert.equal(normalized.viewDate, '2026-09-03');
  assert.equal(normalized.satellite, 'AMAZONIA-1');
  assert.equal(normalized.sensor, 'WFI');
  assert.equal(normalized.municipality, 'Iracema');
  assert.equal(normalized.uf, 'RR');
  assert.equal(normalized.uc, null);
  assert.equal(normalized.areaKm2, 0.42);
  assert.equal(normalized.lon, -59.95);
  assert.equal(normalized.lat, -2.95);
  assert.equal(normalized.polygons.length, 1);
  assert.equal(normalizeDeterFeature(feature({ view_date: null })), null);
  assert.equal(
    normalizeDeterFeature(feature({ view_date: '03/09/2026' })),
    null,
  );
  assert.equal(
    normalizeDeterFeature(feature({}, { type: 'Point', coordinates: [1, 2] })),
    null,
  );
  assert.equal(
    normalizeDeterFeature(feature({ gid: null }), 4).id,
    'deter_amz.1',
  );
  const anonymous = feature({ gid: null });
  delete anonymous.id;
  assert.equal(normalizeDeterFeature(anonymous, 4).id, 'deter-4');
  assert.equal(
    normalizeDeterFeature(feature({ areamunkm: 5.488065769057721e-5 })).areaKm2,
    0.0001,
  );
});

test('normalizeDeterCollection refuses anything but a FeatureCollection', () => {
  assert.equal(normalizeDeterCollection(null), null);
  assert.equal(normalizeDeterCollection({ type: 'ServiceException' }), null);
  assert.equal(normalizeDeterCollection({ type: 'FeatureCollection' }), null);
  const rows = normalizeDeterCollection({
    type: 'FeatureCollection',
    features: [feature(), feature({ view_date: null }), 'junk'],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(
    filterDeterSince(rows, '2026-09-04').map((row) => row.id),
    [],
  );
  assert.equal(filterDeterSince(rows, '2026-09-03').length, 1);
  assert.equal(filterDeterSince(rows, null).length, 1);
});

test('classes, areas and card copy read like the panel expects', () => {
  assert.equal(deterClass('desmatamento_cr').label, 'Clear-cut');
  assert.equal(deterClass('nope').label, 'Alert');
  assert.equal(formatDeterArea(0.42), '0.42 km²');
  assert.equal(formatDeterArea(0.05), '5.0 ha');
  assert.equal(formatDeterArea(0), null);
  const copy = deterCardCopy(
    normalizeDeterFeature(feature({ uc: 'PARNA Viruá' })),
  );
  assert.equal(copy.title, 'CLEAR-CUT · 0.42 km²');
  assert.deepEqual(copy.details, [
    'Iracema, RR · 2026-09-03',
    'UC PARNA Viruá',
    'AMAZONIA-1 WFI',
  ]);
  assert.equal(copy.accent, '#ff3b3b');
});
