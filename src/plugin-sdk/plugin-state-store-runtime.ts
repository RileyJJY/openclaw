/**
 * Keyed plugin-state store factories for deferred runtime consumers.
 *
 * Separate from `plugin-state-runtime`, which stays type-only plus light
 * helpers because hot channel entrypoints import it at module load; opening a
 * store pulls the state-database graph, so only callers that actually read or
 * write state take that cost.
 */

export {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  MAX_PLUGIN_STATE_VALUE_BYTES,
} from "../plugin-state/plugin-state-store.js";
