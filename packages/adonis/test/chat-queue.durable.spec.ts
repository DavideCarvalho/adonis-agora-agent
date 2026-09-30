// The chat queue under the durable runner: the settling workflow journals the handoff and starts the
// next queued message as a run of its own, under the message's id. A port of
// `@dudousxd/nestjs-agent`'s `durable/agent-chat-queue.spec.ts`.
import { InMemoryStateStore, WorkflowEngine } from '@adonis-agora/durable';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DurableAgentRunner,
  registerAgentWorkflow,
  setDurableAgentContext,
} from '../src/durable/index.js';
import {
  type Actor,
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  type AgentStreamEvent,
  ChatQueueService,
  type ChatSendResult,
  DefaultToolAuthorizer,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  ToolRegistry,
} from '../src/index.js';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '../src/testing/index.js';

const ACTOR: Actor = { id: 'u1', roles: ['ADMIN'] };

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Answers `re: <message>`; a message can be held mid-turn, or made to fail. */
class ScriptedModel implements ModelProvider {
  readonly seen: string[] = [];
  readonly failing = new Set<string>();
  private readonly holds = new Map<string, Deferred>();
  private readonly entered = new Map<string, Deferred>();

  hold(message: string): void {
    this.holds.set(message, deferred());
  }
  release(message: string): void {
    this.holds.get(message)?.resolve();
  }
  reached(message: string): Promise<void> {
    return this.enteredFor(message).promise;
  }
  private enteredFor(message: string): Deferred {
    let entry = this.entered.get(message);
    if (entry === undefined) {
      entry = deferred();
      this.entered.set(message, entry);
    }
    return entry;
  }
  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const last = [...args.messages].reverse().find((message) => message.role === 'user');
    const message = last?.content ?? '';
    this.seen.push(message);
    this.enteredFor(message).resolve();
    await this.holds.get(message)?.promise;
    if (this.failing.has(message)) {
      throw new Error(`model failed on ${message}`);
    }
    const text = `re: ${message}`;
    await args.sink.write({ t: 'text', v: text });
    return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

async function buildApp() {
  const model = new ScriptedModel();
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const factory = new AgentDepsFactory({
    model,
    store,
    sink,
    rolesPolicy: new DefaultToolAuthorizer(),
    registry: new ToolRegistry(),
    agents: new AgentRegistry(),
  });
  const queue = new ChatQueueService(store, sink);
  const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
  setDurableAgentContext({ factory, store, queue });
  registerAgentWorkflow(engine);
  const runner = new DurableAgentRunner(engine, store, queue, sink);
  const service = new AgentService(runner, store, factory, { queue });
  const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
  return { model, store, sink, engine, service, threadId: thread.id };
}

function started(result: ChatSendResult): string {
  if (result.queued === true) throw new Error('expected the send to start a run');
  return result.runId;
}

/** Every agent-protocol event of a run's stream, and whether it ended in a failure. */
async function drain(
  service: AgentService,
  runId: string,
): Promise<{ frames: AgentStreamEvent[]; failed: boolean }> {
  const frames: AgentStreamEvent[] = [];
  let failed = false;
  for await (const frame of service.subscribe(runId)) {
    if (frame.t === 'event') frames.push(frame.event);
    if (frame.t === 'text') frames.push({ kind: 'text', text: frame.v });
    if (frame.t === 'error') failed = true;
  }
  return { frames, failed };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  setDurableAgentContext(undefined);
});

describe('chat message queue — durable runner', () => {
  it('hands the thread to the next queued message, as a run under its own id', async () => {
    const app = await buildApp();
    try {
      app.model.hold('first');
      const firstRun = started(
        await app.service.send({ actor: ACTOR, threadId: app.threadId, message: 'first' }),
      );
      const streamed = drain(app.service, firstRun);
      await app.model.reached('first');

      const queued = await app.service.send({
        actor: ACTOR,
        threadId: app.threadId,
        message: 'second',
      });
      expect(queued).toMatchObject({ queued: true, position: 0 });
      const messageId = (queued as { messageId: string }).messageId;

      app.model.release('first');
      const { frames, failed } = await streamed;
      expect(failed).toBe(false);
      expect(frames.filter((frame) => frame.kind === 'queue').at(-1)).toEqual({
        kind: 'queue',
        queue: { items: [], paused: null },
        started: { messageId, runId: messageId },
      });

      // The queued message runs as a durable run of its own, under its own id.
      await until(
        () => app.engine.getRun(messageId),
        (run) => run?.status === 'completed',
      );
      const thread = await until(
        () => app.store.getThread(app.threadId),
        (value) => (value?.activeRunId ?? null) === null && (value?.messages.length ?? 0) >= 4,
      );
      expect(thread?.messages.map((message) => `${message.role}: ${message.content}`)).toEqual([
        'user: first',
        'assistant: re: first',
        'user: second',
        'assistant: re: second',
      ]);
      expect(app.model.seen).toEqual(['first', 'second']);
    } finally {
      app.model.release('first');
    }
  });

  it('pauses the queue behind a failed turn', async () => {
    const app = await buildApp();
    try {
      app.model.hold('first');
      app.model.failing.add('first');
      const firstRun = started(
        await app.service.send({ actor: ACTOR, threadId: app.threadId, message: 'first' }),
      );
      const streamed = drain(app.service, firstRun);
      await app.model.reached('first');
      await app.service.send({ actor: ACTOR, threadId: app.threadId, message: 'second' });

      app.model.release('first');
      const { frames, failed } = await streamed;
      expect(failed).toBe(true);
      expect(frames.at(-1)).toMatchObject({
        kind: 'queue',
        queue: { items: [{ content: 'second' }], paused: { reason: 'run_failed' } },
      });
      await until(
        () => app.engine.getRun(firstRun),
        (run) => run?.status === 'failed',
      );
      expect(await app.store.activeRunForThread(app.threadId)).toBeNull();
      expect(app.model.seen).not.toContain('second');
    } finally {
      app.model.release('first');
    }
  });

  it('an interrupt cancels the running turn from outside and starts next', async () => {
    const app = await buildApp();
    try {
      app.model.hold('first');
      const firstRun = started(
        await app.service.send({ actor: ACTOR, threadId: app.threadId, message: 'first' }),
      );
      const streamed = drain(app.service, firstRun);
      await app.model.reached('first');

      const interrupt = await app.service.send({
        actor: ACTOR,
        threadId: app.threadId,
        message: 'now',
        mode: 'interrupt',
      });
      expect(interrupt).toMatchObject({ queued: true, interrupting: firstRun });
      const messageId = (interrupt as { messageId: string }).messageId;

      const { frames } = await streamed;
      expect(frames.slice(-2)).toEqual([
        {
          kind: 'queue',
          queue: { items: [], paused: null },
          started: { messageId, runId: messageId },
        },
        { kind: 'cancelled' },
      ]);
      app.model.release('first');
      await until(
        () => app.engine.getRun(messageId),
        (run) => run?.status === 'completed',
      );
      // The cancelled turn settling afterwards must not take the thread back from the new one.
      const thread = await until(
        () => app.store.getThread(app.threadId),
        (value) => value?.messages.some((message) => message.content === 're: now') === true,
      );
      expect(thread?.messages.slice(-2).map((message) => message.content)).toEqual([
        'now',
        're: now',
      ]);
      expect(await app.store.activeRunForThread(app.threadId)).toBeNull();
    } finally {
      app.model.release('first');
    }
  });
});
