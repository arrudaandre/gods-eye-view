import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createGeoFeatureLayer,
  hierarchyFromRings,
  polygonGraphicsFor,
} from './core.js';

const RING = [
  [-60.0, -3.0],
  [-59.9, -3.0],
  [-59.9, -2.9],
  [-60.0, -2.9],
  [-60.0, -3.0],
];

function fakeViewer() {
  const sources = [];
  return {
    dataSources: {
      add: (source) => {
        sources.push(source);
        return Promise.resolve(source);
      },
      remove: (source) => {
        const index = sources.indexOf(source);
        if (index >= 0) sources.splice(index, 1);
        return index >= 0;
      },
    },
    scene: { canvas: {}, pick: () => null },
    _sources: sources,
  };
}

function stubServices() {
  const calls = [];
  const store = new Map();
  let selectedId = null;
  return {
    calls,
    store,
    selected: () => selectedId,
    context: {
      registerEntityContext(entity, metadata) {
        entity.__gevContextId = metadata.id;
        store.set(metadata.id, { ...metadata, entity });
      },
      selectEntityContext(entity) {
        selectedId = entity.__gevContextId;
        calls.push(['select', selectedId]);
      },
      clearSelectedEntityContextForLayer(layerId) {
        if (selectedId) calls.push(['clear', layerId]);
        selectedId = null;
      },
      removeEntityContextsForLayer(layerId) {
        for (const [id, record] of store)
          if (record.layerId === layerId) store.delete(id);
      },
    },
    focus: {
      requestWorldFocus(detail) {
        calls.push(['focus', detail.kind, detail.id]);
        return true;
      },
    },
    readout: {
      refreshTrackedReadout(entity) {
        calls.push(['readout', entity.gevLabelModel?.title]);
      },
    },
    render: { governorRequestRender() {} },
  };
}

function fakeHandlerFactory() {
  const handlers = [];
  const factory = () => {
    const handler = {
      setInputAction(callback) {
        handler.callback = callback;
      },
      destroy() {
        handler.destroyed = true;
      },
    };
    handlers.push(handler);
    return handler;
  };
  factory.handlers = handlers;
  return factory;
}

function features() {
  return [
    {
      id: 'a',
      lon: -59.95,
      lat: -2.95,
      kind: 'ground',
      polygons: [[RING]],
    },
    {
      id: 'b',
      lon: -59.5,
      lat: -2.5,
      kind: 'volume',
      polygons: [[RING], [RING]],
    },
    { id: 'c', lon: -59.2, lat: -2.2, kind: 'point', polygons: [] },
    { id: 'd', lon: -59.1, lat: -2.1, kind: 'empty', polygons: [] },
  ];
}

const present = {
  style(feature) {
    if (feature.kind === 'ground') return { fill: '#ff0000' };
    if (feature.kind === 'volume')
      return {
        fill: '#00ff00',
        heightM: 600,
        extrudedHeightM: 1200,
        lowerReference: 'msl',
      };
    if (feature.kind === 'point')
      return {
        marker: { color: '#0000ff', pixelSize: 8 },
        label: { text: 'C' },
      };
    return null;
  },
  describe(feature) {
    return {
      title: `FEATURE ${feature.id.toUpperCase()}`,
      details: [feature.kind],
      accent: '#ffffff',
    };
  },
  analystRecord: (feature, index) => ({ index, id: feature.id }),
  focusKind: 'feature',
};

function build(overrides = {}) {
  const services = stubServices();
  const handlerFactory = fakeHandlerFactory();
  const snapshots = [];
  const layer = createGeoFeatureLayer({
    id: 'test-features',
    name: 'Test Features',
    source: 'TEST',
    feed: {
      async getSnapshot() {
        snapshots.push(1);
        return overrides.payload ?? { features: features(), stale: false };
      },
    },
    present,
    services,
    screenSpaceEventHandlerFactory: handlerFactory,
    isPointerFree: overrides.isPointerFree ?? (() => true),
  });
  return { layer, services, handlerFactory, snapshots };
}

test('graphics helpers drape ground fills and extrude volumes', () => {
  const hierarchy = hierarchyFromRings([RING, RING.slice(0, 2)]);
  assert.equal(hierarchy.positions.length, 5);
  assert.equal(hierarchy.holes.length, 0, 'a two-point hole is dropped');
  assert.equal(hierarchyFromRings([[[1, 2]]]), null);

  const ground = polygonGraphicsFor(hierarchy, { fill: '#ff0000' });
  assert.equal(ground.heightReference, undefined, 'draped: no clamping path');
  assert.equal(ground.height, undefined);
  assert.equal(ground.classificationType, Cesium.ClassificationType.BOTH);
  assert.equal(ground.outline, undefined);

  const volume = polygonGraphicsFor(hierarchy, {
    fill: '#00ff00',
    heightM: 600,
    extrudedHeightM: 1200,
  });
  assert.equal(volume.height, 600);
  assert.equal(volume.extrudedHeight, 1200);
  assert.equal(volume.heightReference, Cesium.HeightReference.NONE);

  const surface = polygonGraphicsFor(hierarchy, {
    fill: '#00ff00',
    extrudedHeightM: 457,
    lowerReference: 'ground',
  });
  assert.equal(surface.heightReference, Cesium.HeightReference.CLAMP_TO_GROUND);
  assert.equal(
    surface.extrudedHeightReference,
    Cesium.HeightReference.RELATIVE_TO_GROUND,
  );
  assert.equal(surface.extrudedHeight, 457);

  const capped = polygonGraphicsFor(hierarchy, {
    fill: '#00ff00',
    heightM: 30000,
    extrudedHeightM: 60000,
  });
  assert.equal(capped.extrudedHeight, 20000);
  assert.ok(capped.height < capped.extrudedHeight);
});

