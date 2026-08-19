import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from '../spi/embedding-provider.js';
import type { Passage } from '../spi/retriever.js';
import { EmbeddingRetriever } from './embedding-retriever.js';
import {
  applyMetadataPatch,
  assertRemovalFilter,
  documentIdOf,
  effectivePatchKeys,
  filterDeniesAll,
} from './vector-store.js';
import type {
  IndexedDocument,
  MetadataPatch,
  VectorRecord,
  VectorSearchOptions,
  VectorStore,
} from './vector-store.js';

/** Similarity → Qdrant distance name. Cosine (default), Dot (inner), Euclid (l2). */
export type QdrantMetric = 'cosine' | 'inner' | 'l2';
const DISTANCE: Record<QdrantMetric, string> = { cosine: 'Cosine', inner: 'Dot', l2: 'Euclid' };

export interface QdrantStoreOptions {
  /** Collection name. Default `agent_rag_chunks`. */
  collection?: string;
  /** Embedding width — must match the model (1536 for text-embedding-3-small). Default 1536. */
  dimension?: number;
  /** Similarity metric. Default `cosine`. */
  metric?: QdrantMetric;
  /**
   * Maximum points per upsert request. Large sources become MANY chunks (a ~200-page PDF is
   * ~700 points); sending them in a single request blows the client's default timeout
   * (`@qdrant/js-client-rest`, 300s) because a multi-megabyte body stalls on the way. Slicing into
   * batches keeps every request small and predictable. Default 100 (measured at ~4-6s per batch of
   * 100). Zero or negative → no slicing.
   */
  upsertBatchSize?: number;
}

/** A Qdrant point (UUID id, vector, payload). */
export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

/** A Qdrant filter (the subset this store uses). */
export interface QdrantCondition {
  key: string;
  match: { value: unknown } | { any: unknown[] } | { except: unknown[] };
}
export interface QdrantFilter {
  must?: QdrantCondition[];
}

/**
 * The subset of the `@qdrant/js-client-rest` client {@link QdrantStore} uses — structural, so the
 * package stays an OPTIONAL peer (the factory imports the real client and hands it in) and tests can
 * pass a fake. Mirrors pgvector's `LucidDatabaseLike`.
 */
export interface QdrantClientLike {
  getCollections(): Promise<{ collections: { name: string }[] }>;
  createCollection(
    name: string,
    config: { vectors: { size: number; distance: string } },
  ): Promise<unknown>;
  upsert(collection: string, args: { points: QdrantPoint[] }): Promise<unknown>;
  query(
    collection: string,
    args: {
      query: number[];
      limit: number;
      with_payload: boolean;
      filter?: QdrantFilter;
      score_threshold?: number;
    },
  ): Promise<{ points: { score: number; payload?: Record<string, unknown> }[] }>;
  delete(collection: string, args: { filter: QdrantFilter; wait?: boolean }): Promise<unknown>;
  scroll(
    collection: string,
    args: {
      filter?: QdrantFilter;
      /** `true` for the whole payload, or a key list to transfer only those keys. */
      with_payload: boolean | string[];
      with_vector: boolean;
      limit: number;
      offset?: unknown;
    },
  ): Promise<{ points: { payload?: Record<string, unknown> }[]; next_page_offset?: unknown }>;
  /**
   * Set payload keys on specific points, leaving every other key — and **the vector** — alone. Backs
   * {@link QdrantStore.updateMetadata}; the real `@qdrant/js-client-rest` provides it.
   *
   * OPTIONAL here, mirroring the `expire?` precedent on this package's Redis client shim, so adding it
   * cannot break a host that hand-rolled this structural interface. `updateMetadata` throws a named
   * error rather than degrading if it is absent: the alternative degradation would be scroll-with-vector
   * plus `upsert`, which rewrites the embedding — the exact thing the method promises not to do.
   */
  setPayload?(
    collection: string,
    args: {
      payload: Record<string, unknown>;
      points: string[];
      wait?: boolean;
    },
  ): Promise<unknown>;
  /**
   * Count the points matching a filter WITHOUT transferring them. Backs the chunk count
   * {@link QdrantStore.removeWhere} resolves to — Qdrant's delete response carries no count, and this is
   * an aggregate, not an enumeration: no payloads, no vectors, one cheap round trip. Optional for the
   * same reason as {@link QdrantClientLike.setPayload}; the real `@qdrant/js-client-rest` provides it.
   */
  count?(
    collection: string,
    args: { filter?: QdrantFilter; exact?: boolean },
  ): Promise<{ count: number }>;
}

