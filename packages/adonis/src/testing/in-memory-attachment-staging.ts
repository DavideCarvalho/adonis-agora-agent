import type {
  AttachmentStagingDescription,
  AttachmentStagingStore,
  ResolveAttachmentInput,
  StageAttachmentInput,
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

  constructor(private readonly limits: AttachmentStagingDescription = {}) {}

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
    });
    return {
      mediaId,
      url,
      contentType: input.contentType,
      name: input.filename,
    };
  }
}