test('update builds one entity per ring set and marker, registers contexts and reports stats', async () => {
  const { layer, services } = build();
  const viewer = fakeViewer();
  layer.init(viewer);
  assert.equal(viewer._sources.length, 1);
  assert.equal(await layer.update(), false, 'disabled layers never fetch');
  layer.enable();
  assert.equal(await layer.update(), true);
  const entities = viewer._sources[0].entities.values;
  // a: 1 polygon · b: 2 polygons · c: 1 marker · d: nothing
  assert.equal(entities.length, 4);
  assert.deepEqual(layer.getStats(), {
    count: 3,
    lastUpdate: layer.getStats().lastUpdate,
    error: null,
    stale: false,
  });
  assert.ok(Number.isFinite(layer.getStats().lastUpdate));
  assert.deepEqual([...services.store.keys()].sort(), [
    'test-features:a',
    'test-features:b',
    'test-features:c',
  ]);
  const record = services.store.get('test-features:b');
  assert.equal(record.layerName, 'Test Features');
  assert.equal(record.label, 'FEATURE B');
  assert.equal(record.latitude, -2.5);
  assert.equal(record.properties.polygons, undefined);
  assert.deepEqual(layer.getAnalystRecords(2), [
    { index: 0, id: 'a' },
    { index: 1, id: 'b' },
  ]);
  const marker = entities.find((entity) => entity.id === 'test-features:c#m');
  assert.ok(marker.point);
  assert.equal(marker.label.text.getValue(), 'C');
});

test('clicking a feature publishes the readout and a world focus; empty space clears it', async () => {
  const { layer, services, handlerFactory } = build();
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update();
  const handler = handlerFactory.handlers[0];
  const entities = viewer._sources[0].entities.values;
  const second = entities.find((entity) => entity.id === 'test-features:b#1');
  viewer.scene.pick = () => ({ id: second });
  handler.callback({ position: { x: 1, y: 1 } });
  const primary = entities.find((entity) => entity.id === 'test-features:b#0');
  assert.equal(services.selected(), 'test-features:b');
  assert.equal(primary.gevLabelModel.title, 'FEATURE B');
  assert.deepEqual(primary.gevLabelModel.details, ['volume']);
  assert.ok(primary.gevDisplayPosition() instanceof Cesium.Cartesian3);
  assert.deepEqual(services.calls, [
    ['select', 'test-features:b'],
    ['readout', 'FEATURE B'],
    ['focus', 'feature', 'test-features:b'],
  ]);
  assert.equal(layer._selectedFeature().id, 'b');

  // A pick owned by another layer leaves the selection alone.
  viewer.scene.pick = () => ({ id: { __gevFeatureLayerId: 'other' } });
  handler.callback({ position: { x: 1, y: 1 } });
  assert.equal(layer._selectedFeature().id, 'b');

  viewer.scene.pick = () => null;
  handler.callback({ position: { x: 1, y: 1 } });
  assert.equal(layer._selectedFeature(), null);
  assert.equal(services.calls.at(-1)[0], 'clear');
});

test('a pointer owned by a tool is ignored, and disable releases entities but keeps the snapshot', async () => {
  let free = false;
  const { layer, services, handlerFactory, snapshots } = build({
    isPointerFree: () => free,
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update();
  const handler = handlerFactory.handlers[0];
  viewer.scene.pick = () => ({ id: viewer._sources[0].entities.values[0] });
  handler.callback({ position: { x: 1, y: 1 } });
  assert.equal(services.selected(), null);
  free = true;
  handler.callback({ position: { x: 1, y: 1 } });
  assert.equal(services.selected(), 'test-features:a');

  layer.disable();
  assert.equal(viewer._sources[0].entities.values.length, 0);
  assert.equal(services.store.size, 0);
  assert.equal(handler.destroyed, true);
  assert.equal(services.selected(), null);

  layer.enable();
  assert.equal(
    viewer._sources[0].entities.values.length,
    4,
    'enable rebuilds from the cached snapshot without a fetch',
  );
  assert.equal(snapshots.length, 1);
  layer.destroy(viewer);
  assert.equal(viewer._sources.length, 0);
  assert.equal(layer.enable(), false);
});

test('a malformed or failing snapshot keeps the previous entities and reports the error', async () => {
  const { layer } = build({ payload: { nope: true } });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  assert.equal(await layer.update(), false);
  assert.equal(layer.getStats().error, 'Malformed feature snapshot');
  assert.equal(layer.getStats().count, 0);
});