/**
 * Translates a metadata filter (`Record<string, unknown>`) into a {@link QdrantFilter}, preserving
 * token-ACL semantics: a scalar is an exact match; an array is match-any (set membership — it mirrors
 * pgvector's `jsonb_exists_any`, since Qdrant's `any` tests intersection against a scalar OR an array
 * field); an empty array denies everything (`any: []` never matches). Keys target `metadata.<k>` (the
 * payload nests metadata under `metadata`). Multiple keys are ANDed into `must`. Empty or absent →
 * undefined.
 */
export function buildQdrantFilter(
  filter: Record<string, unknown> | undefined,
): QdrantFilter | undefined {
  if (filter === undefined || Object.keys(filter).length === 0) return undefined;
  const must: QdrantCondition[] = Object.entries(filter).map(([key, value]) => {
    const k = `metadata.${key}`;
    return Array.isArray(value) ? { key: k, match: { any: value } } : { key: k, match: { value } };
  });
  return { must };
}

/** Defensive page ceiling on the scroll loops — guards against a misbehaving client whose
 *  `next_page_offset` never becomes null/undefined (pagination that never terminates). */
const MAX_SCROLL_PAGES = 10_000;

/** The library's fixed UUID namespace for deriving deterministic point ids (RFC 4122 §4.3). */
const NAMESPACE = 'b9d5a5f2-1c3e-5e7a-9b2d-6f4c8a1e0d3b';

/** UUIDv5(NAMESPACE, name) via SHA-1 — deterministic, with no external dependency. */
export function chunkIdToPointId(chunkId: string): string {
  const ns = Buffer.from(NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(chunkId).digest();
  const bytes = hash.subarray(0, 16);
  // readUInt8/writeUInt8 (not indexed access) so this stays clean under noUncheckedIndexedAccess.
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6); // version 5
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8); // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A {@link VectorStore} over Qdrant — the twin of {@link import('./pg-vector-store.js').PgVectorStore}
 * for managed vector databases. It talks to the client through the structural {@link QdrantClientLike}
 * (so `@qdrant/js-client-rest` stays an optional peer). One collection, scoped by payload filter. The
 * chunk id (`${documentId}#<n>`) becomes the point's UUIDv5 and travels back in the payload.
 */
export class QdrantStore implements VectorStore {
  private readonly collection: string;
  private readonly dimension: number;
  private readonly metric: QdrantMetric;
  private readonly upsertBatchSize: number;

  constructor(
    private readonly client: QdrantClientLike,
    options: QdrantStoreOptions = {},
  ) {
    this.collection = options.collection ?? 'agent_rag_chunks';
    this.dimension = options.dimension ?? 1536;
    this.metric = options.metric ?? 'cosine';
    this.upsertBatchSize = options.upsertBatchSize ?? 100;
  }

  /** Idempotent: creates the collection (dimension + metric) if it does not exist yet. */
  async ensureCollection(): Promise<void> {
    const { collections } = await this.client.getCollections();
    if (collections.some((c) => c.name === this.collection)) return;
    await this.client.createCollection(this.collection, {
      vectors: { size: this.dimension, distance: DISTANCE[this.metric] },
    });
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const points: QdrantPoint[] = records.map((r) => ({
      id: chunkIdToPointId(r.id),
      vector: r.embedding,
      payload: {
        id: r.id,
        documentId: documentIdOf(r.id),
        text: r.text,
        ...(r.source !== undefined ? { source: r.source } : {}),
        ...(r.metadata !== undefined ? { metadata: r.metadata } : {}),
      },
    }));
    // Slice into batches: one huge request stalls against the client's 300s timeout (see upsertBatchSize).
    const step = this.upsertBatchSize > 0 ? this.upsertBatchSize : points.length;
    for (let i = 0; i < points.length; i += step) {
      await this.client.upsert(this.collection, { points: points.slice(i, i + step) });
    }
  }

