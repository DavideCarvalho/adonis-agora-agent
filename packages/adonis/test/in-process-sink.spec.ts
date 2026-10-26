import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InProcessTokenStreamSink, type StreamFrame } from '../src/index.js';

const HOUR = 3_600_000;

async function collect(iterable: AsyncIterable<StreamFrame>): Promise<StreamFrame[]> {
  const out: StreamFrame[] = [];
  for await (const frame of iterable) out.push(frame);
  return out;
}

/** Whether `promise` settles within a few turns of the event loop. */
async function settlesSoon(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
}

describe('InProcessTokenStreamSink retention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets an ended run go an hour after it ended, and keeps it for replay until then', async () => {
    const sink = new InProcessTokenStreamSink();
    const writer = sink.open('run-1');
    writer.write({ t: 'text', v: 'hello' });
    writer.end();

    vi.advanceTimersByTime(HOUR - 1000);
    expect(sink.has('run-1')).toBe(true);
    expect(await collect(sink.subscribe('run-1'))).toEqual([{ t: 'text', v: 'hello' }]);

    vi.advanceTimersByTime(2000);
    expect(sink.has('run-1')).toBe(false);
  });

  it('holds thousands of finished runs only for the replay window', () => {
    const sink = new InProcessTokenStreamSink();
    for (let run = 0; run < 2000; run++) {
      const writer = sink.open(`run-${run}`);
      for (let token = 0; token < 50; token++) writer.write({ t: 'text', v: ' tok' });
      writer.end();
    }
    vi.advanceTimersByTime(HOUR + 1);
    for (let run = 0; run < 2000; run++) expect(sink.has(`run-${run}`)).toBe(false);
  });

  it('counts the window from the last write, so a run that keeps streaming is kept', () => {
    const sink = new InProcessTokenStreamSink();
    const writer = sink.open('run-long');
    for (let minute = 0; minute < 90; minute++) {
      writer.write({ t: 'text', v: '.' });
      vi.advanceTimersByTime(60_000);
    }
    expect(sink.has('run-long')).toBe(true);
    vi.advanceTimersByTime(HOUR);
    expect(sink.has('run-long')).toBe(false);
  });

  it('ends the subscribers of a run that never ended once its window lapses', async () => {
    const sink = new InProcessTokenStreamSink();
    const writer = sink.open('run-parked');
    writer.write({ t: 'text', v: 'waiting on you' });
    const followed = collect(sink.subscribe('run-parked'));
    vi.advanceTimersByTime(HOUR + 1);
    expect(await followed).toEqual([{ t: 'text', v: 'waiting on you' }]);
  });

  it('writes into a fresh buffer when a writer outlives the window', async () => {
    const sink = new InProcessTokenStreamSink();
    const writer = sink.open('run-resumed');
    writer.write({ t: 'text', v: 'before' });
    vi.advanceTimersByTime(HOUR + 1);
    writer.write({ t: 'text', v: 'after' });
    writer.end();
    expect(await collect(sink.subscribe('run-resumed'))).toEqual([{ t: 'text', v: 'after' }]);
  });
});

describe('InProcessTokenStreamSink subscriber', () => {
  it('stops waiting as soon as its consumer returns, with nothing more written', async () => {
    const sink = new InProcessTokenStreamSink();
    sink.open('run-idle').write({ t: 'text', v: 'a' });
    const iterator = sink.subscribe('run-idle')[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: { t: 'text', v: 'a' } });
    const pending = iterator.next();
    const returned = iterator.return?.();
    expect(await settlesSoon(Promise.all([pending, returned]))).toBe(true);
    expect(await pending).toEqual({ done: true, value: undefined });
  });
});
