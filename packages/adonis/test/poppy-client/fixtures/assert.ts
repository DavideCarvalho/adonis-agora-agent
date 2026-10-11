import { assert } from 'vitest';

/** `assert.rejects` as the reference client's tests were written (Japa): message regex or error class. */
export async function rejects(
  fn: () => unknown,
  matcher?: RegExp | (abstract new (...args: never[]) => unknown),
): Promise<void> {
  let error: unknown;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  if (error === undefined) assert.fail('expected the promise to reject');
  if (matcher instanceof RegExp) {
    assert.match(error instanceof Error ? error.message : String(error), matcher);
  } else if (matcher) {
    assert.instanceOf(error, matcher as never);
  }
}
