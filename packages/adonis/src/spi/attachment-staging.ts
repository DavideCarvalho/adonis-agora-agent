import type { Actor, MessageAttachment } from '../types.js';

/** One uploaded file, as the upload route hands it to {@link AttachmentStagingStore.stage}. */
export interface StageAttachmentInput {
  data: Buffer;
  filename: string;
  contentType: string;
  sizeBytes: number;
  actor: Actor;
}

/** What a chat send names an upload by — the id alone. */
export interface AttachmentRef {
  mediaId: string;
}

/** A request to turn an uploaded file's id into what the model fetches, for one actor. */
export interface ResolveAttachmentInput {
  mediaId: string;
  actor: Actor;
}

/** What {@link AttachmentStagingStore.describe} declares — the rules the upload route enforces. */
export interface AttachmentStagingDescription {
  maxBytes?: number;
  allowedContentTypes?: readonly string[];
  /**
   * How a client uploads to this store — what `GET <path>/config` reports. `'resumable'` when it also
   * serves the tus routes (`POST <path>/attachments/uploads`). Absent → `'multipart'`.
   */
  upload?: 'multipart' | 'resumable';
}

/**
 * Where uploaded attachments live — the seam that makes storage bring-your-own. The upload route
 * hands it the bytes (`stage`); a chat send names uploads by id only (`{ mediaId }`) and the server
 * asks it for the url the model fetches (`resolve`) — a url in the request is never trusted.
 *
 * Shipped: `attachmentStores.media()` over `@adonis-agora/media` (any Drive disk), and
 * `attachmentStores.memory()` for tests and demos. Anything else — a presigning S3 store, the host's
 * own media pipeline — implements these methods.
 */
export interface AttachmentStagingStore {
  /** Store an uploaded file for `actor`; answer the attachment, `mediaId` first. */
  stage(input: StageAttachmentInput): Promise<MessageAttachment>;
  /**
   * The attachment `mediaId` names, with a url the model provider can fetch NOW — or `null` when it
   * is unknown or `actor` may not use it. Called on every send that names it and again when a thread
   * is read back, so a short-lived presigned url is re-minted rather than served dead.
   */
  resolve(input: ResolveAttachmentInput): Promise<MessageAttachment | null>;
  /** The size cap and content types this store accepts. Absent → the defaults. */
  describe?(): AttachmentStagingDescription;
}
