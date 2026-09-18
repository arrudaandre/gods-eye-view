import * as Cesium from 'cesium';

/**
 * @module layers/geofeatures/core
 * @description One lifecycle for "a snapshot of polygons and points from a
 * proxy": DETER alerts, DECEA airspace volumes and whatever comes next. The
 * layer owns a CustomDataSource, rebuilds it from each snapshot, registers
 * every feature in the shared context store, and turns a click into the
 * selected-feature readout card plus a UI-owned camera transfer.
 *
 * Presentation is injected (`present`): the core never knows what a DETER
 * class or a flight level is. Services are injected too, so the layer can be
 * built in `node --test` with stub context/focus owners.
 *
 * Entities are built ONCE per snapshot with constant properties — no
 * CallbackProperty, no per-frame work. A disabled layer drops its entities
 * (a hidden data source is still walked by every visualizer each frame; see
 * localGeojsonCore.js for the measurement) and keeps the parsed snapshot so
 * the next enable rebuilds without a fetch.
 */

const DEFAULT_UPDATE_INTERVAL_MS = 6 * 3600_000;
const FEATURE_EXTRUSION_CAP_M = 20_000;

function requireFunction(value, message) {
  if (typeof value !== 'function') throw new TypeError(message);
  return value;
}

function cssColor(value, alpha, fallback = '#ffffff') {
  let color;
  try {
    color = Cesium.Color.fromCssColorString(String(value || fallback));
  } catch {
    color = null;
  }
  if (!color) color = Cesium.Color.fromCssColorString(fallback);
  return Number.isFinite(alpha) ? color.withAlpha(alpha) : color;
}

