import type { NormalizeConstructor } from '@adonisjs/core/types/helpers';
import type { BaseModel } from '@adonisjs/lucid/orm';
import {
  type EmbeddingProvider,
  type EmbeddingUsage,
  embedCountingUsage,
} from '../spi/embedding-provider.js';
import type { Passage } from '../spi/retriever.js';
import { type ChunkOptions, chunkText } from './chunk.js';
import { ingestChunks } from './ingest.js';
import type { VectorRecord, VectorStore } from './vector-store.js';

type MaybePromise<T> = T | Promise<T>;

/** A required scope key was missing, from the search or from the row. Nothing ran. */
export class RagScopeRequiredError extends Error {
  constructor(model: string, key: string, operation: 'ragSearch' | 'ragIndex' = 'ragSearch') {
    super(`${model}.${operation} needs scope.${key}: this model's chunks are isolated by it`);
    this.name = 'RagScopeRequiredError';
  }
}

export interface WithRagOptions<Row> {
  /** Lazy, so the model file can be imported before the app has booted. */
  store: () => MaybePromise<VectorStore>;
  embedder: () => MaybePromise<EmbeddingProvider>;
  /** The text to index. `null`/empty indexes nothing. Optional if every call passes it to `ragIndex`. */
  text?: (row: Row) => string | null | undefined;
  /** Citation-facing origin of each chunk. */
  source?: (row: Row) => string | null | undefined;
  /** Stored with every chunk, and filterable in `ragSearch`. */
  metadata?: (row: Row) => Record<string, unknown>;
  /**
   * Attributes that isolate this model's chunks, e.g. `['projectId']`. Each is written to the chunk
   * metadata, and `ragSearch` throws {@link RagScopeRequiredError} without it. A caller's `filter` can
   * never override it. This is what stops one tenant's search from reaching another tenant's text.
   */
  scope?: readonly (keyof Row & string)[];
  /** Metadata of one chunk, from its text and the whole document (a page number, say). */
  chunkMetadata?: (chunk: string, fullText: string, row: Row) => Record<string, unknown>;
  chunk?: ChunkOptions;
  /** Keep only the first N chunks: an upper bound on what one huge document can cost. */
  maxChunks?: number;
  /** Embedding spend, indexing and searching alike. The package cannot know who pays for it. */
  onUsage?: (usage: EmbeddingUsage) => void | Promise<void>;
}

export interface RagSearchOptions {
  topK?: number;
  /** Required for every key the model declares in `scope`. An array matches any of its values. */
  scope?: Record<string, unknown>;
  filter?: Record<string, unknown>;
  minScore?: number;
}

/** What the mixin adds to a row. */
export interface RagRow {
  /** Chunk ids are `<ragDocumentId>#<n>`, so two models can share one store. */
  readonly ragDocumentId: string;
  ragIndex(text?: string | null): Promise<number>;
  ragRemove(): Promise<void>;
}

/** What the mixin adds to the model class. */
export interface RagModelStatics {
  ragSearch(query: string, search?: RagSearchOptions): Promise<Passage[]>;
}

/**
 * Declares RAG on a Lucid model, the way `withAuthFinder` declares auth:
 *
 * ```ts
 * class ProjectDocument extends compose(BaseModel, withRag({
 *   store: () => store,
 *   embedder: () => embedder,
 *   text: (doc) => doc.textContent,
 *   scope: ['projectId'],
 * })) {}
 *
 * await doc.ragIndex()
 * await ProjectDocument.ragSearch('question', { scope: { projectId } })
 * ```
 *
 * `row.delete()` removes its chunks. Nothing else does: a database `ON DELETE CASCADE`, a bulk
 * `Model.query().delete()` and `deleteQuietly()` fire no hook, so call `ragRemove` or clean up yourself. Saving does NOT index: embedding is a slow, paid call that has no place in a
 * `save()`, so call `ragIndex` from a job or wherever the text is known to have changed.
 */
