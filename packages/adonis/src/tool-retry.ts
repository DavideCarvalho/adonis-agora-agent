import { ToolPreflightDeniedError } from './tool-registry.js';

/**
 * Transient tool-error classification + the retry loop that wraps a tool's own invocation. A
 * classified-transient error (a DB deadlock, a lock-wait timeout, a serialization failure) means the
 * server rolled the tool's work back — retrying THAT class is safe, unlike a tool's general business
 * failure, which stays a one-shot outcome (no durable step retries: a tool may not be idempotent).
 *
 * `runAgentLoop` wraps `registry.invoke(...)` with {@link invokeWithTransientRetry} INSIDE the
 * `tool:<call.id>` step body — so under durable replay the whole step is memoized on its successful
 * result and a retry never becomes a new checkpoint; history still shows exactly one step per tool
 * call and side effects run once.
 */

/** Narrow, structural check for a MySQL/Postgres/SQLite transient error shape — no casts. */
function hasTransientShape(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = 'code' in error ? (error as { code: unknown }).code : undefined;
  const errno = 'errno' in error ? (error as { errno: unknown }).errno : undefined;
  const sqlState = 'sqlState' in error ? (error as { sqlState: unknown }).sqlState : undefined;
  if (code === 1213 || code === 1205 || errno === 1213 || errno === 1205) {
    return true; // MySQL ER_LOCK_DEADLOCK / ER_LOCK_WAIT_TIMEOUT numeric codes
  }
  if (code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT') {
    return true; // MySQL driver string codes
  }
  if (code === '40001' || code === '40P01' || sqlState === '40001' || sqlState === '40P01') {
    return true; // Postgres serialization_failure / deadlock_detected SQLSTATEs
  }
  if (code === 'SQLITE_BUSY') {
    return true;
  }
  const message = 'message' in error ? (error as { message: unknown }).message : undefined;
  return (
    typeof message === 'string' && /deadlock|lock wait timeout|serialization failure/i.test(message)
  );
}

/**
 * Default transient-tool-error classifier: true for a recognized MySQL/Postgres/SQLite
 * lock-contention shape (by driver `code`/`errno`/`sqlState`, or a matching message), checked on the
 * error itself and one level of `cause` (drivers commonly wrap the original error). A plain `Error`
 * with none of these markers — any other business failure — is `false`.
 */
export function isTransientToolError(error: unknown): boolean {
  if (error instanceof ToolPreflightDeniedError) return false;
  if (hasTransientShape(error)) {
    return true;
  }
  if (typeof error === 'object' && error !== null && 'cause' in error) {
    const cause = (error as { cause: unknown }).cause;
    if (cause !== undefined && cause !== error && hasTransientShape(cause)) {
      return true;
    }
  }
  return false;
}

/** Total attempts (initial try + retries) when `toolTransientRetry` doesn't set `attempts`. */
export const DEFAULT_TOOL_TRANSIENT_RETRY_ATTEMPTS = 2;
/** Backoff base in ms — the wait between attempt N and N+1 is `backoffMs * N`. */
export const DEFAULT_TOOL_TRANSIENT_RETRY_BACKOFF_MS = 150;

/** The host-configurable policy — everything, including the (in-process) `classify` fn. */
export interface ToolTransientRetryOptions {
  /** Total attempts (initial try + retries). Defaults to {@link DEFAULT_TOOL_TRANSIENT_RETRY_ATTEMPTS}. */
  attempts?: number;
  /** Backoff base in ms. Defaults to {@link DEFAULT_TOOL_TRANSIENT_RETRY_BACKOFF_MS}. */
  backoffMs?: number;
  /** Overrides the default classifier — widen or narrow which errors are treated as transient. */
  classify?: (error: unknown) => boolean;
}

/** `false` disables transient retry entirely — a tool's own thrown error surfaces immediately. */
export type ToolTransientRetrySetting = ToolTransientRetryOptions | false;

export interface InvokeWithTransientRetryOptions {
  /**
   * Recognizes the runner's control-flow signals (durable suspend / continue-as-new) so a retry
   * never swallows one — same rule the loop's tool catch already applies. Undefined for a call site
   * with no such notion (e.g. the inline runner, which has no workflow ctx to suspend on).
   */
  isControlFlowError?: (error: unknown) => boolean;
  /**
   * Called before each wait-and-retry, with the 1-based ordinal of the attempt that just failed and
   * the error it threw. The call site uses this to emit the `tool.retry` diagnostics event —
   * `invokeWithTransientRetry` itself carries no tool identity (name/callId), only the thunk.
   */
  onRetry?: (attempt: number, error: unknown) => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Retries `fn` in place — never a new durable step/checkpoint, just repeated attempts inside
 * whichever step body already wraps this call. `setting: false` runs `fn` once, unwrapped (no
 * classify/backoff bookkeeping at all). Otherwise: try; on a thrown error, rethrow immediately if
 * it's a recognized control-flow signal, else if the (possibly custom) classifier calls it transient
 * AND attempts remain, wait `backoffMs * attemptNumber` and retry; otherwise rethrow the error as-is.
 */
export async function invokeWithTransientRetry<T>(
  fn: () => Promise<T>,
  setting: ToolTransientRetrySetting,
  options?: InvokeWithTransientRetryOptions,
): Promise<T> {
  if (setting === false) {
    return fn();
  }
  const attempts = setting.attempts ?? DEFAULT_TOOL_TRANSIENT_RETRY_ATTEMPTS;
  const backoffMs = setting.backoffMs ?? DEFAULT_TOOL_TRANSIENT_RETRY_BACKOFF_MS;
  const classify = setting.classify ?? isTransientToolError;

  let attempt = 1;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (
        error instanceof ToolPreflightDeniedError ||
        options?.isControlFlowError?.(error) === true
      ) {
        throw error;
      }
      const attemptsRemain = attempt < attempts;
      if (!attemptsRemain || !classify(error)) {
        throw error;
      }
      options?.onRetry?.(attempt, error);
      await delay(backoffMs * attempt);
      attempt += 1;
    }
  }
}
