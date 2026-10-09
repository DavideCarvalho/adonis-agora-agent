/**
 * A2UI (https://a2ui.org, v0.9) for this agent: the `a2uiAdapter()` route (JSON Lines of A2UI
 * messages), and the framework-free pieces it is built from — the `ui` frame → A2UI converter, the
 * builtin → basic-catalog mappings, the catalog export, the inbound action reader. For A2UI over
 * AG-UI, pass `a2ui: true` to `agUiAdapter()`.
 */

export {
  readUiActionText,
  type UiAction,
  type UiActionMessage,
  uiActionSummary,
  uiActionText,
} from '../genui/actions.js';
export { type A2uiAdapterOptions, a2uiAdapter } from './adapter.js';
export {
  A2UI_ACTIVITY_TYPE,
  A2UI_APPROVE_ACTION,
  A2UI_BASIC_CATALOG_ID,
  A2UI_BASIC_CATALOG_IDS,
  A2UI_BASIC_COMPONENTS,
  A2UI_BUILTIN_MAPPERS,
  A2UI_LEGACY_BASIC_CATALOG_ID,
  A2UI_OPERATIONS_KEY,
  A2UI_REJECT_ACTION,
  A2UI_VERSION,
  type A2uiComponent,
  type A2uiMapContext,
  type A2uiMapper,
  type A2uiOptions,
  A2uiProjector,
  type A2uiReplayEntry,
  type A2uiServerMessage,
  type A2uiStoredMessage,
  type A2uiStreamOptions,
  a2uiActivityEvent,
  a2uiApprovalComponents,
  a2uiCatalog,
  a2uiSurfaceId,
  a2uiSurfaceMessages,
  a2uiThreadReplay,
  isA2uiBasicCatalogId,
  negotiateA2uiCatalog,
  readA2uiAction,
  readA2uiClientCapabilities,
  readAgUiA2uiCatalogIds,
  toA2uiComponents,
} from './core.js';
