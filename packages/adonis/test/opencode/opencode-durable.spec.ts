import { InMemoryStateStore, WorkflowEngine } from '@adonis-agora/durable';
import { afterEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/index.js';
import { openCodeDurable } from '../../src/opencode/durable/index.js';
import type { FakeScript } from '../helpers/fake-opencode.js';
import {
  actor,
  approve,
  bootEngine,
  eventually,
  frames,
  framesUntil,
  type Harness,
  textOf,
} from '../helpers/opencode-harness.js';

const askToSend: FakeScript = async (t) => {
  if (t.text.includes('approved the action')) {
    // A fresh session after OpenCode restarted, told what the person decided.
    t.emit('session.text.delta', { delta: 'Sent after the restart.' });
    t.succeed();
    return;
  }
  t.emit('session.text.delta', { delta: 'Sending.' });
  t.emit('permission.asked', { id: 'per_1', action: 'company.gmail__send_email' });
  const reply = await t.next('permission.reply');
  t.emit('session.text.delta', { delta: reply.args.decision === 'once' ? 'Sent.' : 'Not sent.' });
  t.succeed();
};

interface Durable {
  h: Harness;
  engine: WorkflowEngine;
}

async function durable(
  script: FakeScript = askToSend,
  options: Partial<Parameters<typeof openCodeDurable>[0]> = {},
): Promise<Durable> {
  const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
  const h = await bootEngine({
    engine: (host) => openCodeDurable({ host, workflowEngine: engine, ...options }),
    script,
  });
  return { h, engine };
}

async function terminal(engine: WorkflowEngine, runId: string) {
  return engine.waitForRun(runId, { timeoutMs: 5000, terminal: true });
}

describe('openCodeDurable', () => {
  let d: Durable | undefined;
  afterEach(async () => {
    await d?.h.close();
    d = undefined;
  });

  it('runs a turn as a durable workflow', async () => {
    d = await durable(async (t) => {
      t.emit('session.text.delta', { delta: `echo: ${t.text}` });
      t.succeed();
    });
    const { h, engine } = d;
    const { runId, threadId } = await h.service.chat({ actor, message: 'hello' });
    const fs = await frames(h.service, runId);
    expect(textOf(fs)).toBe('echo: hello');
    expect((await terminal(engine, runId)).status).toBe('completed');
    expect((await engine.getRun(runId))?.workflow).toBe('agora.agent.opencode.run');
    expect((await h.store.getThread(threadId))?.messages.map((m) => m.content)).toEqual([
      'hello',
      'echo: hello',
    ]);
  });

  it('waits on a durable signal for the approval and replies to OpenCode', async () => {
    d = await durable();
    const { h, engine } = d;
    const { runId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    await eventually(
      async () => (await engine.getRun(runId))?.status === 'suspended',
      'the run parked on the signal',
    );
    await approve(h.service, 'per_1');
    const fs = await frames(h.service, runId);
    expect(textOf(fs)).toContain('Sent.');
    expect(h.fake.callsOf('permission.reply')[0]?.args).toMatchObject({ decision: 'once' });
    expect((await terminal(engine, runId)).status).toBe('completed');
    // Told once: a replayed step does not answer OpenCode a second time.
    expect(h.fake.callsOf('permission.reply')).toHaveLength(1);
  });

  it('replies from a process that never followed the turn (an app restart while parked)', async () => {
    d = await durable();
    const { h, engine } = d;
    const { runId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    // What a restart leaves: no live turn, no listener — only the journal and the store.
    h.turns.drop(runId);
    await approve(h.service, 'per_1');
    const fs = await frames(h.service, runId);
    expect(textOf(fs)).toContain('Sent.');
    expect((await terminal(engine, runId)).status).toBe('completed');
    expect(h.fake.callsOf('permission.reply')).toHaveLength(1);
  });

  it('answers OpenCode once when the decision lands while the run is still parking', async () => {
    // The runtime resumes a run on a signal that lands between registering its waiter and settling
    // `suspended` — and its suspension re-drives it too. Both in this process, both executions reach
    // `reply:0`: OpenCode must still be answered exactly once.
    const box: { decide?: (() => Promise<void>) | undefined } = {};
    class RacingStore extends InMemoryStateStore {
      override async putSignalWaiter(
        waiter: Parameters<InMemoryStateStore['putSignalWaiter']>[0],
      ): Promise<void> {
        await super.putSignalWaiter(waiter);
        const decide = box.decide;
        box.decide = undefined;
        // Concurrently with the run, which goes on to settle `suspended`.
        void decide?.();
      }
    }
    const engine = new WorkflowEngine({ store: new RacingStore() });
    const h = await bootEngine({
      engine: (host) => openCodeDurable({ host, workflowEngine: engine }),
      script: askToSend,
    });
    d = { h, engine };
    // OpenCode answers over HTTP: slow enough for the second execution to reach the same step.
    const reply = h.fake.permission.reply;
    h.fake.permission.reply = async (args) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return reply(args);
    };
    box.decide = () => approve(h.service, 'per_1');
    const { runId } = await h.service.chat({ actor, message: 'send it' });
    const fs = await frames(h.service, runId);
    expect(textOf(fs)).toContain('Sent.');
    expect((await terminal(engine, runId)).status).toBe('completed');
    expect(h.fake.callsOf('permission.reply')).toHaveLength(1);
    expect(fs.filter((f) => f.kind === 'approval-settled')).toHaveLength(1);
  });

  it('opens a new session told the decision when OpenCode restarted while parked', async () => {
    d = await durable();
    const { h, engine } = d;
    const { runId, threadId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    h.host.bootId = 'boot-2';
    await approve(h.service, 'per_1');
    const fs = await frames(h.service, runId);
    expect(h.fake.callsOf('permission.reply')).toHaveLength(0);
    expect(h.fake.callsOf('session.create')).toHaveLength(2);
    expect(String(h.fake.callsOf('session.prompt')[1]?.args.text)).toContain(
      'approved the action company.gmail__send_email',
    );
    expect(textOf(fs)).toContain('Sent after the restart.');
    expect((await terminal(engine, runId)).status).toBe('completed');
    const messages = (await h.store.getThread(threadId))?.messages ?? [];
    expect(messages.at(-1)?.content).toBe('Sent after the restart.');
  });

  it('cancels a run parked on a person', async () => {
    d = await durable();
    const { h, engine } = d;
    const { runId, threadId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    await h.service.cancel(runId);
    const fs = await frames(h.service, runId);
    expect(fs.at(-1)).toEqual({ kind: 'cancelled' });
    expect(h.fake.callsOf('session.interrupt')).toHaveLength(1);
    expect((await engine.getRun(runId))?.status).toBe('cancelled');
    expect((await h.store.getThread(threadId))?.activeRunId ?? null).toBeNull();
    // The card the run was parked on is not waiting for anything any more.
    expect((await h.store.toolCallApproval('per_1'))?.status).not.toBe('pending_approval');
  });
});

describe('openCodeDurable start options', () => {
  let d: Durable | undefined;
  afterEach(async () => {
    await d?.h.close();
    d = undefined;
  });
  const tenantActor: Actor = { id: 'u1', roles: ['ADMIN'], tenantRef: 't1' };

  it("names runs and starts them the host's way", async () => {
    d = await durable(undefined, {
      runId: (input) => `turn:${input.actor.tenantRef}:${crypto.randomUUID()}`,
      durable: {
        start: (input) => ({
          tags: ['chat', `tenant:${input.actor.tenantRef}`],
          searchAttributes: { tenantId: input.actor.tenantRef ?? '' },
        }),
      },
    });
    const { h, engine } = d;
    h.fake.script = async (t) => t.succeed();
    const { runId } = await h.service.chat({ actor: tenantActor, message: 'hi' });
    expect(runId).toMatch(/^turn:t1:[0-9a-f-]{36}$/);
    await frames(h.service, runId);
    expect((await engine.getRun(runId))?.tags).toEqual(
      expect.arrayContaining(['chat', 'tenant:t1']),
    );
  });

  it('turns a refused start into what the host says', async () => {
    d = await durable(undefined, {
      durable: {
        start: () => ({ concurrency: { key: 'tenant:t1', limit: 0 } }),
        startError: () => new Error('Too many turns at once'),
      },
    });
    await expect(d.h.service.chat({ actor: tenantActor, message: 'hi' })).rejects.toThrow(
      'Too many turns at once',
    );
  });

  it('takes start options and the refusal from the host', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const h = await bootEngine({
      engine: (host) =>
        openCodeDurable({
          workflowEngine: engine,
          host: Object.assign(host, {
            startOptions: async () => ({ concurrency: { key: 'tenant:t1', limit: 0 } }),
            startError: () => new Error('Busy'),
          }),
        }),
    });
    d = { h, engine };
    await expect(h.service.chat({ actor: tenantActor, message: 'hi' })).rejects.toThrow('Busy');
  });
});