  async search(embedding: number[], options: VectorSearchOptions): Promise<Passage[]> {
    const filter = buildQdrantFilter(options.filter);
    // Euclid (`l2`) is Qdrant's one "smaller is better" metric — Cosine and Dot both order
    // "larger is better", already matching the `VectorStore` contract (`score` higher-is-more-
    // relevant), so only `l2` needs translating. Confirmed against Qdrant's docs
    // (https://qdrant.tech/documentation/concepts/search/ and the API reference mirror at
    // https://qdrant-qdrant-18.mintlify.app/concepts/distance-metrics): Euclid uses `Order::SmallBetter`,
    // and `score_threshold` is checked as `score < threshold` for that ordering — i.e. it's an UPPER
    // bound on distance (points farther than the threshold are excluded), the mirror image of Cosine's
    // lower bound on similarity.
    const isL2 = this.metric === 'l2';
    const result = await this.client.query(this.collection, {
      query: embedding,
      limit: options.topK,
      with_payload: true,
      ...(filter !== undefined ? { filter } : {}),
      // `minScore` is a floor on the (higher-is-better) Passage.score. For l2, score = -distance, so
      // `score >= minScore` <=> `distance <= -minScore` — negate to get the Qdrant (max-distance)
      // threshold. Cosine/inner already return higher-is-better scores, so minScore passes through.
      ...(options.minScore !== undefined
        ? { score_threshold: isL2 ? -options.minScore : options.minScore }
        : {}),
    });
    return result.points.map((point) => {
      const payload = point.payload ?? {};
      const source = payload.source;
      const metadata = payload.metadata;
      return {
        id: String(payload.id),
        text: String(payload.text),
        // Negate Euclid's raw distance (lower-is-better) so `score` stays higher-is-more-relevant,
        // matching the `VectorStore` contract and mirroring PgVectorStore's `-(col <-> ?)` for l2.
        score: isL2 ? -point.score : point.score,
        ...(source !== undefined && source !== null ? { source: String(source) } : {}),
        ...(metadata !== undefined && metadata !== null
          ? { metadata: metadata as Record<string, unknown> }
          : {}),
      };
    });
  }
  async remove(documentId: string): Promise<void> {
    await this.client.delete(this.collection, {
      filter: { must: [{ key: 'documentId', match: { value: documentId } }] },
    });
  }

