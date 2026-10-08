import { createHash, timingSafeEqual } from 'node:crypto';

/** A provider refused (or could not be reached for) a delivery. `status` is its HTTP status, if any. */
export class ChannelDeliveryError extends Error {
  constructor(
    readonly channel: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelDeliveryError';
  }

  /**
   * The provider answered and said no (400, 403, 404, 422): the message was certainly not delivered,
   * so sending something else in its place cannot duplicate it.
   */
  get definite(): boolean {
    return this.status !== null && [400, 403, 404, 422].includes(this.status);
  }
}

/** A file was larger than the attachment limit; it was not (fully) downloaded. */
export class ChannelMediaTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`the file exceeds the ${maxBytes}-byte limit`);
    this.name = 'ChannelMediaTooLargeError';
  }
}

/**
 * GET a file, refusing one past `maxBytes` — by its `content-length` before reading, and by what
 * actually arrives while reading. Throws a {@link ChannelDeliveryError} on a non-2xx.
 */
export async function fetchBytes(
  channel: string,
  fetcher: ChannelFetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ data: Buffer; contentType: string | undefined }> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ChannelDeliveryError(
      channel,
      null,
      `${channel}: download failed (${error instanceof Error ? error.name : 'network error'})`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ChannelDeliveryError(
      channel,
      response.status,
      `${channel}: the provider refused the download (HTTP ${response.status})`,
    );
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ChannelMediaTooLargeError(maxBytes);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ChannelMediaTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  }
  return {
    data: Buffer.concat(chunks),
    contentType: response.headers.get('content-type')?.split(';')[0]?.trim() || undefined,
  };
}

/** Bytes of a base64 string, refusing past `maxBytes` before decoding. */
export function decodeBase64(base64: string, maxBytes: number): Buffer {
  const body = base64.replace(/^data:[^,]*,/, '');
  if (Math.floor((body.length * 3) / 4) - 2 > maxBytes)
    throw new ChannelMediaTooLargeError(maxBytes);
  const data = Buffer.from(body, 'base64');
  if (data.byteLength > maxBytes) throw new ChannelMediaTooLargeError(maxBytes);
  return data;
}

/** A positive number out of a webhook field that may be a number, a numeric string or a Long object. */
export function sizeOf(value: unknown): number | undefined {
  const raw =
    typeof value === 'object' && value !== null && 'low' in value
      ? (value as { low: unknown }).low
      : value;
  const size = typeof raw === 'string' ? Number(raw) : raw;
  return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : undefined;
}

/** Compare two secrets in constant time (over their hashes, so lengths leak nothing either). */
export function safeEqual(supplied: string | undefined | null, expected: string): boolean {
  if (typeof supplied !== 'string' || expected.length === 0) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(supplied), digest(expected)) && supplied === expected;
}

/** The `fetch` adapters use — `globalThis.fetch` unless a test (or a proxy) hands one in. */
export type ChannelFetch = typeof fetch;

/**
 * POST a JSON body. Resolves with the parsed JSON answer (`null` when it is not JSON); throws a
 * {@link ChannelDeliveryError} on a non-2xx or a network failure. The provider's error body is never
 * put in the error — it can echo the message text or credentials.
 */
export async function postJson(
  channel: string,
  fetcher: ChannelFetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (error) {
    throw new ChannelDeliveryError(
      channel,
      null,
      `${channel}: delivery failed (${error instanceof Error ? error.name : 'network error'})`,
    );
  }
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new ChannelDeliveryError(
      channel,
      response.status,
      `${channel}: the provider refused the message (HTTP ${response.status})`,
    );
  }
  try {
    return text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/**
 * POST a `multipart/form-data` body (a file upload). Same answers and errors as {@link postJson}.
 * A `Buffer` field is sent as a file part: `{ data, contentType, filename }`.
 */
export async function postForm(
  channel: string,
  fetcher: ChannelFetch,
  url: string,
  headers: Record<string, string>,
  fields: Record<string, string | { data: Buffer; contentType: string; filename: string }>,
  timeoutMs: number,
): Promise<unknown> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') form.append(key, value);
    else
      form.append(
        key,
        new Blob([new Uint8Array(value.data)], { type: value.contentType }),
        value.filename,
      );
  }
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (error) {
    throw new ChannelDeliveryError(
      channel,
      null,
      `${channel}: delivery failed (${error instanceof Error ? error.name : 'network error'})`,
    );
  }
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new ChannelDeliveryError(
      channel,
      response.status,
      `${channel}: the provider refused the message (HTTP ${response.status})`,
    );
  }
  try {
    return text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/** A file's name when it has none: `image.png`, `document.pdf`. */
export function mediaFilename(media: {
  kind: string;
  contentType?: string | undefined;
  filename?: string | undefined;
}): string {
  if (media.filename !== undefined) return media.filename;
  const extension = (media.contentType?.split('/')[1] ?? 'bin').split(/[;+]/)[0] ?? 'bin';
  return `${media.kind}.${extension}`;
}

/** A query-string parameter of a request's url. */
export function queryParam(url: string, name: string): string | undefined {
  const query = url.indexOf('?');
  if (query === -1) return undefined;
  return new URLSearchParams(url.slice(query + 1)).get(name) ?? undefined;
}

/** `value` when it is a plain object, else `undefined` — for reading untyped webhook bodies. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `value` when it is a non-empty string. */
export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
