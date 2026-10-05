/**
 * What a server said when it refused a request, read once so every error class of this package
 * reports it the same way. Bundled into each entry that throws (the root and `/media`), which is
 * why it holds no class of its own.
 */
export interface ErrorAnswer {
  /** The body, parsed as JSON when it is JSON, else the raw text; `undefined` when empty. */
  body: unknown;
  /** `body.message` — a string, or NestJS's list of validation messages joined with `; `. */
  message: string | undefined;
  /** `body.code`, the machine-readable reason (`quota_exceeded`, …), when the server sent one. */
  code: string | undefined;
}

/** Read an error answer's body text. Never throws: a body that cannot be read is just absent. */
export function readErrorAnswer(text: string | null | undefined): ErrorAnswer {
  if (text == null || text === '') return { body: undefined, message: undefined, code: undefined };
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    return { body: text, message: undefined, code: undefined };
  }
  if (body === null || typeof body !== 'object')
    return { body, message: undefined, code: undefined };
  const record = body as { message?: unknown; code?: unknown };
  const message =
    typeof record.message === 'string' && record.message !== ''
      ? record.message
      : Array.isArray(record.message) &&
          record.message.length > 0 &&
          record.message.every((each) => typeof each === 'string')
        ? record.message.join('; ')
        : undefined;
  const code = typeof record.code === 'string' && record.code !== '' ? record.code : undefined;
  return { body, message, code };
}

/** {@link readErrorAnswer} over a `Response` whose status is not 2xx. */
export async function readErrorResponse(response: Response): Promise<ErrorAnswer> {
  let text: string | undefined;
  try {
    text = await response.text();
  } catch {
    text = undefined;
  }
  return readErrorAnswer(text);
}

/**
 * The shape both {@link import('./client.js').AgentHttpError} and `MediaUploadError` share, for
 * code that handles either without an `instanceof` (the two live in separate bundles).
 */
export interface AgentRequestError extends Error {
  status: number;
  method: string;
  path: string;
  body: unknown;
  code: string | undefined;
}

/** Called with every error answer before it is thrown — for app-wide reactions (401, 402, …). */
export type HttpErrorListener = (error: AgentRequestError) => void;

/** Tell `listener` about `error`; a listener that throws never replaces the error itself. */
export function reportHttpError(
  listener: HttpErrorListener | undefined,
  error: AgentRequestError,
): void {
  if (listener === undefined) return;
  try {
    listener(error);
  } catch {
    /* the request's own error is what the caller gets */
  }
}
