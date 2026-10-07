import { InMemoryStateStore, WorkflowEngine } from '@adonis-agora/durable';
import { afterEach, describe, expect, it } from 'vitest';
import { openCodeDurable } from '../../src/opencode/durable/index.js';
import {
  type OpenCodeAmendment,
  type OpenCodeHost,
  type OpenCodeRunResult,
  openCode,
  type PendingAsk,
} from '../../src/opencode/index.js';
import type { FakeScript } from '../helpers/fake-opencode.js';
import {
  actor,
  approve,
  bootEngine,
  eventually,
  frames,
  framesUntil,
  type Harness,
  type TestHost,
} from '../helpers/opencode-harness.js';

const slack = { source: 'slack', delivery: { channel: 'C1', ts: '1.2' } };

interface Seen {
  asks: Array<{ ask: PendingAsk; hostContext: unknown }>;
  settled: OpenCodeRunResult[];
}

/** The test host plus lifecycle hooks that record what they saw. */
function withHooks(
  host: TestHost,
  seen: Seen,
  amend?: (r: OpenCodeRunResult) => OpenCodeAmendment | undefined,
): OpenCodeHost {
  return Object.assign(host, {
    onAsk: async ({ ask, input }: { ask: PendingAsk; input: { hostContext?: unknown } }) => {
      seen.asks.push({ ask, hostContext: input.hostContext });
    },
    beforeSettle: async (result: OpenCodeRunResult) => amend?.(result),
    onSettled: async (result: OpenCodeRunResult) => {
      seen.settled.push(result);
    },
  });
}

const askThenAnswer: FakeScript = async (t) => {
  t.emit('session.text.delta', { delta: 'Sending.' });
  t.emit('session.step.ended', { tokens: { input: 7, output: 3 }, cost: 0.01 });
  t.emit('permission.asked', { id: 'per_1', action: 'company.gmail__send_email' });
  await t.next('permission.reply');
  t.emit('session.text.delta', { delta: 'Sent.' });
  t.emit('session.step.ended', { tokens: { input: 5, output: 2 }, cost: 0.02 });
  t.succeed();
};

