import type { Passage } from '../spi/retriever.js';
import { matchesFilter } from './filter.js';
import {
  applyMetadataPatch,
  assertRemovalFilter,
  documentIdOf,
  effectivePatchKeys,
  filterDeniesAll,
  type IndexedDocument,
  type MetadataPatch,
  type VectorRecord,
  type VectorSearchOptions,
  type VectorStore,
} from './vector-store.js';

/**
 * An in-process {@link VectorStore} — cosine similarity over a Map, no infra. The reference adapter for
 * tests and small/embedded corpora; a pgvector/Lucid-backed store for production scale is deferred.
 */
export class MemoryVectorStore implements VectorStore {
  private readonly records = new Map<string, VectorRecord>();

  async upsert(records: VectorRecord[]): Promise<void> {
    for (const record of records) {
      this.records.set(record.id, record);
    }
  }

  async remove(documentId: string): Promise<void> {
    for (const id of this.records.keys()) {
      if (documentIdOf(id) === documentId) {
        this.records.delete(id);
      }
    }
  }

  /**
   * {@link VectorStore.updateMetadata} — rewrite every chunk's metadata for one document, touching
   * neither `text` nor `embedding`. Both are carried across by the spread, so the stored `embedding`
   * stays the **same array instance** it was upserted with: nothing here can perturb a vector even in
   * principle. Merge semantics come from the shared {@link applyMetadataPatch}, so this adapter cannot
   * drift from the other two.
   */
  async updateMetadata(documentId: string, patch: MetadataPatch): Promise<number> {
    if (effectivePatchKeys(patch).length === 0) {
      return 0;
    }
    let written = 0;
    for (const [id, record] of this.records) {
      if (documentIdOf(id) !== documentId) {
        continue;
      }
      this.records.set(id, { ...record, metadata: applyMetadataPatch(record.metadata, patch) });
      written += 1;
    }
    return written;
  }

  async listDocuments(filter?: Record<string, unknown>): Promise<IndexedDocument[]> {
    const documents = new Map<string, IndexedDocument>();
    for (const record of this.records.values()) {
      if (filter !== undefined && !matchesFilter(record.metadata, filter)) {
        continue;
      }
      const id = documentIdOf(record.id);
      if (!documents.has(id)) {
        documents.set(id, {
          id,
          ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
        });
      }
    }
    return [...documents.values()];
  }

  /**
   * {@link VectorStore.listDocumentIds} — the ids `listDocuments` would report, without building the
   * per-document metadata entries. Filtering goes through the same {@link matchesFilter} `search` uses.
   */
  async listDocumentIds(filter?: Record<string, unknown>): Promise<string[]> {
    const ids = new Set<string>();
    for (const record of this.records.values()) {
      if (filter !== undefined && !matchesFilter(record.metadata, filter)) {
        continue;
      }
      ids.add(documentIdOf(record.id));
    }
    return [...ids];
  }

  /**
   * {@link VectorStore.removeWhere} — delete every chunk the same filter would let `search` reach.
   * Parity is by construction: the predicate below is the identical {@link matchesFilter} call, on the
   * identical argument, as the one in {@link MemoryVectorStore.search}.
   */
  async removeWhere(filter: Record<string, unknown>): Promise<number> {
    assertRemovalFilter(filter);
    if (filterDeniesAll(filter)) {
      return 0;
    }
    let removed = 0;
    for (const [id, record] of [...this.records]) {
      if (!matchesFilter(record.metadata, filter)) {
        continue;
      }
      this.records.delete(id);
      removed += 1;
    }
    return removed;
  }

  async search(embedding: number[], options: VectorSearchOptions): Promise<Passage[]> {
    const scored: Passage[] = [];
    for (const record of this.records.values()) {
      if (options.filter !== undefined && !matchesFilter(record.metadata, options.filter)) {
        continue;
      }
      const score = cosineSimilarity(embedding, record.embedding);
      // Relevance floor: drop below-threshold passages before the top-K cut, so `minScore` never
      // leaves the returned K padded with weakly-related sources.
      if (options.minScore !== undefined && score < options.minScore) {
        continue;
      }
      scored.push({
        id: record.id,
        text: record.text,
        score,
        ...(record.source !== undefined ? { source: record.source } : {}),
        ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
      });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, options.topK);
  }
}

/** Cosine similarity of two vectors; `0` when either has zero magnitude. Pure. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const valueA = a[index] ?? 0;
    const valueB = b[index] ?? 0;
    dot += valueA * valueB;
    normA += valueA * valueA;
    normB += valueB * valueB;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}
