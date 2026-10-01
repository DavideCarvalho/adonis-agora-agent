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

/**
 * One entry in an actor's staged-media inventory: enough to show the file and to decide whether it
 * has aged out, and nothing more.
 *
 * Carries no url, unlike {@link MessageAttachment}. A url is minted per request by
 * {@link AttachmentStagingStore.resolve} precisely so it can be short-lived; a listing that handed one
 * back would mint a fetchable url for every entry on the page, for a caller that asked to see a file
 * list. Whoever needs the bytes goes through `resolve` and is checked there.
 */
export interface StagedAttachment {
  mediaId: string;
  /** Original filename, as `stage` received it. */
  name: string;
  contentType: string;
  sizeBytes: number;
  /** ISO-8601 UTC instant the bytes were staged — what an age threshold is measured against. */
  createdAt: string;
}

/** Input to {@link AttachmentStagingStore.list} — whose inventory, and how much of it. */
export interface ListStagedAttachmentsInput {
  actor: Actor;
  /**
   * Only media staged strictly before this ISO-8601 UTC instant — how a caller says "old enough to be
   * worth looking at". Freshly staged media belongs to an upload the user has not sent yet, which is
   * in flight rather than garbage, and how long a composer may sit open is the host's knowledge.
   */
  stagedBefore?: string;
  /** Cap on entries returned, newest first. */
  limit?: number;
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
  /**
   * OPTIONAL: the actor's staged media, newest first — including uploads that were never sent, which
   * no thread can show. The host staged these bytes, so only the host's store can enumerate them; this
   * library holds references, never an inventory.
   *
   * Pairs with `AgentStore.referencedMediaIds`, which answers the half only the library can: of these
   * ids, which a live (or queued) message still carries. Together they are a sweep —
   * `AgentService.collectableAttachments`. Deleting what it returns is the host's call alone; this
   * library never removes a host's bytes.
   *
   * Scoped to `input.actor` without exception: an implementation that ignores it turns a file list
   * into a way to read someone else's documents. `stagedBefore` / `limit` are the store's to apply,
   * but the sweep re-applies the age cut on what comes back, since getting it wrong deletes files.
   *
   * Absent → listing and collection answer `501` rather than an empty list: "this host keeps no
   * inventory" and "this actor has no files" are opposite facts that would otherwise look identical.
   */
  list?(input: ListStagedAttachmentsInput): Promise<StagedAttachment[]>;
  /** The size cap and content types this store accepts. Absent → the defaults. */
  describe?(): AttachmentStagingDescription;
}
