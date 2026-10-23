import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type Heartbeat,
  InMemoryStateStore,
  InMemoryTransport,
  type RemoteTask,
  runTick,
  type StepResult,
  type Transport,
  WorkflowEngine,
} from '@adonis-agora/durable';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ChannelStepServer,
  type ChannelWorkflowCtx,
  type ChannelWorkflowEngine,
  channels,
  InMemoryChannelStore,
} from '../src/channels/index.js';
import { actor, fakeAdapter, fakeService, inbound, makeCtx, texts } from './helpers/channels.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const never = <T = never>() => new Promise<T>(() => {});

async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(5);
  }
}

/** Where a hook ran: inside the worker's handling of a dispatched step, or not. */
const where = new AsyncLocalStorage<string>();

/**
 * A broker between a web process and a worker process: the engine's `dispatch` only enqueues; the
 * worker (its own loop, its own handlers) takes each task, runs it and posts the result back.
 */
class BrokerTransport implements Transport {
  readonly tasks: RemoteTask[] = [];
  readonly ran: string[] = [];
  readonly #queue: RemoteTask[] = [];
  readonly #handlers = new Map<
    string,
    (input: unknown, log?: { heartbeat?(): void }) => Promise<unknown>
  >();
  #onResult?: (result: StepResult) => Promise<void>;
  #stopped = false;
  #worker: Promise<void> | undefined;

  /** The worker side: serve `name`. */
  handle(name: string, fn: (input: unknown, log?: { heartbeat?(): void }) => Promise<unknown>) {
    this.#handlers.set(name, fn);
    this.#worker ??= this.#work();
  }

  async dispatch(task: RemoteTask): Promise<void> {
    this.tasks.push(task);
    this.#queue.push(task);
  }

  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.#onResult = handler;
  }

  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}

  async #work() {
    while (!this.#stopped) {
      const task = this.#queue.shift();
      if (task === undefined) {
        await sleep(2);
        continue;
      }
      const handler = this.#handlers.get(task.name);
      const base = { runId: task.runId, seq: task.seq, stepId: task.stepId };
      let result: StepResult;
      try {
        if (!handler) throw new Error(`no handler for ${task.name}`);
        const output = await where.run('worker', () => handler(task.input, {}));
        this.ran.push(task.name);
        result = { ...base, status: 'completed', output };
      } catch (error) {
        result = {
          ...base,
          status: 'failed',
          error: { message: error instanceof Error ? error.message : String(error) },
        };
      }
      await this.#onResult?.(result);
    }
  }

  async close() {
    this.#stopped = true;
    await this.#worker;
  }
}

const runs: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(runs.splice(0).map((stop) => stop()));
});

