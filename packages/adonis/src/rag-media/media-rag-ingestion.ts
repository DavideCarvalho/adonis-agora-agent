import diagnostics_channel from 'node:diagnostics_channel';
import type { ChunkOptions } from '../rag/chunk.js';
import { chunkDocuments, type IngestDocument, ingestChunks } from '../rag/ingest.js';
import type { VectorStore } from '../rag/vector-store.js';
import type { EmbeddingProvider } from '../spi/embedding-provider.js';
import {
  publishRagMediaFailed,
  publishRagMediaIngested,
  publishRagMediaRemoved,
  publishRagMediaSkipped,
} from './diagnostics.js';
import {
  envelopePayload,
  isUploadCompleteEvent,
  UPLOAD_COMPLETE_CHANNEL,
  type UploadCompletePayload,
} from './media-events.js';
import {
  defaultTextExtractor,
  normalizeContentType,
  type TextExtractor,
  UnsupportedContentTypeError,
} from './text-extractor.js';

/** The minimal, structural slice of an `@adonis-agora/media` disk this bridge reads bytes from. */
export interface DiskBytesReader {
  /** Return the object's raw bytes (a media disk's `getBytes(key)`). */
  getBytes(key: string): Promise<Uint8Array>;
}

/**
 * The minimal, structural slice of an `@adonis-agora/media` `MediaManager` this bridge needs — just
 * `disk(name)` yielding a {@link DiskBytesReader}. Structural typing keeps `@adonis-agora/media` an
 * OPTIONAL peer: nothing is imported from it, an app passes its live `MediaManager` (or any handle that
 * satisfies this shape) at wiring time.
 */
export interface MediaManagerHandle {
  disk(name?: string): DiskBytesReader;
}

/**
 * A media file to ingest. `id` becomes the RAG document id (chunk ids `${id}#<n>`); `disk`/`key` locate
 * the bytes through the {@link MediaManagerHandle}; `contentType` drives extractor dispatch. The owner /
 * tenant fields are optional and, when present, tag every chunk's metadata so retrieval can filter by
 * tenant/owner/collection.
 */
export interface MediaRef {
  id: string;
  disk: string;
  key: string;
  contentType: string;
  ownerType?: string;
  ownerId?: string;
  collection?: string;
  tenantRef?: string;
  /** Byte size, when known up front — used only by the `maxBytes` gate; the bytes are the source of truth. */
  size?: number;
}

export type MediaIngestSkipReason = 'unsupported-type' | 'too-large' | 'empty-text';

export type MediaIngestResult =
  | { status: 'ingested'; chunks: number }
  | { status: 'skipped'; reason: MediaIngestSkipReason };

/** Turn an `upload.complete` diagnostics payload into an ingestable {@link MediaRef}, or `null` to skip. */
export type ResolveMediaRef = (
  payload: UploadCompletePayload,
) => MediaRef | null | Promise<MediaRef | null>;

/**
 * Everything the media→RAG bridge needs. Only `media`, `embedder`, and `store` are required; the
 * extractor defaults to {@link defaultTextExtractor} (text/*, JSON, HTML) so binary formats are skipped
 * rather than indexed as garbage. Register a PDF/DOCX parser on a {@link import('./text-extractor.js').MimeTextExtractor}
 * and pass it as `extractor` — the PDF library stays entirely on the host side (never a dependency here).
 */
export interface MediaRagIngestionConfig {
  /** The media handle bytes are read through (an `@adonis-agora/media` `MediaManager`, structurally typed). */
  media: MediaManagerHandle;
  /** Embeds each chunk. Pass the same {@link EmbeddingProvider} the agent's retriever uses. */
  embedder: EmbeddingProvider;
  /** The RAG vector store chunks are upserted into (the same store the retriever searches). */
  store: VectorStore;
  /** Bytes → text. Default {@link defaultTextExtractor}. Register a PDF/DOCX hook to widen it. */
  extractor?: TextExtractor;
  /**
   * Restrict ingestion to these content types (checked before the extractor). Omit/empty = every type
   * the extractor supports. A content type not in this allow-list is skipped as `unsupported-type`.
   */
  contentTypes?: string[];
  /** Chunking options forwarded to `chunkDocuments`. */
  chunk?: ChunkOptions;
  /** Skip (don't read) files larger than this many bytes (checked against `ref.size` when present). */
  maxBytes?: number;
  /**
   * Resolve an `upload.complete` diagnostics payload (`{ id, disk, key }`) into a full {@link MediaRef}
   * — the seam the auto-subscriber needs, since the event carries no content-type or owner metadata.
   * Required to call {@link MediaRagIngestion.subscribe}; return `null` to skip an event.
   */
  resolve?: ResolveMediaRef;
}

