/**
 * The shape a thread id may take where it crosses into a response header (`X-Agent-Thread-Id`) or
 * names a new thread a caller picked: 1-200 characters of letters, digits and `_ - . : @`, starting
 * with a letter or digit. Generated ids (UUIDs) and the usual caller-chosen ones (`thread-1`,
 * `conv:42`) fit; control characters, spaces, quotes and anything a header cannot carry do not.
 */
export const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/;

/** Whether `value` is a thread id this library accepts ({@link THREAD_ID_PATTERN}). */
export function isValidThreadId(value: unknown): value is string {
  return typeof value === 'string' && THREAD_ID_PATTERN.test(value);
}