  /**
   * {@link VectorStore.updateMetadata} — rewrite every chunk's metadata for one document, touching
   * neither `text` nor the **vector**.
   *
   * Qdrant is the one adapter here that cannot do the merge server-side. `set_payload` merges at the TOP
   * level of a point's payload, and this store nests the caller's metadata one level down (under
   * `metadata`, so a filter key is `metadata.<k>` — see {@link buildQdrantFilter}), so a top-level set of
   * `metadata` replaces the whole object rather than merging into it. The merge therefore happens in JS:
   * scroll the document's points for their current metadata, apply the shared
   * {@link import('./vector-store.js').applyMetadataPatch}, write back. Cost: one scroll (payload only,
   * **`with_vector: false`**, and only the two keys needed) plus one `set_payload` per distinct resulting
   * metadata — which is ONE for any corpus built by `chunkDocuments`, since that stamps the same document
   * metadata on every chunk.
   *
   * The vector is untouched by construction, not by care: `set_payload` has no vector field, and the
   * points are never re-`upsert`ed (upsert is the call that would carry a vector). The scroll does not
   * even fetch the vectors, so this method never has one in hand to write back.
   *
   * Point ids are re-derived with {@link chunkIdToPointId} from the chunk id in the payload, so the
   * scroll needs no point id from the response and this store keeps working against a client whose
   * `scroll` returns only payloads.
   *
   * `wait: true` because the returned count is a claim that the writes landed; Qdrant's default is to
   * acknowledge before applying.
   */
  async updateMetadata(documentId: string, patch: MetadataPatch): Promise<number> {
    if (effectivePatchKeys(patch).length === 0) {
      return 0;
    }
    const setPayload = this.client.setPayload?.bind(this.client);
    if (setPayload === undefined) {
      throw new Error(
        'QdrantStore.updateMetadata requires a client with `setPayload` (the real ' +
          '@qdrant/js-client-rest has it). Refusing to fall back to upsert, which would rewrite the ' +
          'embedding this method exists to preserve.',
      );
    }
    // Group by the RESULTING metadata so identical outcomes share one write — the normal case.
    const groups = new Map<string, { metadata: Record<string, unknown>; points: string[] }>();
    let written = 0;
    let offset: unknown = undefined;
    for (let pageCount = 0; ; pageCount++) {
      if (pageCount >= MAX_SCROLL_PAGES) {
        throw new Error(
          'updateMetadata: scroll exceeded MAX_SCROLL_PAGES (the page offset never terminated)',
        );
      }
      const page = await this.client.scroll(this.collection, {
        filter: { must: [{ key: 'documentId', match: { value: documentId } }] },
        with_payload: ['id', 'metadata'],
        with_vector: false,
        limit: 256,
        ...(offset !== undefined ? { offset } : {}),
      });
      for (const point of page.points) {
        const payload = point.payload ?? {};
        const chunkId = payload.id;
        if (chunkId === undefined || chunkId === null) continue;
        const current = payload.metadata;
        const next = applyMetadataPatch(
          current !== undefined && current !== null
            ? (current as Record<string, unknown>)
            : undefined,
          patch,
        );
        const key = JSON.stringify(next);
        const group = groups.get(key) ?? { metadata: next, points: [] };
        group.points.push(chunkIdToPointId(String(chunkId)));
        groups.set(key, group);
        written += 1;
      }
      if (page.next_page_offset === undefined || page.next_page_offset === null) break;
      offset = page.next_page_offset;
    }
    for (const group of groups.values()) {
      await setPayload(this.collection, {
        payload: { metadata: group.metadata },
        points: group.points,
        wait: true,
      });
    }
    return written;
  }

  /**
   * {@link VectorStore.listDocumentIds} — the same scroll {@link QdrantStore.listDocuments} does, but
   * transferring ONE payload key (`documentId`) instead of the whole payload, so the per-chunk metadata
   * blob never crosses the wire or gets parsed. Qdrant has no `DISTINCT`, so the collapse still happens
   * here; what this saves is the payload, which is the bulk of it. Filter comes from the same
   * {@link buildQdrantFilter} `search` uses.
   */
  async listDocumentIds(filter?: Record<string, unknown>): Promise<string[]> {
    const qFilter = buildQdrantFilter(filter);
    const ids = new Set<string>();
    let offset: unknown = undefined;
    for (let pageCount = 0; ; pageCount++) {
      if (pageCount >= MAX_SCROLL_PAGES) {
        throw new Error(
          'listDocumentIds: scroll exceeded MAX_SCROLL_PAGES (the page offset never terminated)',
        );
      }
      const page = await this.client.scroll(this.collection, {
        with_payload: ['documentId'],
        with_vector: false,
        limit: 256,
        ...(qFilter !== undefined ? { filter: qFilter } : {}),
        ...(offset !== undefined ? { offset } : {}),
      });
      for (const point of page.points) {
        const docId = point.payload?.documentId;
        if (docId === undefined || docId === null) continue;
        ids.add(String(docId));
      }
      if (page.next_page_offset === undefined || page.next_page_offset === null) break;
      offset = page.next_page_offset;
    }
    return [...ids];
  }

