import type {
  AttachmentStagingDescription,
  AttachmentStagingStore,
  ListStagedAttachmentsInput,
  ResolveAttachmentInput,
  StageAttachmentInput,
  StagedAttachment,
} from '../spi/attachment-staging.js';
import type { MessageAttachment } from '../types.js';

/** A staged record kept for test assertions (who uploaded what, and the reference it produced). */
export interface StagedRecord {
  mediaId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  actorId: string;
  url: string;
  /** ISO-8601 UTC instant it was staged, off the store's clock. */
  createdAt: string;
}

/** Test seams for {@link InMemoryAttachmentStagingStore}. */
export interface InMemoryAttachmentStagingOptions {
  /** The clock `stage` stamps `createdAt` with. Default: the wall clock. */
  now?: () => Date;
}

/**
 * A fully in-memory {@link AttachmentStagingStore} for tests and the offline demo. It encodes the
 * uploaded bytes into a `data:` URL — a URL the AI SDK's image/file parts fetch inline, with no
 * external object store or presigning — so a staged attachment is immediately model-fetchable. Every
 * `stage` call is recorded in {@link staged} for assertions. Not for production (a real store presigns
 * against S3/GCS or wraps the host's media pipeline).
 */
export class InMemoryAttachmentStagingStore implements AttachmentStagingStore {
  readonly staged: StagedRecord[] = [];
  private now: () => Date;

  constructor(
    private readonly limits: AttachmentStagingDescription = {},
    options: InMemoryAttachmentStagingOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Test affordance: move the clock, so media can be staged days apart in one spec. */
  setClock(now: () => Date): void {
    this.now = now;
  }

  describe(): AttachmentStagingDescription {
    return this.limits;
  }

  /** The staged file `mediaId` names, for the actor that uploaded it only. */
  async resolve(input: ResolveAttachmentInput): Promise<MessageAttachment | null> {
    const record = this.staged.find((entry) => entry.mediaId === input.mediaId);
    if (record === undefined || record.actorId !== input.actor.id) return null;
    return {
      mediaId: record.mediaId,
      url: record.url,
      contentType: record.contentType,
      name: record.filename,
    };
  }

  async stage(input: StageAttachmentInput): Promise<MessageAttachment> {
    const mediaId = `media-${this.staged.length + 1}`;
    const url = `data:${input.contentType};base64,${input.data.toString('base64')}`;
    this.staged.push({
      mediaId,
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      actorId: input.actor.id,
      url,
      createdAt: this.now().toISOString(),
    });
    return {
      mediaId,
      url,
      contentType: input.contentType,
      name: input.filename,
    };
  }

  /** The actor's own uploads, newest first — metadata only, never a url. */
  async list(input: ListStagedAttachmentsInput): Promise<StagedAttachment[]> {
    const entries = this.staged
      .filter((record) => record.actorId === input.actor.id)
      .filter((record) => input.stagedBefore === undefined || record.createdAt < input.stagedBefore)
      .map((record) => ({
        mediaId: record.mediaId,
        name: record.filename,
        contentType: record.contentType,
        sizeBytes: record.sizeBytes,
        createdAt: record.createdAt,
      }))
      // Newest first; equal instants keep the later upload first, as a real store's id order would.
      .reverse()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return input.limit === undefined ? entries : entries.slice(0, input.limit);
  }
}
