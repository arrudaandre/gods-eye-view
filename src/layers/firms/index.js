import { createModel } from './model.js';
import { createIngestion } from './ingestion.js';
import { createRendering } from './rendering.js';
import { createCards } from './cards.js';
import { createSelection } from './selection.js';
import { createViewport } from './viewport.js';
import { createLifecycle } from './lifecycle.js';
import { createQueries } from './queries.js';
import { createFirmsState } from './state.js';
import { FIRMS_OVERLAY_SOURCE_ID } from '../../data/firmsLabels.js';

/**
 * Fill in the per-instance identity a second fires feed needs. Everything
 * that used to be the literal 'firms' inside the components — overlay source
 * id, pick-id prefix, sprite-order key, detection-key prefix, the source
 * label written to the context store — hangs off `namespace`, so the INPE
 * Amazon layer can run beside NASA FIRMS without the two instances clobbering
 * each other's cards, picks or context records. With no namespace every
 * default is the shipped FIRMS value, so existing callers are unchanged.
 * @param {Object} [config] - Layer options as passed by the catalog.
 * @returns {Object} Options with namespace-derived defaults filled in.
 */
export function resolveFiresConfig(config = {}) {
  const namespace =
    typeof config.namespace === 'string' && config.namespace.trim()
      ? config.namespace.trim()
      : FIRMS_OVERLAY_SOURCE_ID;
  return {
    ...config,
    namespace,
    overlaySourceId: config.overlaySourceId ?? namespace,
    // Only the NASA feed is key-gated (the proxy answers 503 no_key). A
    // namespaced feed is keyless unless the caller says otherwise, so an
    // open-data instance never shows KEY REQUIRED for a key it does not use.
    requiresKeyId:
      'requiresKeyId' in config
        ? config.requiresKeyId
        : namespace === FIRMS_OVERLAY_SOURCE_ID
          ? 'firms'
          : null,
    contextSource: config.contextSource ?? 'NASA FIRMS',
  };
}

export function createFirmsHelpers({ services }) {
  const config = resolveFiresConfig({});
  const layerState = createFirmsState({ services, config });
  return createModel({ layerState, services, config, components: {} });
}

/** Compose one fire layer with explicit source and scene operations. */
export function createFirmsHeatmapLayer({ services, feed, ...options }) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Fires require a snapshot source');
  const config = resolveFiresConfig(options);
  const layerState = createFirmsState({ services, config });
  const components = {};
  const context = { layerState, services, config, components, feed };
  components.model = createModel(context);
  components.ingestion = createIngestion(context);
  components.rendering = createRendering(context);
  components.cards = createCards(context);
  components.selection = createSelection(context);
  components.viewport = createViewport(context);
  components.lifecycle = createLifecycle(context);
  components.queries = createQueries(context);
  return Object.assign(
    {},
    components.queries.methods,
    components.lifecycle.methods,
    components.ingestion.methods,
  );
}

export { createFirmsSource } from './source.js';
export { createFireAnchors, FIRE_ANCHOR_LIFT_M } from './anchors.js';
export * from '../../data/firmsAdapt.js';
export * from '../../data/firmsLabels.js';
