import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAST_VIEW_STORAGE_KEY,
  chooseStartupCamera,
  normalizeLastView,
  parseLastView,
  readLastView,
  serializeLastView,
  writeLastView,
} from './lastView.js';

const manaus = { lat: -3.11903, lon: -60.02173, alt: 1234.6, heading: 359.6, pitch: -34.4, roll: 0.2 };

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const log = [];
  return {
    log,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      log.push([key, value]);
      map.set(key, String(value));
    },
  };
}

test('a pose is rounded like the share hash and round-trips through storage', () => {
  const normalized = normalizeLastView(manaus);
  assert.deepEqual(normalized, { lat: -3.119, lon: -60.0217, alt: 1235, heading: 0, pitch: -34, roll: 0 });
  const storage = fakeStorage();
  assert.equal(writeLastView(storage, manaus), true);
  assert.deepEqual(readLastView(storage), normalized);
  assert.equal(writeLastView(storage, manaus), true);
  assert.equal(storage.log.length, 1, 'an unchanged pose is not rewritten');
});

test('malformed, foreign and out-of-range poses read as no view', () => {
  assert.equal(parseLastView(''), null);
  assert.equal(parseLastView('not json'), null);
  assert.equal(parseLastView(JSON.stringify({ v: 2, ...manaus })), null, 'unknown version');
  assert.equal(normalizeLastView({ lat: 91, lon: 0, alt: 100 }), null);
  assert.equal(normalizeLastView({ lat: 0, lon: 0, alt: 0 }), null, 'zero altitude is inside the globe');
  assert.equal(normalizeLastView({ lat: 0, lon: 0, alt: 1e9 }), null);
  assert.equal(normalizeLastView({ lat: 'Infinity', lon: 0, alt: 10 }), null);
  assert.equal(normalizeLastView(null), null);
  assert.equal(serializeLastView({ lat: NaN }), null);
  assert.equal(readLastView(fakeStorage({ [LAST_VIEW_STORAGE_KEY]: '{"v":1,"lat":5}' })), null);
  assert.equal(readLastView(null), null);
  assert.equal(readLastView({ getItem() { throw new Error('blocked'); } }), null);
  assert.equal(writeLastView({ getItem: () => null, setItem() { throw new Error('quota'); } }, manaus), false);
});

test('heading wraps, pitch clamps, missing angles take the app defaults', () => {
  assert.deepEqual(normalizeLastView({ lat: 1, lon: 2, alt: 3, heading: -30, pitch: -120 }), {
    lat: 1, lon: 2, alt: 3, heading: 330, pitch: -90, roll: 0,
  });
  assert.equal(normalizeLastView({ lat: 1, lon: 2, alt: 3 }).pitch, -35);
  assert.equal(normalizeLastView({ lat: 1, lon: 2, alt: 3, roll: 360 }).roll, 0, 'Cesium near-zero roll');
  assert.equal(normalizeLastView({ lat: 1, lon: 2, alt: 3, roll: -190 }).roll, 170);
  assert.equal(normalizeLastView({ lat: 1, lon: 2, alt: 3, roll: 180 }).roll, -180, 'wrapped into [-180, 180)');
});

test('startup camera: share link wins, then the saved view, then the default', () => {
  assert.equal(chooseStartupCamera({ hasShareState: true, lastView: manaus }), 'share');
  assert.equal(chooseStartupCamera({ hasShareState: false, lastView: manaus }), 'last-view');
  assert.equal(chooseStartupCamera({ hasShareState: false, lastView: { lat: 91 } }), 'default');
  assert.equal(chooseStartupCamera({}), 'default');
});