describe('OpenCodeHost lifecycle hooks', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('tells the host about asks and the settled run, with the send hostContext', async () => {
    const seen: Seen = { asks: [], settled: [] };
    h = await bootEngine({
      engine: (host) => openCode({ host: withHooks(host, seen) }),
      script: askThenAnswer,
    });
    const { runId, threadId } = await h.service.chat({
      actor,
      message: 'send it',
      hostContext: slack,
    });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    expect(seen.asks).toEqual([
      { ask: expect.objectContaining({ kind: 'approval', id: 'per_1' }), hostContext: slack },
    ]);
    await approve(h.service, 'per_1');
    await frames(h.service, runId);
    await eventually(() => seen.settled.length === 1, 'onSettled ran');

    const [result] = seen.settled;
    expect(result).toMatchObject({
      runId,
      outcome: { status: 'succeeded' },
      text: 'Sending.\n\nSent.',
      input: expect.objectContaining({ threadId, hostContext: slack }),
      usage: { inputTokens: 12, outputTokens: 5 },
    });
    expect(result?.usage.costUsd).toBeCloseTo(0.03);
    expect(result?.messages).toHaveLength(2);
  });

  it('carries hostContext through the queue to the turn it starts', async () => {
    const seen: Seen = { asks: [], settled: [] };
    let release: (() => void) | undefined;
    h = await bootEngine({
      engine: (host) => openCode({ host: withHooks(host, seen) }),
      script: async (t) => {
        if (t.text === 'first') await new Promise<void>((resolve) => (release = resolve));
        t.succeed();
      },
    });
    const first = await h.service.chat({ actor, message: 'first' });
    await eventually(() => release !== undefined, 'the first turn is running');
    await h.service.send({
      actor,
      message: 'second',
      threadId: first.threadId,
      hostContext: slack,
    });
    release?.();
    await eventually(() => seen.settled.length === 2, 'both runs settled');
    expect(seen.settled.map((r) => r.input.hostContext)).toEqual([undefined, slack]);
  });

  it('appends what beforeSettle adds, and lets it word a failure', async () => {
    const seen: Seen = { asks: [], settled: [] };
    let fail = false;
    h = await bootEngine({
      engine: (host) =>
        openCode({
          host: withHooks(host, seen, (result) =>
            result.outcome.status === 'failed'
              ? { error: 'Your AI budget for today is used up.' }
              : { ui: [{ id: 'notice-1', component: 'GuardrailNotice', props: { kind: 'pii' } }] },
          ),
        }),
      script: async (t) => {
        if (fail) {
          t.emit('session.execution.failed', { error: { message: 'budget_exceeded (402)' } });
          return;
        }
        t.emit('session.text.delta', { delta: 'Done.' });
        t.succeed();
      },
    });
    const ok = await h.service.chat({ actor, message: 'hi' });
    const fs = await frames(h.service, ok.runId);
    expect(fs).toContainEqual({
      kind: 'ui',
      id: 'notice-1',
      component: 'GuardrailNotice',
      props: { kind: 'pii' },
    });
    const last = (await h.store.getThread(ok.threadId))?.messages.at(-1);
    expect(last?.ui).toEqual([
      { id: 'notice-1', component: 'GuardrailNotice', props: { kind: 'pii' } },
    ]);

    fail = true;
    const bad = await h.service.chat({ actor, message: 'again', threadId: ok.threadId });
    await expect(frames(h.service, bad.runId)).rejects.toThrow(
      'Your AI budget for today is used up.',
    );
    await eventually(() => seen.settled.length === 2, 'both runs settled');
    expect(seen.settled[1]?.outcome).toEqual({
      status: 'failed',
      error: 'Your AI budget for today is used up.',
    });
  });

  it("calls the settle hooks as the host's methods, and survives one that throws", async () => {
    const notice = { id: 'n1', component: 'Notice', props: {} };
    h = await bootEngine({
      engine: (host) =>
        openCode({
          // Hooks that read `this` (a class host's methods), one throwing before it returns a promise.
          host: Object.assign(host, {
            notice,
            beforeSettle(this: { notice: typeof notice }): Promise<OpenCodeAmendment> {
              return Promise.resolve({ ui: [this.notice] });
            },
            onSettled(): Promise<void> {
              throw new Error('delivery is down');
            },
          }),
        }),
      script: async (t) => {
        t.emit('session.text.delta', { delta: 'Done.' });
        t.succeed();
      },
    });
    const { runId, threadId } = await h.service.chat({ actor, message: 'hi' });
    const fs = await frames(h.service, runId);
    expect(fs).toContainEqual({ kind: 'ui', ...notice });
    await eventually(
      async () => (await h?.store.getThread(threadId))?.activeRunId == null,
      'released',
    );
  });

  it('carries hostContext through a durable turn', async () => {
    const seen: Seen = { asks: [], settled: [] };
    h = await bootEngine({
      engine: (host) =>
        openCodeDurable({
          host: withHooks(host, seen),
          workflowEngine: new WorkflowEngine({ store: new InMemoryStateStore() }),
        }),
      script: askThenAnswer,
    });
    const { runId } = await h.service.chat({ actor, message: 'send it', hostContext: slack });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    await approve(h.service, 'per_1');
    await frames(h.service, runId);
    await eventually(() => seen.settled.length === 1, 'onSettled ran');
    expect(seen.asks[0]?.hostContext).toEqual(slack);
    expect(seen.settled[0]?.input.hostContext).toEqual(slack);
  });
});

describe('OpenCodeHost session hooks', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('asks the host whether to keep the session, and lets it update the session every turn', async () => {
    const calls: Array<{ sessionId: string; created: boolean }> = [];
    let keep = true;
    h = await bootEngine({
      engine: (host) =>
        openCode({
          host: Object.assign(host, {
            reuse: async () => keep,
            beforePrompt: async ({
              sessionId,
              created,
            }: {
              sessionId: string;
              created: boolean;
            }) => {
              calls.push({ sessionId, created });
            },
          }),
        }),
    });
    const first = await h.service.chat({ actor, message: 'one' });
    await frames(h.service, first.runId);
    const second = await h.service.chat({ actor, message: 'two', threadId: first.threadId });
    await frames(h.service, second.runId);
    keep = false;
    const third = await h.service.chat({ actor, message: 'three', threadId: first.threadId });
    await frames(h.service, third.runId);
    expect(calls).toEqual([
      { sessionId: 'ses_1', created: true },
      { sessionId: 'ses_1', created: false },
      { sessionId: 'ses_2', created: true },
    ]);
  });

  it('prompts the session with what the host makes of the message', async () => {
    h = await bootEngine({
      engine: (host) =>
        openCode({
          host: Object.assign(host, {
            promptFor: async ({ input }: { input: { userText: string } }) => ({
              text: `${input.userText}\n\n[report.pdf]\nQ3 revenue grew 12%.`,
              files: [{ uri: 'data:image/png;base64,AAAA', name: 'chart.png' }],
            }),
          }),
        }),
    });
    const { runId } = await h.service.chat({ actor, message: 'summarize' });
    await frames(h.service, runId);
    expect(h.fake.callsOf('session.prompt')[0]?.args).toMatchObject({
      text: 'summarize\n\n[report.pdf]\nQ3 revenue grew 12%.',
      files: [{ uri: 'data:image/png;base64,AAAA', name: 'chart.png' }],
    });
  });
});
