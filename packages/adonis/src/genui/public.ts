/** Isomorphic public GenUI contracts and implementation. */

export {
  negotiateCatalog,
  type PreparedUiEmission,
  prepareUiEmission,
  type UiCapabilities,
  validateUiCapabilities,
} from './capabilities.js';
export {
  type Catalog,
  type CatalogOptions,
  COMPONENT_NAME,
  type ComponentDefinition,
  defineCatalog,
  defineComponent,
  type GenuiStreaming,
  toolNameFor,
  toSnakeCase,
} from './catalog.js';
export {
  type GenuiPartialElement,
  type PartialTreeOptions,
  partialTree,
  treeNodeId,
} from './progressive.js';
export {
  type ChartProps,
  type ComponentFactory,
  type ComponentManifest,
  type ComponentPresentation,
  type ComponentRegistry,
  type ComponentRenderer,
  chart,
  createComponent,
  createComponentRegistry,
  snapshotComponentPresentation,
  type TableCell,
  type TableProps,
  table,
  validatePresentationBatch,
} from './registry.js';
export {
  type AjvLike,
  ajvValidator,
  builtinJsonSchemaValidator,
  formatIssues,
  type GenuiIssue,
  type GenuiValidation,
  isStandardSchema,
  type JsonSchema,
  type JsonSchemaValidator,
  type PropsSchema,
  toJsonSchema,
  validateProps,
  validatePropsSync,
} from './schema.js';
export {
  type CatalogTextOptions,
  catalogToModelText,
  componentToText,
  fillTemplate,
  getPath,
  summarizeSchema,
  treeToText,
} from './text.js';
export {
  GENUI_SHOW_TOOL,
  type GenuiCatalogScope,
  type GenuiTool,
  type GenuiToolOutput,
  type GenuiToolsOptions,
  genuiTools,
  jsonStandardSchema,
  type ResolveGenuiCatalog,
  showToolJsonSchema,
} from './tools.js';
export {
  type FlatSpec,
  GENUI_TREE_COMPONENT,
  type GenuiElement,
  type GenuiTreeProps,
  type TreeLimits,
  type TreeSchemaMode,
  treeJsonSchema,
  treeToFlatSpec,
  validateTree,
} from './tree.js';