describe('channel phases as dispatched steps', () => {
  it('runs every phase on the worker that serves the steps, not in the workflow', async () => {
    const transport = new BrokerTransport();
    runs.push(() => transport.close());
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    const { adapter, outbox } = fakeAdapter();
    const hooks: Array<[string, string]> = [];
    const service = fakeService([{ t: 'text', v: 'Hello from a worker' }]);
    const handle = channels.handle(adapter, {
      service,
      store: new InMemoryChannelStore(),
      durable: engine as unknown as ChannelWorkflowEngine,
      durableSteps: transport as unknown as ChannelStepServer,
      actor: () => {
        hooks.push(['actor', where.getStore() ?? 'workflow']);
        return actor;
      },
      thread: () => 't',
      transformInbound: (inbound) => {
        hooks.push(['transformInbound', where.getStore() ?? 'workflow']);
        return inbound;
      },
      canDeliver: () => {
        hooks.push(['canDeliver', where.getStore() ?? 'workflow']);
        return true;
      },
    });
    await handle(makeCtx(inbound('hi', { id: 'w-1' })).ctx);
    await engine.waitForRun('agora.channel:test:message:w-1', { terminal: true, timeoutMs: 5000 });
    expect(texts(outbox)).toEqual(['Hello from a worker']);
    expect(transport.tasks.map((task) => task.name)).toEqual([
      'agora.channel.prepare',
      'agora.channel.act',
      'agora.channel.read',
    ]);
    expect(transport.ran).toEqual([
      'agora.channel.prepare',
      'agora.channel.act',
      'agora.channel.read',
    ]);
    expect(hooks).toEqual([
      ['actor', 'worker'],
      ['transformInbound', 'worker'],
      ['canDeliver', 'worker'],
    ]);
    // Each phase's input is plain JSON: the channel, the job and what came before.
    expect(JSON.parse(JSON.stringify(transport.tasks[2]?.input))).toEqual(
      transport.tasks[2]?.input,
    );
    expect(transport.tasks[2]?.input).toMatchObject({
      channel: 'test',
      job: { kind: 'message', message: { id: 'w-1' } },
      prepared: { stop: false, actor, threadId: 't' },
      turn: { runId: 'run-1', threadId: 't' },
    });
    const run = await engine.getRun('agora.channel:test:message:w-1');
    expect(run?.workflowVersion).toBe('2');
    const steps = await engine.listCheckpoints('agora.channel:test:message:w-1');
    expect(steps.map((step) => [step.name, step.kind])).toEqual([
      ['channel', 'local'],
      ['agora.channel.prepare', 'remote'],
      ['agora.channel.act', 'remote'],
      ['agora.channel.read', 'remote'],
    ]);
  });

  it('under a serial durable:work worker, with the agent turn left pending for it', async () => {
    const transport = new InMemoryTransport();
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport,
      runDispatcher: { dispatch: () => {} },
    });
    let stopped = false;
    const worker = (async () => {
      while (!stopped) {
        await runTick(engine);
        await sleep(5);
      }
    })();
    runs.push(async () => {
      stopped = true;
      await worker;
    });
    const { adapter, outbox } = fakeAdapter();
    const handle = channels.handle(adapter, {
      service: fakeService([{ t: 'text', v: 'ok' }]),
      store: new InMemoryChannelStore(),
      durable: engine as unknown as ChannelWorkflowEngine,
      durableSteps: transport as unknown as ChannelStepServer,
      actor: () => actor,
      thread: () => 't',
    });
    await handle(makeCtx(inbound('hi', { id: 'sw-1' })).ctx);
    await engine.waitForRun('agora.channel:test:message:sw-1', { terminal: true, timeoutMs: 5000 });
    expect(texts(outbox)).toEqual(['ok']);
    const steps = await engine.listCheckpoints('agora.channel:test:message:sw-1');
    expect(steps.filter((step) => step.kind === 'remote')).toHaveLength(3);
  });

  it('without anywhere to serve steps (or durableSteps: false), the phases run as local steps', async () => {
    for (const variant of ['no transport', 'durableSteps: false'] as const) {
      const transport = new InMemoryTransport();
      const engine = new WorkflowEngine({
        store: new InMemoryStateStore(),
        ...(variant === 'durableSteps: false' ? { transport } : {}),
      });
      const { adapter, outbox } = fakeAdapter();
      const handle = channels.handle(adapter, {
        service: fakeService([{ t: 'text', v: 'ok' }]),
        store: new InMemoryChannelStore(),
        durable: engine as unknown as ChannelWorkflowEngine,
        ...(variant === 'durableSteps: false' ? { durableSteps: false as const } : {}),
        actor: () => actor,
        thread: () => 't',
      });
      await handle(makeCtx(inbound('hi', { id: `l-${variant}` })).ctx);
      await handle.drain();
      expect(texts(outbox)).toEqual(['ok']);
      const steps = await engine.listCheckpoints(`agora.channel:test:message:l-${variant}`);
      expect(steps.map((step) => [step.name, step.kind])).toEqual([
        ['channel', 'local'],
        ['prepare', 'local'],
        ['act', 'local'],
        ['read', 'local'],
      ]);
    }
  });

  it('a version-1 run in flight across the upgrade finishes on the version-1 path', async () => {
    const durableStore = new InMemoryStateStore();
    const store = new InMemoryChannelStore();
    const { adapter, outbox } = fakeAdapter();
    // The process before the upgrade: version 1 only, every phase a local step. It dies after
    // `prepare` (the turn never started).
    const old = new WorkflowEngine({ store: durableStore });
    old.register(
      'agora.channel.job',
      '1',
      async (ctx) => {
        await ctx.localStep('channel', async () => true);
        await ctx.localStep('prepare', async () => ({ stop: false, actor, threadId: 't' }));
        await never();
      },
      { singleton: { key: () => 'test:chat-1', limit: 1 } },
    );
    await old.start(
      'agora.channel.job',
      {
        kind: 'message',
        channel: 'test',
        conversation: 'chat-1',
        message: inbound('hi', { id: 'v1-1' }),
      },
      'agora.channel:test:message:v1-1',
    );
    await until(
      async () => (await old.listCheckpoints('agora.channel:test:message:v1-1')).length >= 2,
    );

    // The upgraded process (its clock past the dead one's lease), with dispatched steps.
    const transport = new InMemoryTransport();
    const engine = new WorkflowEngine({
      store: durableStore,
      transport,
      clock: () => Date.now() + 10 * 60_000,
    });
    const service = fakeService([{ t: 'text', v: 'Answered on v1' }]);
    channels.handle(adapter, {
      service,
      store,
      durable: engine as unknown as ChannelWorkflowEngine,
      durableSteps: transport as unknown as ChannelStepServer,
      actor: () => actor,
      thread: () => 't',
    });
    await engine.recoverIncomplete();
    await engine.waitForRun('agora.channel:test:message:v1-1', { terminal: true, timeoutMs: 5000 });
    const run = await engine.getRun('agora.channel:test:message:v1-1');
    expect(run?.workflowVersion).toBe('1');
    expect(run?.status).toBe('completed');
    expect(texts(outbox)).toEqual(['Answered on v1']);
    expect(service.sends).toHaveLength(1);
    const steps = await engine.listCheckpoints('agora.channel:test:message:v1-1');
    expect(steps.map((step) => [step.name, step.kind])).toEqual([
      ['channel', 'local'],
      ['prepare', 'local'],
      ['act', 'local'],
      ['read', 'local'],
    ]);
  });
});

