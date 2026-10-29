import { describe, expect, it, vi } from 'vitest';
import type { Actor, SinkWriter, StreamFrame, TokenStreamSink } from '../src/index.js';
import {
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  DefaultToolAuthorizer,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  ResilientTokenStreamSink,
  ToolRegistry,
} from '../src/index.js';
import { FakeModelProvider, InMemoryAgentStore } from '../src/testing/index.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A sink whose writes start failing after `okWrites` frames — the shape of a Redis that ran out of
 * memory mid-answer (`OOM command not allowed`, `EXECABORT`). Reading still works.
 */
class BreakingSink implements TokenStreamSink {
  readonly inner = new InProcessTokenStreamSink();
  writes = 0;
  ends = 0;
  constructor(private readonly okWrites: number) {}
  open(runId: string): SinkWriter {
    const writer = this.inner.open(runId) as SinkWriter;
    return {
      write: async (frame: StreamFrame) => {
        this.writes += 1;
        if (this.writes > this.okWrites) throw new Error('OOM command not allowed');
        await writer.write(frame);
      },
      end: async () => {
        this.ends += 1;
        await writer.end();
      },
    };
  }
  subscribe(runId: string) {
    return this.inner.subscribe(runId);
  }
  close(runId: string) {
    return this.inner.close(runId);
  }
}

describe('ResilientTokenStreamSink', () => {
  it('reports the first failed write once, drops the rest, and still tries to end', async () => {
    const broken = new BreakingSink(1);
    const onFailure = vi.fn();
    const sink = new ResilientTokenStreamSink(broken, { onFailure });
    const writer = await sink.open('run-1');

    await writer.write({ t: 'text', v: 'a' });
    await writer.write({ t: 'text', v: 'b' });
    await writer.write({ t: 'text', v: 'c' });
    await writer.end();

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ runId: 'run-1', stage: 'write' });
    // After the first failure the writer goes quiet: one write reached the broken sink, not three.
    expect(broken.writes).toBe(2);
    expect(broken.ends).toBe(1);
  });

  it('a sink that cannot even open gives a writer that does nothing', async () => {
    const onFailure = vi.fn();
    const sink = new ResilientTokenStreamSink(
      {
        open: () => {
          throw new Error('connection refused');
        },
        subscribe: () => (async function* () {})(),
        close: () => {},
      },
      { onFailure },
    );
    const writer = await sink.open('run-2');
    expect(await writer.write({ t: 'text', v: 'x' })).toBeUndefined();
    expect(await writer.end()).toBeUndefined();
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ stage: 'open' }));
  });

  it('leaves reading to the wrapped sink', async () => {
    const inner = new InProcessTokenStreamSink();
    const sink = new ResilientTokenStreamSink(inner);
    const writer = await sink.open('run-3');
    await writer.write({ t: 'text', v: 'oi' });
    await writer.end();
    const frames: StreamFrame[] = [];
    for await (const frame of sink.subscribe('run-3')) frames.push(frame);
    expect(frames).toEqual([{ t: 'text', v: 'oi' }]);
    expect(sink.has).toBeTypeOf(typeof inner.has);
  });
});

describe('a run whose live stream breaks', () => {
  async function runWith(sink: TokenStreamSink) {
    const store = new InMemoryAgentStore();
    const factory = new AgentDepsFactory({
      model: new FakeModelProvider(() => ({ text: 'a resposta inteira' })),
      store,
      sink,
      rolesPolicy: new DefaultToolAuthorizer(),
      registry: new ToolRegistry(),
      agents: new AgentRegistry(),
    });
    const service = new AgentService(new InlineAgentRunner(factory, store), store, factory);
    const { threadId } = await service.chat({ actor, message: 'oi', agentName: 'default' });
    // Wait for the turn to settle, whichever way it goes.
    for (let i = 0; i < 200; i += 1) {
      const thread = await store.getThread(threadId);
      if (thread?.messages.some((message) => message.role === 'assistant')) break;
      await sleep(5);
    }
    await sleep(20);
    return (await store.getThread(threadId))?.messages ?? [];
  }

  it('without the wrapper, the answer is lost (the bug this fixes)', async () => {
    const messages = await runWith(new BreakingSink(0));
    expect(messages.find((message) => message.role === 'assistant')?.content ?? '').not.toBe(
      'a resposta inteira',
    );
  });

  it('still persists the answer when wrapped — the stream was only the transport', async () => {
    const messages = await runWith(
      new ResilientTokenStreamSink(new BreakingSink(0), { onFailure: () => {} }),
    );
    expect(messages.find((message) => message.role === 'assistant')?.content).toBe(
      'a resposta inteira',
    );
  });
});
