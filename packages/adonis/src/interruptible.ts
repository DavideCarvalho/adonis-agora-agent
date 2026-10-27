/**
 * An `AsyncIterable` over a generator that is handed an `AbortSignal`, aborted as soon as the
 * consumer calls `return()` on the iterator (a `for await` does on `break`). A generator's own
 * `return()` waits for its pending `await` to settle, so a subscriber parked on a wake-up that never
 * comes would hold its poll loop or pub/sub subscription for good; the signal lets that wait end and
 * the generator's `finally` run.
 */
export function interruptible<T>(
  source: (signal: AbortSignal) => AsyncGenerator<T, void, undefined>,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const controller = new AbortController();
      const inner = source(controller.signal);
      return {
        next: () => inner.next(),
        return: (value?: unknown) => {
          controller.abort();
          return inner.return(value as undefined) as Promise<IteratorResult<T>>;
        },
        throw: (error?: unknown) => {
          controller.abort();
          return inner.throw(error);
        },
      };
    },
  };
}

/** Resolves when `promise` does or `signal` aborts, whichever is first. Never rejects on abort. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Waits `ms`, or less when `signal` aborts first. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * `frames`, ended as soon as `response` emits `close` — the client went away. The pending read is
 * abandoned and the source's iterator is told to `return()`, so a subscription on a run that writes
 * nothing more (parked on a person, or gone) does not outlive the connection that asked for it.
 */
export function untilClosed<T>(
  response: {
    once(event: 'close', listener: () => void): unknown;
    off(event: 'close', listener: () => void): unknown;
  },
  frames: AsyncIterable<T>,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const iterator = frames[Symbol.asyncIterator]();
      let closed = false;
      let markClosed!: () => void;
      const closing = new Promise<IteratorResult<T>>((resolve) => {
        markClosed = () => resolve({ done: true, value: undefined });
      });
      const onClose = () => {
        closed = true;
        markClosed();
        // A source that cannot stop early still gets told; its failure is not this response's.
        Promise.resolve(iterator.return?.()).catch(() => {});
      };
      response.once('close', onClose);
      const detach = () => response.off('close', onClose);
      return {
        next: async () => {
          if (closed) return { done: true, value: undefined };
          const result = await Promise.race([iterator.next(), closing]);
          if (result.done === true) detach();
          return result;
        },
        return: async (value?: unknown) => {
          detach();
          if (!closed) {
            closed = true;
            await iterator.return?.(value);
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}