/** Thrown by {@link MediaRagIngestion.subscribe} when no `resolve` seam was configured. */
export class MediaRagResolveRequiredError extends Error {
  constructor() {
    super(
      'mediaRagIngestion: subscribe() needs a `resolve` in the config to turn an upload.complete ' +
        'payload ({ id, disk, key }) into a MediaRef with contentType/owner metadata.',
    );
    this.name = 'MediaRagResolveRequiredError';
  }
}

/**
 * Bridges `@adonis-agora/media` uploads into the agent's RAG stack: fetch the bytes → extract text by
 * content type → chunk → embed → upsert into the configured {@link VectorStore}, tagging every chunk
 * with `{ mediaId, ownerType, ownerId, collection, tenantRef }` so retrieval can be scoped per
 * tenant/owner/collection. Two triggers, both opt-in and no-op until wired:
 *
 * - {@link ingestMedia} — call it explicitly with a {@link MediaRef} (e.g. from your own upload flow).
 * - {@link subscribe} — subscribe to the media library's `agora:media:upload.complete` diagnostics
 *   channel and auto-ingest each finished upload (needs a `resolve` seam).
 *
 * Everything is structural: no import of `@adonis-agora/media`, and `node:diagnostics_channel` is a
 * Node builtin, so there is no hard dependency on `@adonis-agora/diagnostics` for the subscribe path.
 */
export class MediaRagIngestion {
  private readonly extractor: TextExtractor;
  private readonly contentTypes: Set<string> | null;
  private readonly inFlight = new Set<Promise<void>>();
  private teardown: (() => void) | null = null;

  constructor(private readonly config: MediaRagIngestionConfig) {
    this.extractor = config.extractor ?? defaultTextExtractor();
    this.contentTypes =
      config.contentTypes !== undefined && config.contentTypes.length > 0
        ? new Set(config.contentTypes.map((type) => normalizeContentType(type)))
        : null;
  }

  /**
   * Ingest one media file: content-type filter → size gate → read bytes → extract → remove-then-chunk
   * → embed → upsert. Unsupported/oversized/empty files are skipped (not errors). Chunk metadata carries
   * `{ mediaId, ownerType, ownerId, collection, tenantRef }` (only the fields present on `ref`).
   */
  async ingestMedia(ref: MediaRef): Promise<MediaIngestResult> {
    const contentType = normalizeContentType(ref.contentType);

    if (this.contentTypes !== null && !this.contentTypes.has(contentType)) {
      publishRagMediaSkipped({ mediaId: ref.id, contentType, reason: 'unsupported-type' });
      return { status: 'skipped', reason: 'unsupported-type' };
    }

    if (
      this.config.maxBytes !== undefined &&
      ref.size !== undefined &&
      ref.size > this.config.maxBytes
    ) {
      publishRagMediaSkipped({ mediaId: ref.id, contentType, reason: 'too-large' });
      return { status: 'skipped', reason: 'too-large' };
    }

    let text: string;
    try {
      const bytes = await this.config.media.disk(ref.disk).getBytes(ref.key);
      text = await this.extractor.extract(Buffer.from(bytes), ref.contentType);
    } catch (error) {
      if (error instanceof UnsupportedContentTypeError) {
        publishRagMediaSkipped({ mediaId: ref.id, contentType, reason: 'unsupported-type' });
        return { status: 'skipped', reason: 'unsupported-type' };
      }
      throw error;
    }

    if (text.trim() === '') {
      publishRagMediaSkipped({ mediaId: ref.id, contentType, reason: 'empty-text' });
      return { status: 'skipped', reason: 'empty-text' };
    }

    // remove-then-ingest so a re-upload that shrinks to fewer chunks doesn't leave a stale tail.
    await this.config.store.remove(ref.id);
    const document: IngestDocument = {
      id: ref.id,
      text,
      source: ref.key,
      metadata: {
        mediaId: ref.id,
        ...(ref.ownerType !== undefined ? { ownerType: ref.ownerType } : {}),
        ...(ref.ownerId !== undefined ? { ownerId: ref.ownerId } : {}),
        ...(ref.collection !== undefined ? { collection: ref.collection } : {}),
        ...(ref.tenantRef !== undefined ? { tenantRef: ref.tenantRef } : {}),
      },
    };
    const chunks = chunkDocuments([document], this.config.chunk ?? {});
    const count = await ingestChunks(chunks, {
      embedder: this.config.embedder,
      store: this.config.store,
    });
    publishRagMediaIngested({
      mediaId: ref.id,
      chunks: count,
      ...(ref.ownerType !== undefined ? { ownerType: ref.ownerType } : {}),
      ...(ref.ownerId !== undefined ? { ownerId: ref.ownerId } : {}),
      ...(ref.collection !== undefined ? { collection: ref.collection } : {}),
      ...(ref.tenantRef !== undefined ? { tenantRef: ref.tenantRef } : {}),
    });
    return { status: 'ingested', chunks: count };
  }

