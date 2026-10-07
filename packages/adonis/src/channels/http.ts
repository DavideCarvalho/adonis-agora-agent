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
