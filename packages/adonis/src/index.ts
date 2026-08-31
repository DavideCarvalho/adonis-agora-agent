export const VERSION = '0.25.3';

// Re-export the configure hook from the package root so `node ace configure` finds it.
// AdonisJS imports the package MAIN and reads `configure` off the module namespace —
// the `./configure` subpath alone is never consulted.
export { configure } from '../configure.js';
export * from './actor-labels.js';
export type { AuthActorResolverOptions } from './actor-resolver.js';
export {
  AuthActorResolver,
  HeaderActorResolver,
  resolveActorResolver,
  UnconfiguredActorResolver,
} from './actor-resolver.js';
export type { AgentDeps } from './agent-deps.js';
export { utcDay } from './agent-deps.js';
export type { AgentDepsFactoryConfig } from './agent-deps-factory.js';
export {
  AgentDepsFactory,
  delegateToolName,
  normalizeDelegateEdge,
  registerDelegateTools,
} from './agent-deps-factory.js';
export {
  type AgentLoopDeps,
  type AgentLoopHooks,
  QuotaExceededError,
  runAgentLoop,
} from './agent-loop.js';
export { AgentRegistry } from './agent-registry.js';
export type { ChatParams } from './agent-service.js';
export { AgentService } from './agent-service.js';
export type {
  AiToolMeta,
  AiToolOptions,
  BrandedFunctionalTool,
  FunctionalTool,
  ToolClass,
} from './ai-tool-ref.js';
export {
  AGENT_TOOL_BRAND,
  AI_TOOL_META_KEY,
  AiTool,
  defineTool,
  isBrandedFunctionalTool,
  readAiToolMeta,
} from './ai-tool-ref.js';
export { DefaultToolAuthorizer } from './authorizer.js';
export * from './base-tool.js';
export type {
  DataToolConfig,
  DataToolResult,
  GroupTableAccessConfig,
  QueryRunner,
  SqlParserLike,
  SqlValidationResult,
  TableAccessPolicy,
  TenantScopeConfig,
} from './data/index.js';
// ── Data satellite: governed read-only SQL tool ──────────────────────────────
export {
  dataTool,
  GroupTableAccessPolicy,
  injectLimit,
  loadSqlParser,
  SqlValidationError,
  SqlValidator,
  TenantScopeRewriter,
} from './data/index.js';
export type {
  ActorDirectoryFactory,
  AgentConfig,
  AttachmentStagingContext,
  AttachmentStagingFactory,
  DefaultAgentOptions,
  EmbeddingFactory,
  GovernanceQueriesContext,
  GovernanceQueriesFactory,
  LucidGovernanceConfig,
  LucidPricingConfig,
  LucidStoreConfig,
  MemoryActorDirectoryConfig,
  MemoryRetrieverConfig,
  MemoryStoreConfig,
  ModelFactory,
  PgVectorRetrieverConfig,
  PricingContext,
  PricingFactory,
  QuotaConfig,
  QuotaContext,
  QuotaFactory,
  RedisTokenSinkConfig,
  RetrieverContext,
  RetrieverFactory,
  SinkFactory,
  StoreContext,
  StoreFactory,
  TokenSinkFactory,
} from './define_config.js';
// ── Wave 2: Adonis integration shell ─────────────────────────────────────────
export {
  actorDirectories,
  attachmentStores,
  defineConfig,
  governanceQueries,
  pricingStores,
  quotas,
  retrievers,
  stores,
  streamTransports,
  tokenSinks,
} from './define_config.js';
export * from './diagnostics.js';
export type { AgentGovernanceAuthorize, GovernanceGateVerdict } from './governance-gate.js';
export { evaluateGovernanceGate } from './governance-gate.js';
export { InProcessTokenStreamSink } from './in-process-sink.js';
export type { OwnershipVerdict } from './ownership.js';
export { evaluateOwnership } from './ownership.js';
export * from './personas.js';
export * from './rag/index.js';
export type {
  QdrantClientLike,
  QdrantFilter,
  QdrantMetric,
  QdrantPoint,
  QdrantStoreOptions,
} from './rag/qdrant-store.js';
export {
  buildQdrantFilter,
  chunkIdToPointId,
  QdrantRetriever,
  QdrantStore,
} from './rag/qdrant-store.js';
export * from './rag-media/index.js';
export type { RedisStreamClient } from './redis-stream-client.js';
export {
  RedisTokenStreamSink,
  type RedisTokenStreamSinkOptions,
} from './redis-token-stream-sink.js';
export { InlineAgentRunner } from './runners/inline-agent-runner.js';
export * from './spi/actor-directory.js';
export * from './spi/actor-resolver.js';
export * from './spi/agent-runner.js';
export * from './spi/agent-store.js';
export * from './spi/attachment-staging.js';
export * from './spi/embedding-provider.js';
export * from './spi/governance-queries.js';
export * from './spi/model-provider.js';
export * from './spi/pricing-store.js';
export * from './spi/quota-store.js';
export * from './spi/reranker.js';
export * from './spi/retriever.js';
export type { RolesPolicy as ToolAuthorizer } from './spi/roles-policy.js';
export * from './spi/roles-policy.js';
export * from './spi/token-stream-sink.js';
export * from './spi/tool.js';
export { frameToSse } from './sse.js';
export type { QdrantRetrieverConfig } from './stores/factory.js';
export { lucidStoreConnection } from './stores/factory.js';
export { LedgerQuotaStore } from './stores/ledger-quota.js';
export type {
  LucidAgentStoreOptions,
  LucidClientLike,
  LucidDatabaseLike,
  LucidInsertBuilderLike,
  LucidQueryBuilderLike,
  LucidRawBindings,
  LucidRawRunner,
} from './stores/lucid.js';
export { LucidAgentStore } from './stores/lucid.js';
export { LucidGovernanceQueries } from './stores/lucid-governance-queries.js';
export { LucidPricingStore } from './stores/lucid-pricing.js';
export {
  AGENT_TABLES,
  createAgentTables,
  createTableStatements,
  dropAgentTables,
  dropTableStatements,
  ensureAgentTables,
} from './stores/lucid-schema.js';
export type { RegisteredTool, ToolsBarrel } from './tool-discovery.js';
export {
  discoverTools,
  registerFunctionalTool,
  registerToolExport,
  registerToolsFromBarrel,
} from './tool-discovery.js';
export {
  DefaultRolesPolicy,
  ToolForbiddenError,
  ToolInputInvalidError,
  ToolNotFoundError,
  ToolRegistry,
} from './tool-registry.js';
export type {
  InvokeWithTransientRetryOptions,
  ToolTransientRetryOptions,
  ToolTransientRetrySetting,
} from './tool-retry.js';
export {
  DEFAULT_TOOL_TRANSIENT_RETRY_ATTEMPTS,
  DEFAULT_TOOL_TRANSIENT_RETRY_BACKOFF_MS,
  invokeWithTransientRetry,
  isTransientToolError,
} from './tool-retry.js';
export * from './types.js';
