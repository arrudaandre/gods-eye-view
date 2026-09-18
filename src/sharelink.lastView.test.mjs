// The hash and the last-view store are written from the same debounce: what
// you can copy as a link is exactly what reopens next time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ShareLinkManager } from './sharelink.js';
import { LAST_VIEW_STORAGE_KEY, readLastView } from './lastView.js';

function fakeStorage() {
  const map = new Map();
  return {
    writes: 0,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem(key, value) {
      this.writes += 1;
      map.set(key, String(value));
    },
  };
}

function makeManager(storage, hash = '') {
  globalThis.window = { location: { hash, href: `http://localhost/${hash}` } };
  globalThis.history = {
    replaceState(_state, _title, nextHash) {
      window.location.hash = nextHash;
    },
  };
  const viewer = {
    camera: {
      changed: { addEventListener() {} },
      positionCartographic: {
        latitude: (-3.119 * Math.PI) / 180,
        longitude: (-60.0217 * Math.PI) / 180,
        height: 1235,
      },
      heading: Math.PI / 2,
      pitch: -Math.PI / 4,
      roll: 0,
    },
  };
  return new ShareLinkManager(viewer, { storage });
}

test('a hash update also saves the same pose as the last view', () => {
  const storage = fakeStorage();
  const manager = makeManager(storage);
  manager._updateHash();
  assert.match(window.location.hash, /lat=-3\.1190&lon=-60\.0217&alt=1235&heading=90&pitch=-45/);
  assert.deepEqual(readLastView(storage), {
    lat: -3.119, lon: -60.0217, alt: 1235, heading: 90, pitch: -45, roll: 0,
  });
  manager._updateHash();
  assert.equal(storage.writes, 1, 'an unchanged pose is not rewritten');
  manager.destroy();
});

test('an incoming share link holds the store back until its restore settles', () => {
  const storage = fakeStorage();
  const manager = makeManager(storage, '#lat=30.27&lon=-97.74&alt=800');
  assert.ok(manager.parseInitialHash(), 'the link is valid incoming state');
  manager._updateHash();
  assert.equal(storage.getItem(LAST_VIEW_STORAGE_KEY), null, 'nothing saved during restore');
  manager.completeInitialRestore();
  manager._updateHash();
  assert.ok(readLastView(storage), 'saved once the restore released hash writes');
  manager.destroy();
});

test('blocked storage never breaks hash updates', () => {
  const manager = makeManager(null);
  assert.doesNotThrow(() => manager._updateHash());
  assert.match(window.location.hash, /^#v=2/);
  manager.destroy();
});
