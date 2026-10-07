import { afterEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/index.js';
import { keyValueOpenCodeSessionStore, openCode } from '../../src/opencode/index.js';
import type { OpenCodeToolCall } from '../../src/opencode/turns.js';
import type { FakeTurn } from '../helpers/fake-opencode.js';
import {
  actor,
  bootEngine,
  eventually,
  frames,
  framesUntil,
  type Harness,
} from '../helpers/opencode-harness.js';

const meta = (sessionId: string) => ({ 'ai.opencode/sessionID': sessionId });
const call = (who: Actor, m: OpenCodeToolCall['meta'], requestId = 'r1'): OpenCodeToolCall => ({
  actor: who,
  serverKey: 'tenant-1',
  requestId,
  meta: m,
});

/** A script that holds the execution open until the test lets it finish. */
function holdOpen() {
  const gate: { turn?: FakeTurn; release?: () => void } = {};
  const script = async (t: FakeTurn) => {
    gate.turn = t;
    t.emit('session.text.delta', { delta: 'Here is the chart.' });
    await new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    t.succeed();
  };
  return { gate, script };
}

/** What another replica sees: nothing of the turn is live there. */
function asAnotherProcess(h: Harness): () => void {
  const live = (h.turns as unknown as { live: Map<string, unknown> }).live;
  const saved = new Map(live);
  live.clear();
  return () => {
    for (const [k, v] of saved) live.set(k, v);
  };
}

describe('openCode engine: follow-ups', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it("routes a tool's emitUi into the turn's stream and message", async () => {
    const { gate, script } = holdOpen();
    h = await bootEngine({ engine: (host) => openCode({ host }), script });
    const { runId, threadId } = await h.service.chat({ actor, message: 'chart it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'text');

    const context = await h.turns.callContext(call(actor, meta('ses_1')));
    expect(context).toMatchObject({ runId, ctx: { threadId, runId } });
    await context?.ctx.emitUi('Chart', { series: [1, 2] }, { id: 'chart-1' });
    gate.release?.();
    const fs = await frames(h.service, runId);

    expect(fs).toContainEqual({
      kind: 'ui',
      id: 'chart-1',
      component: 'Chart',
      props: { series: [1, 2] },
    });
    const answer = (await h.store.getThread(threadId))?.messages.at(-1);
    expect(answer?.content).toBe('Here is the chart.');
    expect(answer?.ui).toEqual([{ id: 'chart-1', component: 'Chart', props: { series: [1, 2] } }]);
  });

  it('finds the turn of a session this process does not follow, through OpenCode', async () => {
    const { gate, script } = holdOpen();
    h = await bootEngine({ engine: (host) => openCode({ host }), script });
    const { runId, threadId } = await h.service.chat({ actor, message: 'chart it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'text');
    const restore = asAnotherProcess(h);

    const context = await h.turns.callContext(call(actor, meta('ses_1')));
    expect(context).toMatchObject({ runId, ctx: { threadId, runId } });
    await context?.ctx.emitUi('Chart', { series: [3] }, { id: 'chart-2' });
    expect(h.fake.callsOf('session.get')[0]?.args).toEqual({ sessionID: 'ses_1' });
    const messages = (await h.store.getThread(threadId))?.messages ?? [];
    expect(messages.at(-1)?.ui).toEqual([
      { id: 'chart-2', component: 'Chart', props: { series: [3] } },
    ]);

    restore();
    gate.release?.();
    const fs = await frames(h.service, runId);
    expect(fs).toContainEqual(expect.objectContaining({ kind: 'ui', id: 'chart-2' }));
  });

  it('gives a session to no one but the person whose turn it is', async () => {
    const { gate, script } = holdOpen();
    h = await bootEngine({ engine: (host) => openCode({ host }), script });
    const { runId } = await h.service.chat({ actor, message: 'chart it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'text');
    const stranger: Actor = { id: 'u2', roles: ['ADMIN'] };
    expect(await h.turns.callContext(call(stranger, meta('ses_1')))).toBeUndefined();
    // A token issued for another OpenCode server does not reach this one's sessions.
    expect(
      await h.turns.callContext({ ...call(actor, meta('ses_1')), serverKey: 'tenant-2' }),
    ).toBeUndefined();

    // Through OpenCode too (a session this process does not follow).
    const restore = asAnotherProcess(h);
    expect(await h.turns.callContext(call(stranger, meta('ses_1')))).toBeUndefined();
    // Only OpenCode's own key names a session.
    expect(await h.turns.callContext(call(actor, { sessionId: 'ses_1' }))).toBeUndefined();
    restore();
    gate.release?.();
    await frames(h.service, runId);
    // Once the turn is over, the session serves nobody.
    expect(await h.turns.callContext(call(actor, meta('ses_1')))).toBeUndefined();
  });

  it('keeps the components of two calls apart when neither names an id', async () => {
    const { gate, script } = holdOpen();
    h = await bootEngine({ engine: (host) => openCode({ host }), script });
    const { runId, threadId } = await h.service.chat({ actor, message: 'two charts' });
    await framesUntil(h.service, runId, (f) => f.kind === 'text');
    const first = await h.turns.callContext(call(actor, meta('ses_1'), '1'));
    const second = await h.turns.callContext(call(actor, meta('ses_1'), '2'));
    await first?.ctx.emitUi('Chart', { n: 1 });
    await second?.ctx.emitUi('Chart', { n: 2 });
    gate.release?.();
    await frames(h.service, runId);
    const ui = (await h.store.getThread(threadId))?.messages.at(-1)?.ui ?? [];
    expect(ui.map((c) => c.props)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(new Set(ui.map((c) => c.id)).size).toBe(2);
  });

  it('leaves a call from an unknown session with no turn', async () => {
    h = await bootEngine({ engine: (host) => openCode({ host }) });
    expect(await h.turns.callContext(call(actor, undefined))).toBeUndefined();
    expect(await h.turns.callContext(call(actor, meta('ses_nope')))).toBeUndefined();
  });

  it('keeps sessions in a shared key-value store', async () => {
    const kv = new Map<string, string>();
    const store = keyValueOpenCodeSessionStore({
      get: async (k) => kv.get(k) ?? null,
      set: async (k, v) => kv.set(k, v),
    });
    expect(await store.get('t1')).toBeNull();
    await store.set('t1', { sessionId: 'ses_1', serverKey: 'tenant-1', bootId: 'b1' });
    expect(await store.get('t1')).toEqual({
      sessionId: 'ses_1',
      serverKey: 'tenant-1',
      bootId: 'b1',
    });
    expect([...kv.keys()]).toEqual(['agora:opencode:session:t1']);

    // An engine on it finds the session a thread already has.
    const shared = new Map<string, string>();
    const sessions = keyValueOpenCodeSessionStore({
      get: async (k) => shared.get(k) ?? null,
      set: async (k, v) => shared.set(k, v),
    });
    h = await bootEngine({ engine: (host) => openCode({ host, sessions }) });
    const first = await h.service.chat({ actor, message: 'one' });
    await frames(h.service, first.runId);
    await eventually(() => shared.size === 1, 'the session was stored');
    expect(JSON.parse([...shared.values()][0] ?? '{}')).toMatchObject({
      sessionId: 'ses_1',
      agentName: 'default',
    });
  });
});

describe('openCode engine: host-side pushes and live runs', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('pushes into the run a session serves, and reports the runs it follows', async () => {
    const { gate, script } = holdOpen();
    h = await bootEngine({ engine: (host) => openCode({ host }), script });
    const { runId, threadId } = await h.service.chat({ actor, message: 'go' });
    await framesUntil(h.service, runId, (f) => f.kind === 'text');
    expect(h.turns.liveRuns()).toEqual([runId]);
    expect(
      await h.turns.pushToSession('ses_1', {
        id: 'card-1',
        component: 'Artifact',
        props: { id: 'a1' },
      }),
    ).toBe(true);
    expect(await h.turns.pushToSession('ses_nope', { id: 'x', component: 'X', props: {} })).toBe(
      false,
    );
    gate.release?.();
    await frames(h.service, runId);
    expect((await h.store.getThread(threadId))?.messages.at(-1)?.ui).toEqual([
      { id: 'card-1', component: 'Artifact', props: { id: 'a1' } },
    ]);
    expect(h.turns.liveRuns()).toEqual([]);
  });

  it('names its runs the way the host says', async () => {
    h = await bootEngine({
      engine: (host) =>
        openCode({ host, runId: (input) => `turn:${input.actor.id}:${crypto.randomUUID()}` }),
    });
    const { runId } = await h.service.chat({ actor, message: 'hi' });
    expect(runId).toMatch(/^turn:u1:[0-9a-f-]{36}$/);
    await frames(h.service, runId);
  });
});