  /** Drop a media document's chunks from the vector store — the delete half of keeping RAG in sync. */
  async removeMedia(mediaId: string): Promise<void> {
    await this.config.store.remove(mediaId);
    publishRagMediaRemoved({ mediaId });
  }

  /**
   * Guard + resolve + ingest one `upload.complete` diagnostics payload. Public so a caller can await it
   * directly (deterministic tests) instead of going through the subscription. A no-op when `resolve`
   * isn't configured, the payload isn't a valid `upload.complete`, or `resolve` returns `null`.
   */
  async handleUploadComplete(payload: unknown): Promise<MediaIngestResult | undefined> {
    if (this.config.resolve === undefined || !isUploadCompleteEvent(payload)) {
      return undefined;
    }
    const ref = await this.config.resolve(payload);
    if (ref === null) {
      return undefined;
    }
    return this.ingestMedia(ref);
  }

  /**
   * Subscribe to the media library's `agora:media:upload.complete` channel and auto-ingest each finished
   * upload. Idempotent (a second call is a no-op while already subscribed). Returns — and stores — an
   * unsubscribe function; ingestion errors are caught and published on `agora:rag:media.failed` so a bad
   * file never breaks the channel. Requires a `resolve` seam ({@link MediaRagResolveRequiredError}).
   */
  subscribe(): () => void {
    if (this.config.resolve === undefined) {
      throw new MediaRagResolveRequiredError();
    }
    if (this.teardown !== null) {
      return this.teardown;
    }
    const channel = diagnostics_channel.channel(UPLOAD_COMPLETE_CHANNEL);
    const listener = (message: unknown): void => {
      this.track(this.ingestFromEvent(envelopePayload(message)));
    };
    channel.subscribe(listener);
    const teardown = (): void => {
      channel.unsubscribe(listener);
      this.teardown = null;
    };
    this.teardown = teardown;
    return teardown;
  }

  /** Unsubscribe from the media channel (if subscribed) and await every in-flight auto-ingestion. */
  async unsubscribe(): Promise<void> {
    this.teardown?.();
    await this.settle();
  }

  /** Await every in-flight auto-ingestion — for graceful shutdown and deterministic tests. */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  /** Whether the auto-subscriber is currently attached to the media channel. */
  get subscribed(): boolean {
    return this.teardown !== null;
  }

  /** Handle one channel event with the same error boundary the subscriber uses. */
  private async ingestFromEvent(payload: unknown): Promise<void> {
    const mediaId = isUploadCompleteEvent(payload) ? payload.id : 'unknown';
    try {
      await this.handleUploadComplete(payload);
    } catch (error) {
      publishRagMediaFailed({ mediaId, error: errorMessage(error) });
    }
  }

  private track(promise: Promise<void>): void {
    const tracked = promise.finally(() => {
      this.inFlight.delete(tracked);
    });
    this.inFlight.add(tracked);
  }
}

/**
 * Build a media→RAG ingestion bridge (idiomatic factory). Wire it in a provider's `boot()`:
 *
 * ```ts
 * import { mediaRagIngestion } from '@adonis-agora/agent/rag-media'
 *
 * const ingestion = mediaRagIngestion({
 *   media: await app.container.make('media.manager'),
 *   embedder: myEmbedder,
 *   store: myVectorStore,
 *   contentTypes: ['text/plain', 'text/markdown', 'application/pdf'],
 *   extractor: defaultTextExtractor().register('application/pdf', myPdfExtractor),
 *   resolve: async ({ id, disk, key }) => lookupMediaRecord(id), // → MediaRef
 * })
 * const off = ingestion.subscribe() // auto-ingest on upload.complete
 * ```
 *
 * Or trigger it explicitly: `await ingestion.ingestMedia(ref)`. Everything is opt-in and no-op until
 * wired — nothing runs, subscribes, or imports the media/pdf peers unless you call it.
 */
export function mediaRagIngestion(config: MediaRagIngestionConfig): MediaRagIngestion {
  return new MediaRagIngestion(config);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