describe('the channel workflow body against a structural engine', () => {
  /** Register the channel workflows on a fake engine and run version `version`'s body by hand. */
  function bodies(engineExtras: Partial<ChannelWorkflowEngine> = {}) {
    const registered = new Map<
      string,
      (ctx: ChannelWorkflowCtx, input: unknown) => Promise<unknown>
    >();
    const engine: ChannelWorkflowEngine = {
      register: (name, version, fn) => {
        registered.set(`${name}@${version}`, fn);
      },
      start: async () => ({}),
      ...engineExtras,
    };
    return { engine, registered };
  }

  it('dispatches each phase with a liveness timeout (a lost step never hangs) and sleeps durably', async () => {
    const served = new Map<string, (input: unknown) => Promise<unknown>>();
    const { engine, registered } = bodies({
      handleStep: (name, fn) => {
        served.set(name, fn);
      },
    });
    const { adapter, outbox } = fakeAdapter();
    channels.handle(adapter, {
      service: fakeService([{ t: 'text', v: 'ok' }]),
      store: new InMemoryChannelStore(),
      durable: engine,
      actor: () => actor,
      thread: () => 't',
      timeoutMs: 60_000,
      outcomeTimeoutMs: 10_000,
    });
    expect([...served.keys()].sort()).toEqual([
      'agora.channel.act',
      'agora.channel.gather',
      'agora.channel.prepare',
      'agora.channel.read',
      'agora.channel.timeout',
    ]);
    const calls: Array<{ name: string; options: unknown }> = [];
    const ctx: ChannelWorkflowCtx = {
      localStep: (_name, fn) => fn(),
      step: async <T>(name: string, input: unknown, options?: unknown) => {
        calls.push({ name, options });
        // As a worker would: the served handler, over the wire (JSON).
        const handler = served.get(name);
        if (!handler) throw new Error(`no handler for ${name}`);
        return JSON.parse(
          JSON.stringify((await handler(JSON.parse(JSON.stringify(input)))) ?? null),
        ) as T;
      },
      sleepUntil: async () => {},
    };
    const body = registered.get('agora.channel.job@2');
    await body?.(ctx, {
      kind: 'message',
      channel: 'test',
      conversation: 'chat-1',
      message: inbound('hi', { id: 's-1' }),
    });
    expect(texts(outbox)).toEqual(['ok']);
    expect(calls).toEqual([
      { name: 'agora.channel.prepare', options: { timeoutMs: 10 * 60_000, retries: 2 } },
      { name: 'agora.channel.act', options: { timeoutMs: 15 * 60_000, retries: 2 } },
      // The turn's timeout, the outcome's, and a margin.
      {
        name: 'agora.channel.read',
        options: { timeoutMs: 60_000 + 10_000 + 2 * 60_000, retries: 2 },
      },
    ]);
  });

  it('an engine without dispatched steps or sleep: local steps, and a timer for the burst', async () => {
    const { engine, registered } = bodies();
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([{ t: 'text', v: 'ok' }]);
    const handle = channels.handle(adapter, {
      service,
      store: new InMemoryChannelStore(),
      durable: engine,
      actor: () => actor,
      thread: () => 't',
      coalesce: { quietMs: 30 },
    });
    // The webhook records the burst; the engine here only takes the starts.
    const started: unknown[] = [];
    engine.start = async (_workflow, input) => {
      started.push(input);
      return {};
    };
    await handle(makeCtx(inbound('oi', { id: 'b-1' })).ctx);
    await handle(makeCtx(inbound('tudo bem?', { id: 'b-2' })).ctx);
    const local: string[] = [];
    const ctx: ChannelWorkflowCtx = {
      localStep: (name, fn) => {
        local.push(name);
        return fn();
      },
    };
    const body = registered.get('agora.channel.job@2');
    for (const input of started) await body?.(ctx, input);
    expect(service.sends.map((send) => send.message)).toEqual(['oi\n\ntudo bem?']);
    expect(texts(outbox)).toEqual(['ok']);
    // At least one wait (a timer here), then the turn; the second message's job: taken by it.
    expect(local).toContain('gather:1');
    expect(local.filter((step) => !/^gather:[1-9]/.test(step))).toEqual([
      'channel',
      'gather:0',
      'prepare',
      'act',
      'read',
      'channel',
      'gather:0',
    ]);
  });
});