  /**
   * {@link VectorStore.removeWhere} — ONE filtered `delete`, no enumeration: Qdrant deletes by filter
   * server-side, so this never scrolls the points it is about to remove.
   *
   * Filter parity with {@link QdrantStore.search} is by construction — the same
   * {@link buildQdrantFilter} call produces the predicate for both, so `metadata.<k>` keying, scalar
   * `match.value`, array `match.any` set-membership and the empty-array deny are the same object here as
   * there.
   *
   * It DOES cost one extra round trip that memory and pgvector do not: Qdrant's delete response carries
   * no count, so the chunk count comes from a preceding `count` (an aggregate — no payloads, no vectors,
   * not an enumeration). Consequence worth knowing: the count is taken just before the delete, so under
   * concurrent writes it is a very slightly stale count of what matched, where memory and pgvector return
   * an exact count from the deleting statement itself. The delete is filter-scoped either way; only the
   * reported number can drift.
   */
  async removeWhere(filter: Record<string, unknown>): Promise<number> {
    assertRemovalFilter(filter);
    if (filterDeniesAll(filter)) {
      return 0;
    }
    const count = this.client.count?.bind(this.client);
    if (count === undefined) {
      throw new Error(
        'QdrantStore.removeWhere requires a client with `count` (the real @qdrant/js-client-rest has ' +
          'it) to report how many chunks it removed, because Qdrant’s delete response carries no count.',
      );
    }
    const qFilter = buildQdrantFilter(filter);
    if (qFilter === undefined) {
      // Unreachable: assertRemovalFilter already rejected the only input that yields undefined.
      throw new Error('removeWhere: filtro vazio escapou do assertRemovalFilter');
    }
    const { count: matched } = await count(this.collection, { filter: qFilter, exact: true });
    await this.client.delete(this.collection, { filter: qFilter, wait: true });
    return matched;
  }

  async listDocuments(filter?: Record<string, unknown>): Promise<IndexedDocument[]> {
    const qFilter = buildQdrantFilter(filter);
    const seen = new Map<string, IndexedDocument>();
    let offset: unknown = undefined;
    // Page through the scroll cursor until it is exhausted. A ~1500-chunk corpus is a few pages.
    for (let pageCount = 0; ; pageCount++) {
      if (pageCount >= MAX_SCROLL_PAGES) {
        throw new Error(
          'listDocuments: scroll exceeded MAX_SCROLL_PAGES (the page offset never terminated)',
        );
      }
      const page = await this.client.scroll(this.collection, {
        with_payload: true,
        with_vector: false,
        limit: 256,
        ...(qFilter !== undefined ? { filter: qFilter } : {}),
        ...(offset !== undefined ? { offset } : {}),
      });
      for (const point of page.points) {
        const payload = point.payload ?? {};
        const docId = payload.documentId;
        if (docId === undefined || docId === null) continue;
        const id = String(docId);
        if (seen.has(id)) continue;
        const metadata = payload.metadata;
        seen.set(id, {
          id,
          ...(metadata !== undefined && metadata !== null
            ? { metadata: metadata as Record<string, unknown> }
            : {}),
        });
      }
      if (page.next_page_offset === undefined || page.next_page_offset === null) break;
      offset = page.next_page_offset;
    }
    return [...seen.values()];
  }
}

/** A {@link import('../spi/retriever.js').Retriever} over a {@link QdrantStore}: embeds the query,
 *  then searches Qdrant. Twin of `PgVectorRetriever`. */
export class QdrantRetriever extends EmbeddingRetriever {
  // biome-ignore lint/complexity/noUselessConstructor: not useless — it NARROWS `store` from the base's `VectorStore` to `QdrantStore`, which is this subclass's whole point. Delete it and `new QdrantRetriever(embedder, anyInMemoryStore)` starts compiling.
  constructor(embedder: EmbeddingProvider, store: QdrantStore) {
    super(embedder, store);
  }
}
