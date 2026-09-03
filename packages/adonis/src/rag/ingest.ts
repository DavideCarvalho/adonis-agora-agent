import {
  type EmbeddingProvider,
  type EmbeddingUsage,
  embedCountingUsage,
} from '../spi/embedding-provider.js';
import { type ChunkOptions, chunkText } from './chunk.js';
import type { VectorRecord, VectorStore } from './vector-store.js';

/** A source document to ingest. `id` scopes the chunk ids (`${id}#${n}`); `source` is the citation. */
export interface IngestDocument {
  id: string;
  text: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

/** A chunked, not-yet-embedded record. */
export interface ChunkRecord {
  id: string;
  text: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface IngestChunksOptions {
  embedder: EmbeddingProvider;
  store: VectorStore;
  /**
   * Chamado com o consumo do lote, quando o provider sabe reportar.
   *
   * É um CALLBACK e não uma gravação no ledger, e a razão é estrutural:
   * `agent_token_usage.thread_id` é NOT NULL com FK para as threads, e uma indexação em lote não
   * acontece dentro de conversa nenhuma. Gravar exigiria afrouxar a FK — decisão de esquema que
   * não cabe num callback de ingestão.
   *
   * Então o gasto de ingestão fica OBSERVÁVEL aqui, para o host contabilizar como preferir (uma
   * métrica, uma tabela própria), em vez de invisível como era. O gasto de RETRIEVAL, que é o
   * recorrente, esse vai para o ledger sozinho — ver o loop.
   */
  onUsage?: (usage: EmbeddingUsage) => void | Promise<void>;
}

export interface IngestOptions extends ChunkOptions, IngestChunksOptions {}

/**
 * Split documents into chunk records. Chunk ids are `${doc.id}#${index}`, so re-chunking the same
 * document produces the same ids (upsert overwrites in place rather than duplicating).
 */
export function chunkDocuments(
  documents: IngestDocument[],
  options: ChunkOptions = {},
): ChunkRecord[] {
  const chunks: ChunkRecord[] = [];
  for (const document of documents) {
    chunkText(document.text, options).forEach((text, index) => {
      chunks.push({
        id: `${document.id}#${index}`,
        text,
        ...(document.source !== undefined ? { source: document.source } : {}),
        ...(document.metadata !== undefined ? { metadata: document.metadata } : {}),
      });
    });
  }
  return chunks;
}

/** Embed pre-chunked records (one batched `embed`) and upsert them. Returns the record count. */
export async function ingestChunks(
  chunks: ChunkRecord[],
  options: IngestChunksOptions,
): Promise<number> {
  if (chunks.length === 0) {
    return 0;
  }
  const { vectors: embeddings, usage } = await embedCountingUsage(
    options.embedder,
    chunks.map((chunk) => chunk.text),
  );
  if (usage !== undefined && options.onUsage !== undefined) {
    await options.onUsage(usage);
  }
  const records: VectorRecord[] = chunks.map((chunk, index) => ({
    ...chunk,
    embedding: embeddings[index] ?? [],
  }));
  await options.store.upsert(records);
  return records.length;
}

/** Chunk → embed → upsert in one call. Returns the number of chunks indexed. */
export async function ingestDocuments(
  documents: IngestDocument[],
  options: IngestOptions,
): Promise<number> {
  return ingestChunks(chunkDocuments(documents, options), options);
}
