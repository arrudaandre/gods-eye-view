// Two fires instances (NASA FIRMS + INPE) must coexist: distinct overlay
// sources, pick-id prefixes, detection keys and key gating. Driven through
// the production layer factory with only the viewer, event handler and
// overlay host stubbed, mirroring firmsInteraction.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createFirmsHeatmapLayer } from './firmsHeatmap.js';
import { resolveFiresConfig } from '../layers/firms/index.js';
import { adaptFirmsRecords } from './firmsAdapt.js';
import { WORLD_FOCUS_REQUEST_EVENT } from '../worldFocus.js';

function makeFire(overrides = {}) {
  return {
    index: 7,
    lat: -5.7614,
    lon: -57.6002,
    frp: 70,
    confidence: null,
    satellite: 'GOES-19',
    sensor: 'ABI',
    acqMs: 1_789_700_000_000,
    place: 'JACAREACANGA · PARÁ',
    feedId: 'inpe',
    ...overrides,
  };
}

function harness({ namespace, picked = null, fires = [makeFire()] }) {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const priorWindow = globalThis.window;
  const priorProjection = Cesium.SceneTransforms.worldToWindowCoordinates;
  const windowTarget = new EventTarget();
  globalThis.window = windowTarget;
  Cesium.SceneTransforms.worldToWindowCoordinates = () => ({ x: 200, y: 300 });

  const sourceIds = new Set();
  const published = [];
  let handler = null;
  const layer = createFirmsHeatmapLayer({
    id: `${namespace}-test`,
    name: 'Fires',
    ...(namespace === 'firms' ? {} : { namespace }),
    overlayHost: {
      setEntries: (sourceId, entries) => {
        sourceIds.add(sourceId);
        published.push(...entries);
      },
      setVisible: (sourceId) => sourceIds.add(sourceId),
      clearSource: (sourceId) => sourceIds.add(sourceId),
      hitTest: () => null,
    },
    screenSpaceEventHandlerFactory: () => {
      handler = { click: null, setInputAction(cb) { this.click = cb; }, destroy() {} };
      return handler;
    },
  });
  const viewer = {
    scene: {
      pick: () => picked,
      canvas: { clientWidth: 1280, clientHeight: 800 },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    },
    dataSources: { add() {}, remove() {} },
  };
  layer._bindInteractionForTest(viewer, fires);
  const requests = [];
  windowTarget.addEventListener(WORLD_FOCUS_REQUEST_EVENT, (e) => requests.push(e.detail));
  return {
    layer,
    sourceIds,
    published,
    requests,
    click: () => handler.click({ position: { x: 400, y: 300 } }),
    cleanup() {
      Cesium.SceneTransforms.worldToWindowCoordinates = priorProjection;
      if (hadWindow) globalThis.window = priorWindow;
      else delete globalThis.window;
    },
  };
}

test('resolveFiresConfig keeps every FIRMS default and derives INPE identity', () => {
  const firms = resolveFiresConfig({ id: 'local-firms' });
  assert.equal(firms.namespace, 'firms');
  assert.equal(firms.overlaySourceId, 'firms');
  assert.equal(firms.requiresKeyId, 'firms');
  assert.equal(firms.contextSource, 'NASA FIRMS');

  const inpe = resolveFiresConfig({ id: 'inpe-fires', namespace: 'inpe' });
  assert.equal(inpe.overlaySourceId, 'inpe');
  assert.equal(inpe.requiresKeyId, null, 'open data is never key-gated by default');
  assert.equal(inpe.contextSource, 'NASA FIRMS', 'label is explicit, not guessed');

  const explicit = resolveFiresConfig({ namespace: 'inpe', requiresKeyId: 'x', contextSource: 'INPE' });
  assert.equal(explicit.requiresKeyId, 'x');
  assert.equal(explicit.contextSource, 'INPE');
  assert.equal(resolveFiresConfig({ namespace: '  ' }).namespace, 'firms');
});

test('adaptFirmsRecords stamps the feed and keeps absent confidence null', () => {
  const [inpe] = adaptFirmsRecords(
    [{ lat: -5.76, lon: -57.6, frp: '70.0', satellite: 'GOES-19', instrument: 'ABI', place: ' PARÁ ' }],
    { feedId: 'inpe' },
  );
  assert.equal(inpe.feedId, 'inpe');
  assert.equal(inpe.confidence, null);
  assert.equal(inpe.place, 'PARÁ');
  assert.equal(inpe.sensor, 'ABI');
  const [firms] = adaptFirmsRecords([{ lat: 1, lon: 2, confidence: 'h' }]);
  assert.equal(firms.feedId, 'firms');
  assert.equal(firms.confidence, 0.9);
  assert.equal(firms.place, '');
});

test('the INPE instance owns its own overlay source and pick namespace', () => {
  const h = harness({ namespace: 'inpe', picked: { id: 'inpe-7' } });
  try {
    assert.equal(h.layer.requiresKeyId, null);
    h.click();
    assert.equal(h.requests.length, 1, 'clicking an inpe-7 sprite selects the fire');
    assert.match(h.requests[0].id, /^inpe:/);
    assert.match(h.layer.getSelectedInfo().id, /^inpe:/);
    assert.ok(h.sourceIds.has('inpe'), 'cards go to the inpe overlay source');
    assert.ok(!h.sourceIds.has('firms'), 'never to the FIRMS source');
    const selected = h.published.find((entry) => entry.selected);
    assert.ok(selected, 'a selected card was painted');
    assert.doesNotMatch(selected.details[0], /conf/, 'no confidence claim without data');
    assert.equal(selected.details.at(-1), 'JACAREACANGA · PARÁ');
  } finally {
    h.cleanup();
  }
});

test('a FIRMS-prefixed pick never selects on the INPE instance, and vice versa', () => {
  const inpe = harness({ namespace: 'inpe', picked: { id: 'firms-7' } });
  try {
    inpe.click();
    assert.equal(inpe.requests.length, 0);
  } finally {
    inpe.cleanup();
  }
  const firms = harness({
    namespace: 'firms',
    picked: { id: 'inpe-7' },
    fires: [makeFire({ feedId: undefined, confidence: 0.9, satellite: 'N21', sensor: 'VIIRS', place: '' })],
  });
  try {
    assert.equal(firms.layer.requiresKeyId, 'firms');
    firms.click();
    assert.equal(firms.requests.length, 0);
  } finally {
    firms.cleanup();
  }
});

test('the FIRMS instance is untouched: firms-N picks, firms overlay, conf shown', () => {
  const h = harness({
    namespace: 'firms',
    picked: { id: 'firms-7' },
    fires: [makeFire({ feedId: undefined, confidence: 0.9, satellite: 'N21', sensor: 'VIIRS', place: '' })],
  });
  try {
    h.click();
    assert.equal(h.requests.length, 1);
    assert.match(h.requests[0].id, /^firms:/);
    assert.ok(h.sourceIds.has('firms'));
    const selected = h.published.find((entry) => entry.selected);
    assert.match(selected.details[0], /^high conf/);
    assert.equal(selected.details.length, 2);
  } finally {
    h.cleanup();
  }
});
