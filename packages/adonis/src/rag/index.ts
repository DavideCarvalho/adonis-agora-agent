export { type ChunkOptions, chunkText } from './chunk.js';
export { EmbeddingRetriever } from './embedding-retriever.js';
export { matchesFilter } from './filter.js';
export { HttpReranker, type HttpRerankerOptions } from './http-reranker.js';
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
export {
  anyTermTsquery,
  DEFAULT_STOP_WORDS,
  hasSearchSyntax,
  keywordTerms,
} from './lexical-query.js';
export { LexicalRetriever } from './lexical-retriever.js';
export { cosineSimilarity, MemoryVectorStore } from './memory-vector-store.js';
export {
  HttpModelError,
  type OpenAiEmbeddingsOptions,
  openAiEmbeddings,
} from './openai-embeddings.js';
export {
  type PgFullTextOptions,
  PgLexicalVectorStore,
  type PgVectorColumns,
  type PgVectorMetric,
  PgVectorRetriever,
  PgVectorStore,
  type PgVectorStoreOptions,
  stripNulBytes,
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
  isLexicalVectorStore,
  type LexicalVectorStore,
  type MetadataPatch,
  UnsafeRemovalError,
  type VectorRecord,
  type VectorSearchOptions,
  type VectorStore,
} from './vector-store.js';