/** Ring list ([[lon, lat], ...] per ring, outer first) → PolygonHierarchy. */
export function hierarchyFromRings(rings) {
  if (!Array.isArray(rings) || !rings.length) return null;
  const toPositions = (ring) => {
    const flat = [];
    for (const point of ring) {
      if (!Array.isArray(point)) continue;
      const lon = Number(point[0]);
      const lat = Number(point[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      flat.push(lon, lat);
    }
    return flat.length >= 6 ? Cesium.Cartesian3.fromDegreesArray(flat) : null;
  };
  const outer = toPositions(rings[0]);
  if (!outer) return null;
  // Cesium takes the centre of a ground-clamped polygon to sample terrain;
  // a degenerate ring yields NaN there and stops the whole render loop.
  const center = Cesium.BoundingSphere.fromPoints(outer).center;
  if (
    !Number.isFinite(center.x) ||
    !Number.isFinite(center.y) ||
    !Number.isFinite(center.z)
  )
    return null;
  const holes = [];
  for (let i = 1; i < rings.length; i++) {
    const positions = toPositions(rings[i]);
    if (positions) holes.push(new Cesium.PolygonHierarchy(positions));
  }
  return new Cesium.PolygonHierarchy(outer, holes);
}

/**
 * Polygon graphics for one style. Ground-draped fills classify both terrain
 * and 3D tiles; volumes extrude between two limits, either absolute (MSL) or
 * relative to the ground under the polygon (SFC-based airspace).
 */
export function polygonGraphicsFor(hierarchy, style) {
  const fill = cssColor(style.fill, style.fillAlpha ?? 0.35);
  const outline = cssColor(
    style.outline || style.fill,
    style.outlineAlpha ?? 0.9,
  );
  const upper = Number(style.extrudedHeightM);
  if (!Number.isFinite(upper)) {
    // No height and no heightReference: Cesium then builds a GroundPrimitive
    // that drapes over terrain AND 3D tiles. Setting CLAMP_TO_GROUND here
    // instead routes through TerrainOffsetProperty, which samples the polygon
    // centre and warns (or dies on NaN) — the draped path needs neither.
    return {
      hierarchy,
      material: fill,
      classificationType: Cesium.ClassificationType.BOTH,
      arcType: Cesium.ArcType.GEODESIC,
    };
  }
  const cappedUpper = Math.min(FEATURE_EXTRUSION_CAP_M, Math.max(1, upper));
  const graphics = {
    hierarchy,
    material: fill,
    outline: true,
    outlineColor: outline,
    outlineWidth: 1,
    arcType: Cesium.ArcType.GEODESIC,
    shadows: Cesium.ShadowMode.DISABLED,
  };
  const lower = Number(style.heightM);
  if (style.lowerReference === 'ground') {
    // Bottom follows the surface, top sits `upper` metres above it — what an
    // "SFC to 1500 ft" area means on the ground.
    graphics.height = 0;
    graphics.heightReference = Cesium.HeightReference.CLAMP_TO_GROUND;
    graphics.extrudedHeight = cappedUpper;
    graphics.extrudedHeightReference =
      Cesium.HeightReference.RELATIVE_TO_GROUND;
  } else {
    const base = Number.isFinite(lower) ? Math.max(0, lower) : 0;
    graphics.height = Math.min(base, cappedUpper - 1);
    graphics.extrudedHeight = cappedUpper;
    graphics.heightReference = Cesium.HeightReference.NONE;
    graphics.extrudedHeightReference = Cesium.HeightReference.NONE;
  }
  return graphics;
}

function pointGraphicsFor(marker) {
  return {
    pixelSize: Number.isFinite(marker.pixelSize) ? marker.pixelSize : 6,
    color: cssColor(marker.color, marker.alpha ?? 1),
    outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
    outlineWidth: 1.5,
    heightReference: marker.clampToGround
      ? Cesium.HeightReference.CLAMP_TO_GROUND
      : Cesium.HeightReference.NONE,
    // Never depth-cull the marker against the photoreal mesh; the alerts are
    // tens of hectares and the marker is what makes them findable from afar.
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    distanceDisplayCondition: Number.isFinite(marker.maxDistanceM)
      ? new Cesium.DistanceDisplayCondition(0, marker.maxDistanceM)
      : undefined,
  };
}

function labelGraphicsFor(label, marker) {
  return {
    text: String(label.text || ''),
    font: label.font || '600 12px "Inter", "Segoe UI", sans-serif',
    fillColor: cssColor(label.color || marker?.color, 1),
    outlineColor: Cesium.Color.BLACK.withAlpha(0.9),
    outlineWidth: 3,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    pixelOffset: new Cesium.Cartesian2(0, -14),
    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
    heightReference: marker?.clampToGround
      ? Cesium.HeightReference.CLAMP_TO_GROUND
      : Cesium.HeightReference.NONE,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
      0,
      Number.isFinite(label.maxDistanceM) ? label.maxDistanceM : 200_000,
    ),
  };
}

/**
 * Build one geo-feature layer.
 * @param {object} config
 * @param {string} config.id Stable layer id (also the context-store layerId).
 * @param {string} config.name Panel name.
 * @param {string} [config.icon]
 * @param {string} config.source Panel source line.
 * @param {string} [config.contextSource] Source recorded on context records.
 * @param {number} [config.updateInterval]
 * @param {{getSnapshot: function}} config.feed Snapshot feed; the payload must carry `features`.
 * @param {object} config.present Presentation: `style(feature)`, `describe(feature)`, optional `contextLabel`, `analystRecord`, `focusKind`, `anchorHeightM(feature)`.
 * @param {object} config.services `context` (store operations), optional `focus`, `readout`, `render`, `overlayHost` (ambient cards when `present.overlayEntry` exists).
 */
export function createGeoFeatureLayer({
  id,
  name,
  icon = '◆',
  source,
  contextSource = source,
  updateInterval = DEFAULT_UPDATE_INTERVAL_MS,
  feed,
  present,
  services,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
  isPointerFree = () => true,
} = {}) {
  if (!id || !name) throw new TypeError('Geo-feature layers need id and name');
  requireFunction(feed?.getSnapshot, `${id} requires a snapshot feed`);
  requireFunction(present?.style, `${id} requires present.style`);
  requireFunction(present?.describe, `${id} requires present.describe`);
  const context = services?.context;
  for (const method of [
    'registerEntityContext',
    'selectEntityContext',
    'clearSelectedEntityContextForLayer',
    'removeEntityContextsForLayer',
  ]) {
    requireFunction(context?.[method], `${id} requires context.${method}`);
  }
  const requestRender = (reason) =>
    services?.render?.governorRequestRender?.(reason);
  // Ambient cards are optional: a presentation that supplies `overlayEntry`
  // publishes one host entry per feature (river gauges); polygons-only
  // layers (DETER) never touch the overlay host.
  const overlayHost =
    typeof present.overlayEntry === 'function' ? services?.overlayHost : null;
  const overlaySourceId = id;

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _destroyed = false;
  let _request = null;
  let _clickHandler = null;
  /** @type {Array<object>|null} last accepted snapshot, kept across disable */
  let _features = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  /** feature key → {entity, feature} for click resolution and analyst reads */
  const _primaryByKey = new Map();
  let _selected = null;

  function featureKey(feature, index) {
    const key = String(feature?.id ?? '').trim();
    return key || `feature-${index}`;
  }

  function anchorFor(feature, style) {
    const heightM = Number.isFinite(present.anchorHeightM?.(feature, style))
      ? present.anchorHeightM(feature, style)
      : Number.isFinite(style?.extrudedHeightM)
        ? Math.min(FEATURE_EXTRUSION_CAP_M, style.extrudedHeightM)
        : 0;
    return Cesium.Cartesian3.fromDegrees(feature.lon, feature.lat, heightM);
  }

  function tag(entity, key, feature) {
    entity.__gevFeatureLayerId = id;
    entity.__gevFeatureKey = key;
    entity.__gevFeature = feature;
  }

  /** Replace every entity from `features`; contexts are re-registered. */
  function rebuild(features) {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    entities.suspendEvents();
    try {
      entities.removeAll();
      _primaryByKey.clear();
      context.removeEntityContextsForLayer(id);
      _selected = null;
      let count = 0;
      features.forEach((feature, index) => {
        const style = present.style(feature);
        if (!style) return;
        const key = featureKey(feature, index);
        let primary = null;
        const polygons = Array.isArray(feature.polygons)
          ? feature.polygons
          : [];
        polygons.forEach((rings, k) => {
          const hierarchy = hierarchyFromRings(rings);
          if (!hierarchy) return;
          const entity = entities.add({
            id: `${id}:${key}#${k}`,
            polygon: polygonGraphicsFor(hierarchy, style),
          });
          tag(entity, key, feature);
          primary ??= entity;
        });
        if (
          style.marker &&
          Number.isFinite(feature.lon) &&
          Number.isFinite(feature.lat)
        ) {
          const options = {
            id: `${id}:${key}#m`,
            position: Cesium.Cartesian3.fromDegrees(
              feature.lon,
              feature.lat,
              Number.isFinite(style.marker.heightM) ? style.marker.heightM : 0,
            ),
            point: pointGraphicsFor(style.marker),
          };
          if (style.label?.text)
            options.label = labelGraphicsFor(style.label, style.marker);
          const entity = entities.add(options);
          tag(entity, key, feature);
          primary ??= entity;
        }
        if (!primary) return;
        count++;
        _primaryByKey.set(key, { entity: primary, feature, style });
        const copy = present.describe(feature);
        context.registerEntityContext(primary, {
          id: `${id}:${key}`,
          layerId: id,
          layerName: name,
          source: contextSource,
          dataSource: _dataSource,
          label:
            typeof present.contextLabel === 'function'
              ? present.contextLabel(feature)
              : copy.title,
          properties:
            typeof present.contextProperties === 'function'
              ? present.contextProperties(feature)
              : { ...feature, polygons: undefined },
          latitude: feature.lat,
          longitude: feature.lon,
        });
      });
      _count = count;
    } finally {
      entities.resumeEvents();
    }
    publishOverlay();
    requestRender(`${id}-rebuild`);
  }

  /** Republish every feature's ambient card (static positions, no motion). */
  function publishOverlay() {
    if (!overlayHost || !_enabled) return;
    const entries = [];
    for (const [key, record] of _primaryByKey) {
      const entry = present.overlayEntry(record.feature, {
        id: key,
        source: overlaySourceId,
        position: anchorFor(record.feature, record.style),
      });
      if (entry) entries.push(entry);
    }
    overlayHost.setEntries(overlaySourceId, entries, {
      cohortLimit: Math.max(16, entries.length),
      collisionCapacity: Math.max(16, entries.length),
      moving: false,
    });
    overlayHost.setVisible(overlaySourceId, true);
  }

  function pickedRecord(picked) {
    const entity = picked?.id;
    if (!entity || entity.__gevFeatureLayerId !== id) return null;
    return _primaryByKey.get(entity.__gevFeatureKey) || null;
  }

  function clearSelection({ notify = true } = {}) {
    if (!_selected) return;
    _selected = null;
    if (notify) context.clearSelectedEntityContextForLayer(id);
  }

  /** Publish one feature as the selected readout and ask for the camera. */
  function select(record) {
    const { entity, feature, style } = record;
    const copy = present.describe(feature);
    const anchor = anchorFor(feature, style);
    entity.gevLabelModel = {
      title: copy.title,
      details: Array.isArray(copy.details) ? copy.details : [],
      accent: copy.accent,
      selected: true,
    };
    entity.gevDisplayPosition = () => anchor;
    entity.gevTrackedId = `${id}:${record.feature?.id ?? ''}`;
    _selected = record;
    context.selectEntityContext(entity);
    services?.readout?.refreshTrackedReadout?.(entity);
    publishOverlay();
    services?.focus?.requestWorldFocus?.({
      kind: present.focusKind || 'feature',
      id: `${id}:${featureKey(feature, 0)}`,
      label: name,
      position: anchor,
    });
    requestRender(`${id}-select`);
  }

  function installClickHandler() {
    if (_clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (!_enabled || !isPointerFree()) return;
      const picked = _viewer.scene.pick(click.position);
      const record = pickedRecord(picked);
      if (record) {
        select(record);
        return;
      }
      // A pick that belongs to another layer is not "empty space".
      if (picked) return;
      clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    _clickHandler?.destroy();
    _clickHandler = null;
  }

  function releaseEntities() {
    if (!_dataSource) return;
    clearSelection();
    _dataSource.entities.removeAll();
    _primaryByKey.clear();
    context.removeEntityContextsForLayer(id);
  }

  const layer = {
    id,
    name,
    icon,
    source,
    updateInterval,

    init(viewer) {
      if (_viewer) throw new Error(`${id} is already initialized`);
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(id);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost?.setVisible(overlaySourceId, false);
      _enabled = false;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      console.log(`[Data:${name}] Initialized`);
    },

    enable() {
      if (_destroyed) return false;
      _enabled = true;
      if (_dataSource) {
        if (_features && _dataSource.entities.values.length === 0)
          rebuild(_features);
        _dataSource.show = true;
      }
      installClickHandler();
      publishOverlay();
      requestRender(`${id}-enable`);
      return true;
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      removeClickHandler();
      if (_dataSource) _dataSource.show = false;
      releaseEntities();
      overlayHost?.clearSource(overlaySourceId);
      overlayHost?.setVisible(overlaySourceId, false);
      requestRender(`${id}-disable`);
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const payload = await feed.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        const features = Array.isArray(payload?.features)
          ? payload.features
          : null;
        if (!features) throw new Error('Malformed feature snapshot');
        _features = features;
        _stale = payload?.stale === true;
        rebuild(features);
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:${name}] Updated: ${_count} features`);
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn(`[Data:${name}] Fetch error:`, error);
        _lastError = error?.message || `${name} source unavailable`;
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      if (_destroyed) return;
      _destroyed = true;
      _request?.abort();
      _request = null;
      _enabled = false;
      removeClickHandler();
      releaseEntities();
      overlayHost?.clearSource(overlaySourceId);
      overlayHost?.setVisible(overlaySourceId, false);
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      _features = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /** Plain records for the analyst engine; [] while disabled or empty. */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled || typeof present.analystRecord !== 'function') return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const out = [];
      for (const { feature } of _primaryByKey.values()) {
        if (out.length >= limit) break;
        out.push(present.analystRecord(feature, out.length));
      }
      return out;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },

    /** Test seam: the selected feature record, if any. */
    _selectedFeature() {
      return _selected?.feature || null;
    },
  };
  return layer;
}

/**
 * One ambient "card" entry in the shared world-overlay contract, the shape
 * the local infrastructure layers publish (title + detail lines, keyhole
 * edge fade, horizon cull, no terrain occlusion, placed above the anchor).
 */
export function ambientCardEntry({
  id,
  source,
  position,
  title,
  details = [],
  accent = '#ffffff',
  priority = 0,
  maxDistanceM = 14_000_000,
  interactive = false,
}) {
  return {
    id: String(id),
    source,
    position,
    variant: 'card',
    title: String(title || ''),
    details: details.map((line) => String(line)),
    accent,
    priority,
    collisionGroup: 'ambient-card',
    zIndex: 30,
    interactive,
    minDistance: 0,
    maxDistance: maxDistanceM,
    distanceFadeStartRatio: 250_000 / maxDistanceM,
    distanceScale: {
      near: 250_000,
      nearValue: 1,
      far: 9_000_000,
      farValue: 0.62,
    },
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    placement: 'above',
  };
}
