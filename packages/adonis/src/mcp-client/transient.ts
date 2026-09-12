/**
 * Transient-error classification for an MCP server, in the shape `toolTransientRetry` already speaks
 * (`classify: (error) => boolean`). {@link import('../tool-retry.js').isTransientToolError}
 * recognizes local database lock contention; a remote MCP server fails in a different vocabulary —
 * JSON-RPC error codes, HTTP statuses, socket errors — which is what this adds.
 */

/** JSON-RPC codes whose retry is safe: the request never reached the tool, or its answer was lost. */
const TRANSIENT_JSONRPC_CODES = new Set([-32000, -32001]); // ConnectionClosed, RequestTimeout

/** HTTP statuses the streamable-HTTP transport surfaces for "try again", not "you asked wrong". */
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Socket/DNS failures from `fetch` or a spawned stdio server that a reconnect can clear. */
const TRANSIENT_SYSCALL_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * The SDK reports "you called while there was no transport" as a plain `Error` with no code, so the
 * message is the only marker available. Kept narrow on purpose — a message test that matched more
 * broadly would start retrying a remote tool's ordinary business failures, which are one-shot.
 */
const TRANSIENT_MESSAGES = /^not connected$|connection closed|socket hang up|fetch failed/i;

function hasTransientMcpShape(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  // A tool that answered `isError` failed on its own merits, and its message is text the remote
  // server wrote — matching it against the markers below would let a tool's prose decide whether
  // this side retries. Matched by name rather than `instanceof`, which a second copy of this
  // package (pnpm peer multiplexing, dual ESM/CJS) would not survive.
  if ('name' in error && (error as { name: unknown }).name === 'McpToolCallError') {
    return false;
  }
  const code = 'code' in error ? (error as { code: unknown }).code : undefined;
  if (typeof code === 'number') {
    // `McpError` and the streamable-HTTP transport both surface a `code`, and the two vocabularies
    // never overlap: JSON-RPC codes are negative, HTTP statuses are positive.
    return code < 0 ? TRANSIENT_JSONRPC_CODES.has(code) : TRANSIENT_HTTP_STATUSES.has(code);
  }
  if (typeof code === 'string' && TRANSIENT_SYSCALL_CODES.has(code)) {
    return true;
  }
  const message = 'message' in error ? (error as { message: unknown }).message : undefined;
  return typeof message === 'string' && TRANSIENT_MESSAGES.test(message);
}

/**
 * True for a remote-MCP failure that the same call, made again, may well survive: a dropped
 * connection, a request timeout, a retryable HTTP status, a socket error. Checked on the error and
 * one level of `cause` — `fetch` reports a socket failure as a bare `TypeError` wrapping the real
 * one, the same wrapping core's classifier already unwraps for database drivers.
 *
 * A protocol-level refusal (`InvalidParams`, `MethodNotFound`) and a server-side `InternalError`
 * are deliberately NOT transient: the identical request would be refused identically, so retrying
 * only spends the turn's time budget.
 */
export function isTransientMcpError(error: unknown): boolean {
  if (hasTransientMcpShape(error)) {
    return true;
  }
  if (typeof error === 'object' && error !== null && 'cause' in error) {
    const cause = (error as { cause: unknown }).cause;
    if (cause !== undefined && cause !== error && hasTransientMcpShape(cause)) {
      return true;
    }
  }
  return false;
}
