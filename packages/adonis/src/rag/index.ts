export { type ChunkOptions, chunkText } from './chunk.js';
export { EmbeddingRetriever } from './embedding-retriever.js';
export { matchesFilter } from './filter.js';
export { HybridRetriever, type HybridRetrieverOptions } from './hybrid-retriever.js';
export {
  type ChunkRecord,
  chunkDocuments,
  type IngestChunksOptions,
  type IngestDocument,
  type IngestOptions,
  ingestChunks,
  ingestDocuments,
} from './ingest.js';
export { KeywordRetriever, type KeywordRetrieverOptions } from './keyword-retriever.js';
export { cosineSimilarity, MemoryVectorStore } from './memory-vector-store.js';
export {
  type PgVectorColumns,
  type PgVectorMetric,
  PgVectorRetriever,
  PgVectorStore,
  type PgVectorStoreOptions,
  toVectorLiteral,
} from './pg-vector-store.js';
export {
  RerankingRetriever,
  type RerankingRetrieverOptions,
} from './reranking-retriever.js';
export {
  applyMetadataPatch,
  assertRemovalFilter,
  documentIdOf,
  effectivePatchKeys,
  filterDeniesAll,
  type IndexedDocument,
  type MetadataPatch,
  UnsafeRemovalError,
  type VectorRecord,
  type VectorSearchOptions,
  type VectorStore,
} from './vector-store.js';
