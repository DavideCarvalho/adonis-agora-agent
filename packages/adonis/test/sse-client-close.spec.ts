import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InProcessTokenStreamSink,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  type StreamFrame,
  type TokenStreamSink,
} from '../src/index.js';
import { untilClosed } from '../src/interruptible.js';
import { type BootedApp, bootAgentApp } from './helpers/boot-agent-app.js';

/** A model that writes one token, then holds the turn until released — a run that stays live. */
class HeldModel implements ModelProvider {
  private release!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  finish(): void {
    this.release();
  }

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    await args.sink.write({ t: 'text', v: 'thinking' });
    await this.released;
    return { text: 'thinking', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

/** The in-process sink, counting the subscriptions still open. */
class CountingSink implements TokenStreamSink {
  readonly inner = new InProcessTokenStreamSink();
  open = (runId: string) => this.inner.open(runId);
  has = (runId: string) => this.inner.has(runId);
  close = (runId: string) => this.inner.close(runId);
  active = 0;

  subscribe(runId: string): AsyncIterable<StreamFrame> {
    const source = this.inner.subscribe(runId);
    return {
      [Symbol.asyncIterator]: () => {
        const iterator = source[Symbol.asyncIterator]();
        this.active += 1;
        let open = true;
        const settle = <T>(result: IteratorResult<T>) => {
          if (result.done === true && open) {
            open = false;
            this.active -= 1;
          }
          return result;
        };
        return {
          next: async () => settle(await iterator.next()),
          return: async (value?: unknown) =>
            settle((await iterator.return?.(value)) ?? { done: true, value: undefined }),
        };
      },
    };
  }
}

async function until(condition: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

describe('the SSE routes, when the client goes away', () => {
  let booted: BootedApp | null = null;
  afterEach(async () => {
    await booted?.close();
    booted = null;
  });

  it('lets go of the run’s subscription instead of holding it until the run writes again', async () => {
    const model = new HeldModel();
    const sink = new CountingSink();
    booted = await bootAgentApp({ model, sink });
    const controller = new AbortController();
    const response = await fetch(`${booted.url}/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'u1' },
      body: JSON.stringify({ message: 'hello there' }),
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    await reader?.read();
    expect(await until(() => sink.active === 1)).toBe(true);

    controller.abort();
    // Nothing more is written while the turn is held; the subscription still has to go.
    expect(await until(() => sink.active === 0)).toBe(true);
    model.finish();
  });
});

describe('untilClosed', () => {
  it('ends a read that would wait for good, and tells the source to stop, when the response closes', async () => {
    let returned = false;
    const never: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<number>>(() => {}),
        return: async () => {
          returned = true;
          return { done: true, value: undefined };
        },
      }),
    };
    const response = new EventEmitter();
    const iterator = untilClosed(response, never)[Symbol.asyncIterator]();
    const pending = iterator.next();
    response.emit('close');
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(returned).toBe(true);
    expect(response.listenerCount('close')).toBe(0);
  });
});