// biome-ignore lint/suspicious/noExplicitAny: a model's attributes are only known to the caller
export function withRag<Row = any>(options: WithRagOptions<Row>) {
  const scopeKeys = options.scope ?? [];

  return <T extends NormalizeConstructor<typeof BaseModel>>(
    superclass: T,
    // biome-ignore lint/suspicious/noExplicitAny: the shape TypeScript requires of a mixin constructor
  ): T & RagModelStatics & (new (...args: any[]) => RagRow) => {
    class RagModel extends superclass {
      // `this` is the concrete model here, not this mixin: the hook has to land on the subclass.
      // biome-ignore-start lint/complexity/noThisInStatic: see above
      static override boot() {
        if (Object.hasOwn(this, 'booted') && (this as { booted?: boolean }).booted) return;
        super.boot();
        this.after('delete', async (row: RagModel) => {
          await row.ragRemove();
        });
      }
      // biome-ignore-end lint/complexity/noThisInStatic: see above

      get ragDocumentId(): string {
        const model = this.constructor as unknown as typeof BaseModel;
        return `${model.table}:${String(this.$primaryKeyValue)}`;
      }

      /**
       * Replaces this row's chunks and returns how many were written. The embeddings come first: if the
       * provider fails, the previous chunks are still there.
       */
      async ragIndex(text?: string | null): Promise<number> {
        const row = this as unknown as Row;
        const model = this.constructor as unknown as typeof BaseModel;
        const full = (text === undefined ? options.text?.(row) : text)?.trim();
        const store = await options.store();
        if (!full) {
          await store.remove(this.ragDocumentId);
          return 0;
        }

        const source = options.source?.(row) ?? undefined;
        const scope = scopeValues(this, scopeKeys);
        for (const key of scopeKeys) {
          // Without it the chunks would be written where no search could ever reach them.
          if (scope[key] === undefined || scope[key] === null) {
            throw new RagScopeRequiredError(model.name, key, 'ragIndex');
          }
        }
        const base = options.metadata?.(row);
        const chunks = chunkText(full, options.chunk)
          .slice(0, options.maxChunks)
          .map((chunk, index) => ({
            id: `${this.ragDocumentId}#${index}`,
            text: chunk,
            ...(source !== undefined ? { source } : {}),
            // Scope last: nothing can retag a chunk to another tenant.
            metadata: { ...base, ...options.chunkMetadata?.(chunk, full, row), ...scope },
          }));

        const documentId = this.ragDocumentId;
        if (chunks.length === 0) {
          await store.remove(documentId);
          return 0;
        }
        return ingestChunks(chunks, {
          embedder: await options.embedder(),
          ...(options.onUsage ? { onUsage: options.onUsage } : {}),
          // `ingestChunks` only upserts, after embedding: that is the moment to drop the old chunks.
          store: {
            upsert: async (records: VectorRecord[]) => {
              await store.remove(documentId);
              await store.upsert(records);
            },
          } as VectorStore,
        });
      }

      async ragRemove(): Promise<void> {
        const store = await options.store();
        await store.remove(this.ragDocumentId);
      }

      static async ragSearch(query: string, search: RagSearchOptions = {}): Promise<Passage[]> {
        const scope = search.scope ?? {};
        for (const key of scopeKeys) {
          if (scope[key] === undefined || scope[key] === null) {
            // biome-ignore lint/complexity/noThisInStatic: the concrete model's name, for the message
            throw new RagScopeRequiredError(this.name, key);
          }
        }
        const embedder = await options.embedder();
        const { vectors, usage } = await embedCountingUsage(embedder, [query]);
        if (usage !== undefined) await options.onUsage?.(usage);
        const store = await options.store();
        return store.search(vectors[0] ?? [], {
          topK: search.topK ?? 5,
          // Scope last: a filter can narrow a search, never widen it past the scope.
          filter: { ...search.filter, ...pick(scope, scopeKeys) },
          ...(search.minScore !== undefined ? { minScore: search.minScore } : {}),
        });
      }
    }
    return RagModel as never;
  };
}

function pick(from: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.map((key) => [key, from[key]]));
}

function scopeValues(row: object, keys: readonly string[]) {
  return pick(row as Record<string, unknown>, keys);
}
