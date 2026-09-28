import type { Passage } from '../spi/retriever.js';

/** A stored, embedded chunk. `embedding` length must match the store's configured dimensions. */
export interface VectorRecord {
  id: string;
  text: string;
  embedding: number[];
  /** Citation-facing origin (document title, URL, row id). */
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface VectorSearchOptions {
  topK: number;
  /**
   * Metadata filter, passed through from `RetrieveOptions.filter`. A scalar value is exact-match; an
   * array value is match-any (OR / set membership), with an empty array denying everything — the
   * capability-token ACL primitive. See {@link import('./filter.js').matchesFilter}.
   */
  filter?: Record<string, unknown>;
  /**
   * Relevance floor, passed through from `RetrieveOptions.minScore`: results whose `score` is below it
   * are dropped BEFORE the top-K cut (so the K returned are all above the floor). `score` is higher-is-
   * more-relevant (cosine similarity `1 - distance`, or a negated L2/inner distance). Undefined → no
   * floor (unchanged behavior).
   */
  minScore?: number;
}

/**
 * The write + search side of RAG storage. This package ships {@link import('./memory-vector-store.js').MemoryVectorStore}
 * (in-JS cosine, tests + small/embedded corpora); a pgvector/Lucid-backed store is deferred. Pair one
 * with an {@link import('../spi/embedding-provider.js').EmbeddingProvider} via
 * {@link import('./embedding-retriever.js').EmbeddingRetriever} to get a `Retriever`.
 */
export interface VectorStore {
  upsert(records: VectorRecord[]): Promise<void>;
  search(embedding: number[], options: VectorSearchOptions): Promise<Passage[]>;
  /**
   * Delete every chunk belonging to a source document — all records whose id is `${documentId}` or
   * `${documentId}#<n>` (the id scheme {@link import('./ingest.js').chunkDocuments} produces). Use it to
   * drop a document from the index, and before re-ingesting one: `upsert` overwrites matching ids but
   * can't remove chunks a shorter new version no longer produces, so a re-ingest without a preceding
   * `remove` leaves the old tail orphaned.
   */
  remove(documentId: string): Promise<void>;
  /**
   * List the distinct source documents currently indexed (chunk ids collapsed back to their document by
   * stripping the trailing `#<n>`), each with a representative chunk's `metadata`, optionally narrowed
   * by a metadata `filter`.
   */
  listDocuments(filter?: Record<string, unknown>): Promise<IndexedDocument[]>;
  /**
   * OPTIONAL capability. Rewrite a document's metadata **without touching its text or its embeddings**.
   *
   * The update path for a dimension that is genuinely mutable — which collection a document belongs to,
   * who may see it, what it was reclassified as — rather than derived from its content. Without this the
   * only way to change one string is {@link VectorStore.upsert}, which needs the text and a fresh
   * embedding, so a consumer whose documents get re-classified has two bad options: re-embed a whole
   * document to change a label (paying the model bill for a reclassification), or refuse to stamp the
   * mutable dimension onto chunks at all and resolve it at query time — turning a filter the index could
   * have applied into a join the caller has to do. The second is what actually happens, and it is what
   * makes an actor-derived retrieval filter unaffordable: such a filter only pays off if the dimensions
   * it filters on are on the chunks AND can be corrected when they change.
   *
   * `patch` is applied to EVERY chunk of the document (metadata is a document-level property that
   * happens to be stored per chunk), with the **shallow JSON Merge Patch** semantics spelled out on
   * {@link MetadataPatch} — in those words because "patch" alone does not tell a caller whether `null`
   * deletes a key or stores a null. It deletes.
   *
   * Resolves to **the number of chunks written**. An unknown `documentId` writes nothing and returns
   * `0` rather than throwing, matching {@link VectorStore.remove}, which is likewise silent on a
   * document that is not there: this is a reconciliation-shaped call, driven by a loop diffing a source
   * of truth against the index, and such a loop races with ingestion and deletion by construction. A
   * patch with no effective keys also writes nothing and returns `0` — the count is chunks *written*,
   * not chunks *matched*.
   *
   * Optional so a host-written store still compiles; feature-detect with `store.updateMetadata?.(…)`.
   * All three stores this package ships implement it.
   */
  updateMetadata?(documentId: string, patch: MetadataPatch): Promise<number>;
  /**
   * OPTIONAL capability. The distinct source document ids currently indexed, optionally narrowed by a
   * metadata `filter` — {@link VectorStore.listDocuments} without the metadata.
   *
   * Use it when the id set is all you need: a reconciliation diff against your source of truth, a count,
   * a delete list. `listDocuments` has to fetch and JSON-parse a metadata blob **per chunk** just to
   * collapse it to one entry per document, which on a large corpus is most of its cost; implementations
   * here are expected to skip that entirely (a `SELECT DISTINCT` of the id expression, a scroll that
   * transfers one payload key).
   *
   * Filter semantics are **identical to {@link VectorStore.search}** — same builder, empty-array deny
   * included, so an empty-array value yields `[]`.
   *
   * Optional so a host-written store still compiles; feature-detect with `store.listDocumentIds?.(…)`.
   */
  listDocumentIds?(filter?: Record<string, unknown>): Promise<string[]>;
  /**
   * OPTIONAL capability. Delete every chunk matching a metadata `filter` in ONE store round trip, and
   * resolve the number of **chunks** removed.
   *
   * The collection-maintenance primitive: dropping a collection, evicting a tenant, purging a retired
   * audience. Without it, doing any of those means `listDocuments()` — which materialises per-chunk
   * metadata only to collapse it — followed by one {@link VectorStore.remove} per document, so N+1 round
   * trips where one filtered delete would do. (That the Qdrant adapter already needed a defensive page
   * cap on its `listDocuments` scroll is the tell: the enumeration API was being used for something it is
   * not shaped for.)
   *
   * **What it removes is exactly what a {@link VectorStore.search} carrying the same filter could
   * reach** — every implementation here builds the delete predicate with the very same filter builder its
   * `search` uses, so the two cannot drift. It is chunk-scoped, like `search`: for any corpus built by
   * {@link import('./ingest.js').chunkDocuments} — which stamps the document's metadata on every chunk —
   * that is the same thing as whole documents. In the pathological case where chunks of one document
   * carry *different* metadata, this removes the matching chunks and leaves the rest, which is the safe
   * direction: it can never remove more than the filter reaches.
   *
   * Two guard rails, because this is the only method here that destroys data:
   *
   * - **The empty-array deny is honoured, and it means "delete nothing".** `removeWhere({ audience: [] })`
   *   removes zero chunks, exactly as a search with that filter returns none. Treating a deny as "no
   *   filter" would delete the whole corpus — precisely inverted from what the caller asked for.
   * - **The filter must be non-empty.** `removeWhere({})` throws {@link UnsafeRemovalError} instead of
   *   wiping the store, because an empty object is overwhelmingly more likely to be a filter that got
   *   built wrong (a dropped key, an `undefined` scope that vanished on serialisation) than a deliberate
   *   request to delete everything. Deliberate mass deletion stays available and stays explicit: loop
   *   {@link VectorStore.remove} over {@link VectorStore.listDocumentIds}, or use the backend's own drop.
   *
   * Optional so a host-written store still compiles; feature-detect with `store.removeWhere?.(…)`.
   */
  removeWhere?(filter: Record<string, unknown>): Promise<number>;
}

/**
 * OPTIONAL capability: a store that can also search its own full-text index. Lets a
 * {@link import('./lexical-retriever.js').LexicalRetriever} run the lexical half of a hybrid search
 * over the SAME rows (and ids) the vector half searches — no second index to feed. Feature-detect with
 * {@link isLexicalVectorStore}. {@link import('./pg-vector-store.js').PgLexicalVectorStore} implements it.
 */
export interface LexicalVectorStore extends VectorStore {
  /**
   * Rank chunks by full-text relevance to `query`, best first, honouring `filter` exactly as `search`
   * does. `score` is the backend's text rank — not comparable to a vector similarity.
   */
  searchText(query: string, options: VectorSearchOptions): Promise<Passage[]>;
}

/** Whether `store` implements {@link LexicalVectorStore}. */
export function isLexicalVectorStore(store: VectorStore): store is LexicalVectorStore {
  return typeof (store as Partial<LexicalVectorStore>).searchText === 'function';
}

/**
 * A destructive call was refused because its scope could not be trusted. Thrown by
 * {@link VectorStore.removeWhere} — never for a filter that merely matched nothing (that is a legitimate
 * result of `0`), only for one that would have deleted *more* than the caller plausibly meant.
 */
export class UnsafeRemovalError extends Error {
  constructor(
    /** Why the removal was refused. */
    readonly reason: 'empty-filter',
    message: string,
  ) {
    super(message);
    this.name = 'UnsafeRemovalError';
  }
}

/**
 * Guard for {@link VectorStore.removeWhere}: refuse a filter that scopes nothing. Shared so all three
 * stores refuse the same input with the same error, rather than each deciding for itself how much of the
 * corpus an empty object means.
 */
export function assertRemovalFilter(filter: Record<string, unknown>): void {
  if (Object.keys(filter).length === 0) {
    throw new UnsafeRemovalError(
      'empty-filter',
      'removeWhere refused an empty filter: it would delete every chunk in the store, which is far ' +
        'more likely to be a filter built wrong than a deliberate request. For a deliberate wipe, ' +
        'loop `remove` over `listDocumentIds()`, or drop the table/collection.',
    );
  }
}

/**
 * Does this filter deny everything? True when any key carries an **empty array** — no value is a member
 * of the empty set, so nothing can match (see {@link import('./filter.js').matchesFilter}).
 *
 * Every filter builder in this package already encodes that (`matchesFilter` returns false,
 * `buildMetadataWhere` emits a `false` clause, `buildQdrantFilter` emits `any: []`), and the live specs
 * confirm the backends agree. {@link VectorStore.removeWhere} checks it anyway and short-circuits before
 * issuing anything: for the one operation where misreading a deny as "no filter" destroys the corpus, the
 * deny should not depend on a backend's interpretation of an empty set.
 */
export function filterDeniesAll(filter: Record<string, unknown>): boolean {
  return Object.values(filter).some((value) => Array.isArray(value) && value.length === 0);
}

/**
 * A metadata patch, applied by {@link VectorStore.updateMetadata}. **Shallow JSON Merge Patch**
 * (RFC 7396, restricted to one level):
 *
 * - a key with a **non-null** value **replaces** that key's value outright. Values are replaced
 *   *wholesale*, arrays and nested objects included — that is the "shallow" part: `{ tags: ['b'] }`
 *   makes `tags` exactly `['b']`, it does not append to it, and `{ acl: { read: [] } }` replaces the
 *   whole `acl` object rather than merging into it. To edit one field of a nested object, send the
 *   nested object you want.
 * - a key with the value **`null` DELETES that key**. This is the one semantic a caller cannot guess and
 *   will get wrong in the destructive direction, so: `null` removes, it does not store a JSON null.
 * - a key set to `undefined` is **ignored** — treated as absent, since JSON has no `undefined`. A patch
 *   whose every value is `undefined` therefore writes nothing.
 * - a key **not present** in the patch is left alone. That is the point: this is a partial update, not a
 *   replacement of the metadata object.
 *
 * A chunk with no metadata at all gains an object on its first patch, and metadata stays an object
 * afterwards — possibly the empty one, if every key was deleted.
 */
export type MetadataPatch = Record<string, unknown>;

/**
 * The keys of a `patch` that will actually be written — every key whose value is not `undefined`. Shared
 * by all three stores so "an empty patch writes nothing and returns 0" means the same thing on each, and
 * so none of them issues a round trip for a no-op.
 */
export function effectivePatchKeys(patch: MetadataPatch): string[] {
  return Object.keys(patch).filter((key) => patch[key] !== undefined);
}

/**
 * Apply a {@link MetadataPatch} to one chunk's metadata, returning the new metadata object. The single
 * definition of the merge, shared by every store that can do the merge in JS — so the semantics cannot
 * drift between adapters. Pure: the input object is never mutated.
 *
 * Always returns an object (never `undefined`), so a patched chunk has metadata even if it had none
 * before, and an all-deleting patch leaves `{}` rather than a hole. `{}` and absent metadata are
 * indistinguishable to {@link import('./filter.js').matchesFilter} and to pgvector's `@>`, so this costs
 * a caller nothing.
 */
export function applyMetadataPatch(
  metadata: Record<string, unknown> | undefined,
  patch: MetadataPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...metadata };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === undefined) {
      continue; // JSON has no `undefined`; treat it as "key not present".
    }
    if (value === null) {
      delete next[key]; // JSON Merge Patch: null REMOVES the key.
      continue;
    }
    next[key] = value; // Replaced wholesale — shallow, so no recursive merge.
  }
  return next;
}

/** A distinct source document as seen by the index — its id plus a representative chunk's metadata. */
export interface IndexedDocument {
  id: string;
  metadata?: Record<string, unknown>;
}

/** Collapse a chunk id (`${documentId}#<n>`) back to its source document id. */
export function documentIdOf(chunkId: string): string {
  return chunkId.replace(/#\d+$/, '');
}
