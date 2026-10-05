import type { MessageAttachment } from '../../../index.js';
import type { AttachmentUploadStrategy, UploadAttachmentOptions } from '../backend.js';
import { type AgentClientOptions, normalizeAgentPath } from '../client.js';
import {
  type AgentRequestError,
  type ErrorAnswer,
  readErrorResponse,
  reportHttpError,
} from '../http-error.js';
import { streamChunks } from './tus.js';

/** Tuning for {@link mediaAttachments}; every field optional. */
export interface MediaAttachmentsOptions {
  /** Bytes per tus `PATCH`. Default 5 MiB. */
  chunkSize?: number;
  /** Attempts per chunk before the upload fails. Default 3. */
  retries?: number;
}

/**
 * Resumable attachment uploads through `@adonis-agora/media`, in one line:
 *
 * ```tsx
 * <AgentProvider attachments={{ upload: mediaAttachments() }}>
 * ```
 *
 * Reuses the client's own connection (origin, path, headers, credentials), so it needs no
 * configuration. Also takes `new AgentClient({ attachments: { upload: mediaAttachments() } })`.
 */
export function mediaAttachments(options: MediaAttachmentsOptions = {}): AttachmentUploadStrategy {
  return (file, uploadOptions, connection) =>
    createMediaUpload({
      ...options,
      baseUrl: connection.baseUrl,
      path: connection.path,
      getHeaders: connection.headers,
      fetch: connection.fetch,
      ...(connection.credentials !== undefined ? { credentials: connection.credentials } : {}),
      ...(connection.onHttpError !== undefined ? { onHttpError: connection.onHttpError } : {}),
    })(file, uploadOptions);
}

/**
 * Where and how {@link createMediaUpload} talks to the server. The connection fields are
 * {@link AgentClientOptions}' — pass the same ones your `AgentClient` gets, so the tus requests
 * carry the same cookies / CSRF header / bearer token as the rest of the chat.
 */
export interface MediaUploadOptions extends AgentClientOptions {
  /** Bytes per tus `PATCH`. Default 5 MiB (the default). */
  chunkSize?: number;
  /** Attempts per chunk before the upload fails. Default 3. */
  retries?: number;
}

/** What `useAttachments({ upload })` and `AgentBackend.uploadAttachment` both take. */
export type AttachmentUpload = (
  file: File,
  options?: UploadAttachmentOptions,
) => Promise<MessageAttachment>;

/**
 * A non-2xx answer from the agent's upload routes. Carries what `AgentHttpError` does — `status`
 * (413 too large, 415 type refused, 404 not yours), the server's `message`, `code` and `body` —
 * as its own class because this subpath is bundled apart from the root entry, where an
 * `instanceof AgentHttpError` would not match a copy. Both satisfy `AgentRequestError`.
 */
export class MediaUploadError extends Error implements AgentRequestError {
  readonly body: unknown;
  readonly code: string | undefined;

  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    statusText: string,
    answer: ErrorAnswer = { body: undefined, message: undefined, code: undefined },
  ) {
    super(
      answer.message ?? `Attachment upload failed: ${method} ${path} → ${status} ${statusText}`,
    );
    this.name = 'MediaUploadError';
    this.body = answer.body;
    this.code = answer.code;
  }
}

interface BeginResponse {
  mediaId: string;
  location: string;
}

/**
 * A resumable `upload` for `useAttachments`, backed by `@adonis-agora/media` on the server
 * (`MediaAttachmentStaging` from `@adonis-agora/agent/media`):
 *
 * 1. `POST <path>/attachments/uploads` — the agent validates the file and opens a tus session the
 *    actor owns;
 * 2. the bytes stream to the media adapter’s own tus endpoint in chunks (`streamChunks`), reporting
 *    progress and honouring the abort signal;
 * 3. `POST <path>/attachments/uploads/:mediaId/complete` — the agent confirms the bytes landed and
 *    answers the `MessageAttachment` the turn will reference by `mediaId`.
 *
 * An aborted or failed upload is discarded server-side (`DELETE`), best effort.
 */
export function createMediaUpload(options: MediaUploadOptions = {}): AttachmentUpload {
  const origin = (options.baseUrl ?? '').replace(/\/$/, '');
  const base = `${origin}${normalizeAgentPath(options.path)}/attachments/uploads`;
  const baseFetch = (): typeof fetch => options.fetch ?? fetch;
  // Every request — the agent's and media's tus PATCHes — rides the same credentials mode.
  const fetchWithCredentials: typeof fetch = (input, init) =>
    baseFetch()(input, {
      ...init,
      ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
    });
  const headers = async (): Promise<Record<string, string>> => ({
    ...options.headers,
    ...((await options.getHeaders?.()) ?? {}),
  });
  const discard = (mediaId: string): void => {
    void (async () => {
      await fetchWithCredentials(`${base}/${encodeURIComponent(mediaId)}`, {
        method: 'DELETE',
        headers: await headers(),
      });
    })().catch(() => undefined);
  };
  const call = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
    const response = await fetchWithCredentials(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(await headers()),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const error = new MediaUploadError(
        response.status,
        method,
        url,
        response.statusText,
        await readErrorResponse(response),
      );
      reportHttpError(options.onHttpError, error);
      throw error;
    }
    return (await response.json()) as T;
  };

  return async (file, { signal, onProgress } = {}) => {
    signal?.throwIfAborted();
    const begun = await call<BeginResponse>('POST', base, {
      filename: file.name,
      contentType: file.type,
      size: file.size,
    });
    const onAbort = () => discard(begun.mediaId);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const location = /^https?:\/\//.test(begun.location)
        ? begun.location
        : `${origin}${begun.location}`;
      await streamChunks(location, file, {
        resume: false,
        fetchImpl: fetchWithCredentials,
        getHeaders: headers,
        ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}),
        ...(options.retries !== undefined ? { retries: options.retries } : {}),
        ...(signal !== undefined ? { signal } : {}),
        onProgress: (sent, total) => onProgress?.(total > 0 ? sent / total : 1),
      });
      signal?.throwIfAborted();
      const attachment = await call<MessageAttachment>(
        'POST',
        `${base}/${encodeURIComponent(begun.mediaId)}/complete`,
      );
      onProgress?.(1);
      return attachment;
    } catch (error) {
      if (!signal?.aborted) discard(begun.mediaId);
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };
}
