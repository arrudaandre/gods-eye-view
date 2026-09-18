import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GIBS_MAXIMUM_LEVEL,
  GIBS_TRUE_COLOR_LAYER,
  gibsImageryDate,
  gibsTileTemplate,
} from './gibs.js';

test('the imagery day is the last complete UTC day', () => {
  assert.equal(gibsImageryDate(Date.UTC(2026, 8, 18, 12, 0, 0)), '2026-09-17');
  assert.equal(gibsImageryDate(Date.UTC(2026, 8, 18, 0, 5, 0)), '2026-09-17');
  assert.equal(gibsImageryDate(Date.UTC(2026, 0, 1, 3, 0, 0)), '2025-12-31');
});

test('the tile template names the layer, the date and the Level-9 matrix set', () => {
  const url = gibsTileTemplate({ date: '2026-09-17' });
  assert.equal(
    url,
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${GIBS_TRUE_COLOR_LAYER}/default/2026-09-17/GoogleMapsCompatible_Level9/{TileMatrix}/{TileRow}/{TileCol}.jpg`,
  );
  assert.equal(GIBS_MAXIMUM_LEVEL, 9, 'zoom 10 is a 400 on the 250 m products');
  assert.throws(() => gibsTileTemplate({ date: 'yesterday' }), TypeError);
  assert.throws(
    () => gibsTileTemplate({ date: '2026-09-17', layer: '../x' }),
    TypeError,
  );
});
