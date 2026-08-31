import { EmbeddingRetriever } from '../rag/embedding-retriever.js';
import { MemoryVectorStore } from '../rag/memory-vector-store.js';
import type { VectorStore } from '../rag/vector-store.js';
import {
  type DiskBytesReader,
  type MediaManagerHandle,
  MediaRagIngestion,
  type MediaRagIngestionConfig,
  mediaRagIngestion,
  type ResolveMediaRef,
} from '../rag-media/media-rag-ingestion.js';
import {
  defaultTextExtractor,
  type ExtractFn,
  MimeTextExtractor,
} from '../rag-media/text-extractor.js';
import type { EmbeddingProvider } from '../spi/embedding-provider.js';
import { FakeEmbeddingProvider } from './fake-embedding-provider.js';

/**
 * An in-memory {@link MediaManagerHandle} for tests: bytes are stored in a per-disk `Map`, keyed by the
 * object key. Stands in for an `@adonis-agora/media` `MediaManager` — the media→RAG bridge only reads
 * `disk(name).getBytes(key)`, so this deterministic fake exercises the whole ingestion path offline.
 */
export class FakeMediaManager implements MediaManagerHandle {
  private readonly disks = new Map<string, Map<string, Uint8Array>>();

  /** Seed a file's bytes on a disk. Accepts a string (UTF-8 encoded) or raw bytes. Chainable. */
  put(disk: string, key: string, contents: string | Uint8Array): this {
    const bytes = typeof contents === 'string' ? new TextEncoder().encode(contents) : contents;
    const files = this.disks.get(disk) ?? new Map<string, Uint8Array>();
    files.set(key, bytes);
    this.disks.set(disk, files);
    return this;
  }

  disk(name?: string): DiskBytesReader {
    const diskName = name ?? 'default';
    return {
      getBytes: async (key: string): Promise<Uint8Array> => {
        const bytes = this.disks.get(diskName)?.get(key);
        if (bytes === undefined) {
          throw new Error(`FakeMediaManager: no object "${key}" on disk "${diskName}"`);
        }
        return bytes;
      },
    };
  }
}

/**
 * A fake PDF text extractor for tests — stands in for a real (host-supplied) PDF parser without the
 * dependency. It ignores the bytes and returns fixed text so a test can assert the `application/pdf`
 * hook is invoked. Register it: `defaultTextExtractor().register('application/pdf', fakePdfExtractor())`.
 */
export function fakePdfExtractor(text = 'extracted pdf text'): ExtractFn {
  return () => text;
}

/**
 * Build a fully in-memory media→RAG ingestion for tests: a {@link MemoryVectorStore} + a deterministic
 * {@link FakeEmbeddingProvider} + a {@link FakeMediaManager}, wired into a {@link MediaRagIngestion} and
 * paired with an {@link EmbeddingRetriever} over the same store/embedder (so a test can ingest then
 * retrieve, filtering by tenant/owner metadata). Seed files with `media.put(disk, key, contents)`.
 */
export function inMemoryMediaRagIngestion(
  options: {
    embedder?: EmbeddingProvider;
    store?: VectorStore;
    media?: FakeMediaManager;
    extractor?: MimeTextExtractor;
    contentTypes?: string[];
    resolve?: ResolveMediaRef;
    maxBytes?: number;
  } = {},
): {
  ingestion: MediaRagIngestion;
  store: VectorStore;
  embedder: EmbeddingProvider;
  media: FakeMediaManager;
  retriever: EmbeddingRetriever;
} {
  const embedder = options.embedder ?? new FakeEmbeddingProvider();
  const store = options.store ?? new MemoryVectorStore();
  const media = options.media ?? new FakeMediaManager();
  const config: MediaRagIngestionConfig = {
    media,
    embedder,
    store,
    extractor: options.extractor ?? defaultTextExtractor(),
    ...(options.contentTypes !== undefined ? { contentTypes: options.contentTypes } : {}),
    ...(options.resolve !== undefined ? { resolve: options.resolve } : {}),
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
  };
  return {
    ingestion: mediaRagIngestion(config),
    store,
    embedder,
    media,
    retriever: new EmbeddingRetriever(embedder, store),
  };
}
