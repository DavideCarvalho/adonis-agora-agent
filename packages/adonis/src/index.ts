export const VERSION = '0.25.3';

export * from './types.js';
export * from './spi/tool.js';
export * from './base-tool.js';
export * from './spi/model-provider.js';
export * from './spi/token-stream-sink.js';
export * from './spi/agent-store.js';
export * from './spi/roles-policy.js';
export * from './spi/quota-store.js';
export * from './spi/pricing-store.js';
export * from './spi/agent-runner.js';
export * from './spi/actor-resolver.js';
export * from './spi/actor-directory.js';
export * from './actor-labels.js';
export * from './spi/attachment-staging.js';
export * from './spi/governance-queries.js';
export * from './spi/embedding-provider.js';
export * from './spi/retriever.js';
export * from './spi/reranker.js';
export * from './rag/index.js';
export {
  QdrantStore,
  QdrantRetriever,
  chunkIdToPointId,
  buildQdrantFilter,
} from './rag/qdrant-store.js';
export type {
  QdrantClientLike,
  QdrantStoreOptions,
  QdrantMetric,
  QdrantPoint,
  QdrantFilter,
} from './rag/qdrant-store.js';
export type { QdrantRetrieverConfig } from './stores/factory.js';
export * from './rag-media/index.js';
export * from './personas.js';
export { AgentRegistry } from './agent-registry.js';
export {
  ToolRegistry,
  DefaultRolesPolicy,
  ToolForbiddenError,
  ToolNotFoundError,
  ToolInputInvalidError,
} from './tool-registry.js';
export {
  runAgentLoop,
  QuotaExceededError,
  type AgentLoopDeps,
  type AgentLoopHooks,
} from './agent-loop.js';
export {
  invokeWithTransientRetry,
  isTransientToolError,
  DEFAULT_TOOL_TRANSIENT_RETRY_ATTEMPTS,
  DEFAULT_TOOL_TRANSIENT_RETRY_BACKOFF_MS,
} from './tool-retry.js';
export type {
  ToolTransientRetryOptions,
  ToolTransientRetrySetting,
  InvokeWithTransientRetryOptions,
} from './tool-retry.js';
export * from './diagnostics.js';
export { frameToSse } from './sse.js';

// ── Wave 2: Adonis integration shell ─────────────────────────────────────────
export {
  defineConfig,
  stores,
  quotas,
  pricingStores,
  governanceQueries,
  retrievers,
  attachmentStores,
  tokenSinks,
  streamTransports,
  actorDirectories,
} from './define_config.js';
export { lucidStoreConnection } from './stores/factory.js';
export { evaluateGovernanceGate } from './governance-gate.js';
export type { AgentGovernanceAuthorize, GovernanceGateVerdict } from './governance-gate.js';
export { evaluateOwnership } from './ownership.js';
export type { OwnershipVerdict } from './ownership.js';
export type {
  AgentConfig,
  DefaultAgentOptions,
  ModelFactory,
  SinkFactory,
  TokenSinkFactory,
  RedisTokenSinkConfig,
  ActorDirectoryFactory,
  MemoryActorDirectoryConfig,
  QuotaFactory,
  QuotaContext,
  QuotaConfig,
  PricingFactory,
  PricingContext,
  LucidPricingConfig,
  GovernanceQueriesContext,
  GovernanceQueriesFactory,
  LucidGovernanceConfig,
  RetrieverContext,
  RetrieverFactory,
  MemoryRetrieverConfig,
  PgVectorRetrieverConfig,
  EmbeddingFactory,
  AttachmentStagingContext,
  AttachmentStagingFactory,
  StoreContext,
  StoreFactory,
  LucidStoreConfig,
  MemoryStoreConfig,
} from './define_config.js';
export {
  AiTool,
  defineTool,
  readAiToolMeta,
  isBrandedFunctionalTool,
  AI_TOOL_META_KEY,
  AGENT_TOOL_BRAND,
} from './ai-tool-ref.js';
export type {
  AiToolOptions,
  AiToolMeta,
  ToolClass,
  FunctionalTool,
  BrandedFunctionalTool,
} from './ai-tool-ref.js';
export {
  discoverTools,
  registerToolExport,
  registerFunctionalTool,
  registerToolsFromBarrel,
} from './tool-discovery.js';
export type { ToolsBarrel, RegisteredTool } from './tool-discovery.js';
export {
  AgentDepsFactory,
  delegateToolName,
  normalizeDelegateEdge,
  registerDelegateTools,
} from './agent-deps-factory.js';
export type { AgentDepsFactoryConfig } from './agent-deps-factory.js';
export { utcDay } from './agent-deps.js';
export type { AgentDeps } from './agent-deps.js';
export { InProcessTokenStreamSink } from './in-process-sink.js';
export {
  RedisTokenStreamSink,
  type RedisTokenStreamSinkOptions,
} from './redis-token-stream-sink.js';
export type { RedisStreamClient } from './redis-stream-client.js';
export {
  UnconfiguredActorResolver,
  HeaderActorResolver,
  AuthActorResolver,
  resolveActorResolver,
} from './actor-resolver.js';
export type { AuthActorResolverOptions } from './actor-resolver.js';
export { AgentService } from './agent-service.js';
export type { ChatParams } from './agent-service.js';
export { DefaultToolAuthorizer } from './authorizer.js';
export type { RolesPolicy as ToolAuthorizer } from './spi/roles-policy.js';
export { InlineAgentRunner } from './runners/inline-agent-runner.js';
export { LucidAgentStore } from './stores/lucid.js';
export type {
  LucidAgentStoreOptions,
  LucidDatabaseLike,
  LucidRawRunner,
  LucidRawBindings,
  LucidClientLike,
  LucidQueryBuilderLike,
  LucidInsertBuilderLike,
} from './stores/lucid.js';
export {
  createTableStatements,
  createAgentTables,
  dropTableStatements,
  dropAgentTables,
  ensureAgentTables,
  AGENT_TABLES,
} from './stores/lucid-schema.js';
export { LedgerQuotaStore } from './stores/ledger-quota.js';
export { LucidPricingStore } from './stores/lucid-pricing.js';
export { LucidGovernanceQueries } from './stores/lucid-governance-queries.js';

// ── Data satellite: governed read-only SQL tool ──────────────────────────────
export {
  dataTool,
  SqlValidator,
  SqlValidationError,
  GroupTableAccessPolicy,
  TenantScopeRewriter,
  injectLimit,
  loadSqlParser,
} from './data/index.js';
export type {
  DataToolConfig,
  DataToolResult,
  QueryRunner,
  SqlValidationResult,
  TableAccessPolicy,
  GroupTableAccessConfig,
  TenantScopeConfig,
  SqlParserLike,
} from './data/index.js';

// Re-export the configure hook from the package root so `node ace configure` finds it.
// AdonisJS imports the package MAIN and reads `configure` off the module namespace —
// the `./configure` subpath alone is never consulted.
export { configure } from '../configure.js';
