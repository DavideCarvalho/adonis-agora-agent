import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { aiSdkModel } from '../src/ai-sdk/ai-sdk-model.js';
import {
  type Actor,
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  DefaultToolAuthorizer,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  type ModelProvider,
  type ModelTurnArgs,
  type StreamFrame,
  ToolRegistry,
} from '../src/index.js';
import { InMemoryAgentStore } from '../src/testing/index.js';

/**
 * A Stop aborts what the run is waiting on — the model call streaming the answer, a tool that takes
 * the signal — instead of letting it run to the end of the step. The run still ends `cancelled`, and
 * the thread keeps what it kept before: the steps that finished, not the one the Stop cut short.
 */

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
/** Long enough that a call nobody aborted is plainly still running when the test looks. */
const HANG_MS = 3000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Resolves on `signal`'s abort (to `true`), or after {@link HANG_MS} when nothing aborts it (`false`). */
function abortedOrTimeout(signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), HANG_MS);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function build(model: ModelProvider) {
  const store = new InMemoryAgentStore();
  const registry = new ToolRegistry();
  const factory = new AgentDepsFactory({
    model,
    store,
    sink: new InProcessTokenStreamSink(),
    rolesPolicy: new DefaultToolAuthorizer(),
    registry,
    agents: new AgentRegistry(),
  });
  const runner = new InlineAgentRunner(factory, store);
  const service = new AgentService(runner, store, factory);
  return { store, registry, service, runner };
}

/** Until the loop itself has unwound — the stream closes at the Stop, the loop only after. */
async function unwound(runner: InlineAgentRunner, runId: string): Promise<void> {
  for (let i = 0; i < 2 * HANG_MS; i += 1) {
    if (!(await runner.isRunActive(runId))) return;
    await new Promise((r) => setTimeout(r, 1));
  }
}

async function drain(service: AgentService, runId: string): Promise<StreamFrame[]> {
  const frames: StreamFrame[] = [];
  for await (const frame of service.subscribe(runId)) frames.push(frame);
  return frames;
}

async function settledStatus(
  store: InMemoryAgentStore,
  runId: string,
): Promise<string | undefined> {
  for (let i = 0; i < 200; i += 1) {
    const status = store.governanceRuns().find((run) => run.runId === runId)?.status;
    if (status !== 'running') return status;
    await new Promise((r) => setTimeout(r, 5));
  }
  return 'running';
}

describe('cancelling a run aborts its in-flight work', () => {
  it.each([
    ['ends its stream early', false],
    ['rejects like the AI SDK does', true],
  ])('aborts the model call mid-stream (a provider that %s)', async (_label, rejects) => {
    const streaming = deferred();
    const answered = deferred();
    let aborted: boolean | undefined;
    const model: ModelProvider = {
      async runTurn(args: ModelTurnArgs) {
        await args.sink.write({ t: 'text', v: 'Hel' });
        streaming.resolve();
        aborted = await abortedOrTimeout(args.abortSignal);
        answered.resolve();
        if (aborted && rejects) {
          throw new DOMException('This operation was aborted', 'AbortError');
        }
        await args.sink.write({ t: 'text', v: 'lo there' });
        return { text: 'Hello there', toolCalls: [], usage: { inputTokens: 1, outputTokens: 2 } };
      },
    };
    const { store, service, runner } = build(model);
    const started = Date.now();
    const { runId, threadId } = await service.chat({ actor, message: 'hi' });
    const frames = drain(service, runId);
    await streaming.promise;
    await service.cancel(runId);
    const seen = await frames;
    await answered.promise;
    await unwound(runner, runId);

    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(HANG_MS);
    expect(await settledStatus(store, runId)).toBe('cancelled');
    expect(seen.at(-1)).toEqual({ t: 'event', event: { kind: 'cancelled' } });
    expect(seen.some((frame) => frame.t === 'error')).toBe(false);
    // As before: the step the Stop cut short is not persisted.
    const thread = await store.getThread(threadId);
    expect(thread?.messages.map((message) => message.role)).toEqual(['user']);
  });

  it('hands a running tool the abort, and keeps the step that finished', async () => {
    const executing = deferred();
    const returned = deferred();
    let toolSawAbort: boolean | undefined;
    let modelCalls = 0;
    const model: ModelProvider = {
      async runTurn(args: ModelTurnArgs) {
        modelCalls += 1;
        await args.sink.write({ t: 'text', v: 'Checking' });
        return {
          text: 'Checking',
          toolCalls: [{ id: 'call-slow', name: 'slow', input: {} }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const { store, registry, service, runner } = build(model);
    registry.register(
      {
        name: 'slow',
        kind: 'read',
        description: 'slow',
        inputSchema: z.object({}),
        roles: ['ADMIN'],
      },
      {
        async execute(_input, ctx) {
          executing.resolve();
          toolSawAbort = await abortedOrTimeout(ctx.abortSignal);
          returned.resolve();
          if (toolSawAbort) throw new DOMException('This operation was aborted', 'AbortError');
          return { done: true };
        },
      },
    );
    const started = Date.now();
    const { runId, threadId } = await service.chat({ actor, message: 'hi' });
    const frames = drain(service, runId);
    await executing.promise;
    await service.cancel(runId);
    const seen = await frames;
    await returned.promise;
    await unwound(runner, runId);

    expect(toolSawAbort).toBe(true);
    expect(Date.now() - started).toBeLessThan(HANG_MS);
    expect(modelCalls).toBe(1);
    expect(await settledStatus(store, runId)).toBe('cancelled');
    expect(seen.at(-1)).toEqual({ t: 'event', event: { kind: 'cancelled' } });
    const thread = await store.getThread(threadId);
    expect(thread?.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Checking'],
    ]);
  });

  it('ends a real aiSdkModel stream at the Stop, settled cancelled rather than failed', async () => {
    const streaming = deferred();
    let providerSawAbort: boolean | undefined;
    const mock = new MockLanguageModelV3({
      doStream: async (options) => ({
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '1' });
            controller.enqueue({ type: 'text-delta', id: '1', delta: 'Hel' });
            streaming.resolve();
            providerSawAbort = await abortedOrTimeout(options.abortSignal);
            if (providerSawAbort) {
              controller.error(new DOMException('This operation was aborted', 'AbortError'));
              return;
            }
            controller.enqueue({ type: 'text-delta', id: '1', delta: 'lo' });
            controller.enqueue({ type: 'text-end', id: '1' });
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      }),
    });
    const { store, service, runner } = build(aiSdkModel(mock));
    const started = Date.now();
    const { runId, threadId } = await service.chat({ actor, message: 'hi' });
    const frames = drain(service, runId);
    await streaming.promise;
    await service.cancel(runId);
    const seen = await frames;
    await unwound(runner, runId);

    expect(providerSawAbort).toBe(true);
    expect(Date.now() - started).toBeLessThan(HANG_MS);
    expect(await settledStatus(store, runId)).toBe('cancelled');
    expect(seen.some((frame) => frame.t === 'error')).toBe(false);
    expect((await store.getThread(threadId))?.messages.map((m) => m.role)).toEqual(['user']);
  });
});
