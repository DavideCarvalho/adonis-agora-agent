import { randomUUID } from 'node:crypto';
import type {
  AttachmentStagingDescription,
  AttachmentStagingStore,
  ResolveAttachmentInput,
  StageAttachmentInput,
} from '../spi/attachment-staging.js';
import type { Actor, MessageAttachment } from '../types.js';

/*
 * Chat attachments on `@adonis-agora/media` — after `MediaAttachmentStaging` in
 * `@dudousxd/nestjs-agent/media`. The shapes below are the parts of the media library this uses,
 * declared structurally, so the main entry never needs the (optional) media peer to type-check.
 */

/** A media row — `@adonis-agora/media`'s `MediaRecord`. */
export interface MediaRecordLike {
  id: string;
  ownerType: string;
  ownerId: string;
  collection: string;
  name: string;
  fileName: string;
  mimeType: string;
  size: number;
  disk: string;
  path: string;
  order: number;
  customProperties: Record<string, unknown>;
  conversions: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/** `@adonis-agora/media`'s `MediaStore`, the part used here. */
export interface MediaStoreLike {
  save(record: MediaRecordLike): Promise<MediaRecordLike>;
  find(id: string): Promise<MediaRecordLike | null>;
  delete(id: string): Promise<void>;
  nextOrder(ownerType: string, ownerId: string, collection: string): Promise<number>;
}

/** A Drive disk as `@adonis-agora/media` hands it out, the part used here. */
export interface MediaDiskLike {
  put(key: string, contents: Uint8Array, options?: { contentType?: string }): Promise<void>;
  getBytes(key: string): Promise<Uint8Array>;
  getUrl(key: string): Promise<string>;
  getSignedUrl(
    key: string,
    options?: { expiresIn?: string | number; contentType?: string },
  ): Promise<string>;
  delete(key: string): Promise<void>;
}

/** The agent store, the part used here — which media a live message of this actor carries. */
export interface ReferencedMediaLike {
  referencedMediaIds?(actorRef: string, mediaIds: readonly string[]): Promise<string[]>;
}

/** What {@link MediaAttachmentStaging} is built from. */
export interface MediaAttachmentStagingDeps {
  storage: MediaStorageLike;
  store: MediaStoreLike;
  /** Lets media referenced from the actor's own threads resolve (see `canAccess`). */
  agentStore?: ReferencedMediaLike;
}

/** `@adonis-agora/media`'s `StorageManager`, the part used here. */
export interface MediaStorageLike {
  readonly defaultDisk: string;
  disk(name?: string): MediaDiskLike;
}

/** Options for `attachmentStores.media({ … })`. All optional. */
export interface MediaAttachmentsOptions {
  /** Media collection the uploads go in. Default `agent-attachments`. */
  collection?: string;
  /** Owner type the rows carry (the owner id is the actor id). Default `agent-actor`. */
  ownerType?: string;
  /** Drive disk. Default the media library's default disk. */
  disk?: string;
  /** Per-file size cap. Default 20 MiB. */
  maxBytes?: number;
  /** Content types accepted. Default images (png/jpeg/gif/webp), PDF, plain text, CSV. */
  allowedContentTypes?: readonly string[];
  /**
   * `private` (default): urls are signed and short-lived, re-minted on every read. `public`: the
   * disk's plain url.
   */
  visibility?: 'private' | 'public';
  /** Lifetime of a signed url, in seconds. Default 7 days. */
  urlExpiresInSeconds?: number;
  /** Mint the url yourself (a CDN, a proxy route). Wins over `visibility`. */
  resolveUrl?: (
    record: MediaRecordLike,
    context: { disk: MediaDiskLike },
  ) => string | Promise<string>;
  /**
   * Who may attach a file. By default (`allowed`): the actor that uploaded it, or one a message in
   * one of the actor's OWN threads already carries (a fork, a regenerate) — the latter needs an
   * agent store with `referencedMediaIds`, which both shipped stores have. Widen or narrow it here —
   * e.g. let a support agent attach a customer's upload.
   */
  canAccess?: (input: {
    record: MediaRecordLike;
    actor: Actor;
    allowed: boolean;
  }) => boolean | Promise<boolean>;
  /** Clock and id seams, for tests. */
  clock?: () => Date;
  idGenerator?: () => string;
}

export const DEFAULT_AGENT_MEDIA_COLLECTION = 'agent-attachments';
export const DEFAULT_AGENT_MEDIA_OWNER_TYPE = 'agent-actor';
const DEFAULT_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_ALLOWED_CONTENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
];

/**
 * Chat attachments stored as media rows in their own collection, one owner per actor, on any Drive
 * disk — S3, GCS, R2, the local filesystem. Uploads land at
 * `<ownerType>/<actor>/<collection>/<id>/<file>`; a send names them by id and {@link resolve} mints
 * the url the model fetches: the caller's own `resolveUrl`, a public url, a signed url, or — on a
 * disk that cannot sign — the bytes inline as a `data:` url (logged once: fine for dev, not for
 * production).
 */
export class MediaAttachmentStaging implements AttachmentStagingStore {
  private readonly collection: string;
  private readonly ownerType: string;
  private readonly maxBytes: number;
  private readonly allowed: readonly string[];
  private readonly now: () => Date;
  private readonly newId: () => string;
  private warnedInline = false;

  constructor(
    private readonly deps: MediaAttachmentStagingDeps,
    private readonly options: MediaAttachmentsOptions = {},
  ) {
    this.collection = options.collection ?? DEFAULT_AGENT_MEDIA_COLLECTION;
    this.ownerType = options.ownerType ?? DEFAULT_AGENT_MEDIA_OWNER_TYPE;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.allowed = options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;
    this.now = options.clock ?? (() => new Date());
    this.newId = options.idGenerator ?? (() => randomUUID());
  }

  describe(): AttachmentStagingDescription {
    return { maxBytes: this.maxBytes, allowedContentTypes: this.allowed };
  }

  private get diskName(): string {
    return this.options.disk ?? this.deps.storage.defaultDisk;
  }

  async stage(input: StageAttachmentInput): Promise<MessageAttachment> {
    const id = this.newId();
    const fileName = safeFileName(input.filename);
    const path = `${this.ownerType}/${encodeURIComponent(input.actor.id)}/${this.collection}/${id}/${fileName}`;
    await this.deps.storage
      .disk(this.diskName)
      .put(path, input.data, { contentType: input.contentType });
    const timestamp = this.now();
    const record = await this.deps.store.save({
      id,
      ownerType: this.ownerType,
      ownerId: input.actor.id,
      collection: this.collection,
      name: stripExtension(fileName),
      fileName,
      mimeType: input.contentType,
      size: input.sizeBytes,
      disk: this.diskName,
      path,
      order: await this.deps.store.nextOrder(this.ownerType, input.actor.id, this.collection),
      customProperties: {},
      conversions: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return this.toAttachment(record, { forModel: false });
  }

  /**
   * The attachment for `mediaId`, or `null` when it is unknown or this actor may not use it. The
   * actor may use media they own, and media a message in one of THEIR threads already carries (a
   * fork, a regenerate) — never anything else, unless `canAccess` says so.
   */
  async resolve(input: ResolveAttachmentInput): Promise<MessageAttachment | null> {
    const record = await this.deps.store.find(input.mediaId);
    if (record === null || !this.isOurs(record)) return null;
    if (!(await this.canUse(record, input.actor))) return null;
    return this.toAttachment(record, { forModel: true });
  }

  private async canUse(record: MediaRecordLike, actor: Actor): Promise<boolean> {
    const allowed = await this.defaultAccess(record, actor);
    const custom = this.options.canAccess;
    return custom === undefined ? allowed : (await custom({ record, actor, allowed })) === true;
  }

  private async defaultAccess(record: MediaRecordLike, actor: Actor): Promise<boolean> {
    if (record.ownerId === actor.id) return true;
    const referenced = this.deps.agentStore?.referencedMediaIds?.bind(this.deps.agentStore);
    if (referenced === undefined) return false;
    return (await referenced(actor.id, [record.id])).includes(record.id);
  }

  /** Delete an upload and its row. */
  async remove(mediaId: string): Promise<void> {
    const record = await this.deps.store.find(mediaId);
    if (record === null || !this.isOurs(record)) return;
    await this.deps.storage
      .disk(record.disk)
      .delete(record.path)
      .catch(() => undefined);
    await this.deps.store.delete(record.id);
  }

  private isOurs(record: MediaRecordLike): boolean {
    return record.ownerType === this.ownerType && record.collection === this.collection;
  }

  private async toAttachment(
    record: MediaRecordLike,
    { forModel }: { forModel: boolean },
  ): Promise<MessageAttachment> {
    const base = { mediaId: record.id, contentType: record.mimeType, name: record.fileName };
    const disk = this.deps.storage.disk(record.disk);
    if (this.options.resolveUrl !== undefined) {
      return { ...base, url: await this.options.resolveUrl(record, { disk }) };
    }
    if (this.options.visibility === 'public') {
      return { ...base, url: await disk.getUrl(record.path) };
    }
    try {
      const url = await disk.getSignedUrl(record.path, {
        expiresIn: this.options.urlExpiresInSeconds ?? DEFAULT_URL_TTL_SECONDS,
        contentType: record.mimeType,
      });
      return { ...base, url };
    } catch {
      // A disk that cannot sign (the local filesystem without a signing route).
    }
    if (!forModel) return { ...base, url: '' };
    if (!this.warnedInline) {
      this.warnedInline = true;
      console.warn(
        `[@adonis-agora/agent] disk "${record.disk}" cannot sign urls: attachments reach the model inline (data: urls, persisted with each message). Use a signing disk or resolveUrl in production.`,
      );
    }
    const bytes = await disk.getBytes(record.path);
    return {
      ...base,
      url: `data:${record.mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
    };
  }
}

function safeFileName(filename: string): string {
  const last = filename.split(/[\\/]/).pop() ?? '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point.
  const cleaned = last.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned;
}

function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}
