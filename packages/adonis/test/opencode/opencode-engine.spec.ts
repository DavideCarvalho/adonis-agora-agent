import { afterEach, describe, expect, it } from 'vitest';
import { type AgentEngine, assertRunnable } from '../../src/index.js';
import { openCode } from '../../src/opencode/index.js';
import { FakeOpenCode } from '../helpers/fake-opencode.js';
import {
  actor,
  answer,
  approve,
  bare,
  bootEngine,
  frames,
  framesUntil,
  type Harness,
  reject,
  TestHost,
  textOf,
} from '../helpers/opencode-harness.js';

describe('openCode engine', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('runs a turn on an OpenCode session and streams it in the library protocol', async () => {
    h = await bootEngine({ engine: (host) => openCode({ host }) });
    const { runId, threadId } = await h.service.chat({ actor, message: 'hello' });
    const fs = await frames(h.service, runId);

    expect(textOf(fs)).toBe('echo: hello');
    expect(fs.map((f) => f.kind)).toEqual(['step-start', 'text', 'step-finish']);
    expect(fs.find((f) => f.kind === 'step-finish')).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const thread = await h.store.getThread(threadId);
    expect(thread?.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello'],
      ['assistant', 'echo: hello'],
    ]);
    expect(thread?.title).toBe('hello');
    expect(thread?.activeRunId ?? null).toBeNull();
    // The run's row, as the governance read-model and the ownership checks read it.
    expect(await h.store.getRunActorRef(runId)).toBe('u1');
  });

  it("gives the session the agent's prompt, its persona and the host's entries", async () => {
    h = await bootEngine({
      engine: (host) =>
        openCode({
          host: Object.assign(host, {
            instructions: async () => ({ 'flippy.profile': 'Davi writes short emails.' }),
          }),
        }),
      defaultAgent: {
        systemPrompt: (ctx) => `You are Flippy, talking to ${ctx.actor.id}.`,
        personas: [
          {
            id: 'terse',
            label: 'Terse',
            systemPrompt: (ctx) => `${ctx.basePrompt}\n\nBe terse.`,
          },
        ],
      },
    });
    const { runId } = await h.service.chat({ actor, message: 'hi', personaId: 'terse' });
    await frames(h.service, runId);

    const [create] = h.fake.callsOf('session.create');
    expect(create?.args).toMatchObject({
      location: { directory: '/work/u1' },
      permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    });
    const entries = Object.fromEntries(
      h.fake.callsOf('session.instructions.entry.put').map((c) => [c.args.key, c.args.value]),
    );
    expect(entries['agora.system']).toBe('You are Flippy, talking to u1.\n\nBe terse.');
    expect(entries['flippy.profile']).toBe('Davi writes short emails.');
  });

  it('keeps one session per thread, and a new one (told the conversation) after a restart', async () => {
    h = await bootEngine({ engine: (host) => openCode({ host }) });
    const first = await h.service.chat({ actor, message: 'one' });
    await frames(h.service, first.runId);
    const second = await h.service.chat({ actor, message: 'two', threadId: first.threadId });
    await frames(h.service, second.runId);
    expect(h.fake.callsOf('session.create')).toHaveLength(1);
    expect(h.fake.callsOf('session.prompt').map((c) => c.args.sessionID)).toEqual([
      'ses_1',
      'ses_1',
    ]);

    h.host.bootId = 'boot-2';
    const third = await h.service.chat({ actor, message: 'three', threadId: first.threadId });
    await frames(h.service, third.runId);
    expect(h.fake.callsOf('session.create')).toHaveLength(2);
    const history = h.fake
      .callsOf('session.instructions.entry.put')
      .find((c) => c.args.key === 'agora.history');
    expect(history?.args.sessionID).toBe('ses_2');
    expect(history?.args.value).toContain(
      'User: one\nAssistant: echo: one\nUser: two\nAssistant: echo: two',
    );
  });

  it('nests code-mode calls under execute and records them on the message', async () => {
    h = await bootEngine({
      engine: (host) => openCode({ host }),
      script: async (t) => {
        t.emit('session.tool.input.started', { id: 'call_1', name: 'execute' });
        t.emit('session.tool.called', {
          id: 'call_1',
          input: { code: 'tools.company.gmail__search()' },
        });
        t.emit('session.tool.progress', {
          id: 'call_1',
          metadata: {
            toolCalls: [{ tool: 'company.gmail__search', status: 'running', input: { q: 'x' } }],
          },
        });
        t.emit('session.tool.success', {
          id: 'call_1',
          metadata: { toolCalls: [{ tool: 'company.gmail__search', status: 'completed' }] },
        });
        t.emit('session.step.ended', { tokens: { input: 3, output: 1 } });
        t.emit('session.text.delta', { delta: 'Found 2 threads.' });
        t.emit('session.step.ended', { tokens: { input: 4, output: 2 } });
        t.succeed();
      },
    });
    const { runId, threadId } = await h.service.chat({ actor, message: 'search' });
    const fs = await frames(h.service, runId);

    expect(fs).toContainEqual({
      kind: 'tool-input-available',
      id: 'call_1.0',
      name: 'company.gmail__search',
      input: { q: 'x' },
      toolKind: 'read',
      parentId: 'call_1',
    });
    expect(fs).toContainEqual({ kind: 'tool-output', id: 'call_1', output: { ok: true } });
    expect(fs.filter((f) => f.kind === 'step-start')).toHaveLength(2);

    const answerMessage = (await h.store.getThread(threadId))?.messages.at(-1);
    expect(answerMessage?.content).toBe('Found 2 threads.');
    expect(answerMessage?.toolCalls?.map((c) => [c.id, c.name, c.parentId])).toEqual([
      ['call_1', 'execute', undefined],
      ['call_1.0', 'company.gmail__search', 'call_1'],
    ]);
    expect(answerMessage?.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  });

  it('parks on an OpenCode permission until the approve route decides it', async () => {
    h = await bootEngine({
      engine: (host) => openCode({ host }),
      script: async (t) => {
        t.emit('session.text.delta', { delta: 'Sending it.' });
        t.emit('permission.asked', {
          id: 'per_1',
          action: 'company.gmail__send_email',
          metadata: { input: { to: 'priya@harbor.com' } },
        });
        const reply = await t.next('permission.reply');
        t.emit('session.text.delta', {
          delta: reply.args.decision === 'once' ? 'Sent.' : 'Not sent.',
        });
        t.succeed();
      },
    });
    const { runId, threadId } = await h.service.chat({ actor, message: 'send it' });
    const asked = await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    expect(asked.slice(-2).map(bare)).toEqual([
      {
        kind: 'tool-input-available',
        id: 'per_1',
        name: 'company.gmail__send_email',
        input: { to: 'priya@harbor.com' },
        toolKind: 'action',
      },
      { kind: 'approval-requested', id: 'per_1', approver: 'requester' },
    ]);
    // The approval frame names the parked run, so a reader can answer it without the call's frames.
    expect(asked.at(-1)).toMatchObject({ runId, toolName: 'company.gmail__send_email' });

    await approve(h.service, 'per_1', { via: 'web' });
    const fs = await frames(h.service, runId);
    expect(h.fake.callsOf('permission.reply')[0]?.args).toMatchObject({
      requestID: 'per_1',
      decision: 'once',
    });
    expect(fs).toContainEqual(
      expect.objectContaining({
        kind: 'approval-settled',
        id: 'per_1',
        status: 'approved',
        decidedVia: 'web',
      }),
    );
    expect(textOf(fs)).toContain('Sent.');

    const messages = (await h.store.getThread(threadId))?.messages ?? [];
    expect(messages.map((m) => m.content)).toEqual(['send it', 'Sending it.', 'Sent.']);
    expect(messages[1]?.toolResults).toEqual([
      { id: 'per_1', name: 'company.gmail__send_email', output: { approved: true } },
    ]);
  });

  it('tells OpenCode why when the person rejects', async () => {
    h = await bootEngine({
      engine: (host) => openCode({ host }),
      script: async (t) => {
        t.emit('permission.asked', { id: 'per_1', action: 'company.gmail__send_email' });
        await t.next('permission.reply');
        t.succeed();
      },
    });
    const { runId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    await reject(h.service, 'per_1', 'wrong recipient');
    const fs = await frames(h.service, runId);

    const reply = h.fake.callsOf('permission.reply')[0]?.args;
    expect(reply).toMatchObject({ decision: 'reject' });
    expect(String(reply?.message)).toContain('wrong recipient');
    expect(fs).toContainEqual({
      kind: 'tool-output-denied',
      id: 'per_1',
      reason: 'wrong recipient',
    });
  });

  it('refuses answers addressed at an approval, and keeps it waiting', async () => {
    h = await bootEngine({
      engine: (host) => openCode({ host }),
      script: async (t) => {
        t.emit('permission.asked', { id: 'per_1', action: 'company.gmail__send_email' });
        await t.next('permission.reply');
        t.succeed();
      },
    });
    const { runId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    await expect(answer(h.service, 'per_1', { x: ['y'] })).rejects.toThrow(/approve\/reject/);
    await approve(h.service, 'per_1');
    await frames(h.service, runId);
    expect(h.fake.callsOf('permission.reply')[0]?.args).toMatchObject({ decision: 'once' });
  });

  it('asks a form as an elicitation and replies with typed answers', async () => {
    h = await bootEngine({
      engine: (host) => openCode({ host }),
      script: async (t) => {
        t.emit('form.created', {
          form: {
            id: 'frm_1',
            sessionID: t.sessionId,
            title: 'Before I draft',
            fields: [
              {
                key: 'tone',
                title: 'Tone?',
                options: [
                  { value: 'formal', label: 'Formal' },
                  { value: 'casual', label: 'Casual' },
                ],
              },
              { key: 'words', title: 'How many words?', type: 'number' },
            ],
          },
        });
        await t.next('session.form.reply');
        t.emit('session.text.delta', { delta: 'Drafted.' });
        t.succeed();
      },
    });
    const { runId } = await h.service.chat({ actor, message: 'draft' });
    const asked = await framesUntil(h.service, runId, (f) => f.kind === 'elicitation');
    expect(asked.at(-1)).toMatchObject({
      kind: 'elicitation',
      id: 'frm_1',
      runId,
      request: {
        source: 'ask',
        preamble: 'Before I draft',
        questions: [{ id: 'tone' }, { id: 'words' }],
      },
    });
    // The answer route checks typed answers against the recorded questions before signalling.
    expect(await h.service.answerProblem('frm_1', { words: ['many'] })).toMatch(/words/);

    await answer(h.service, 'frm_1', { tone: ['casual'], words: ['120'] });
    const fs = await frames(h.service, runId);
    expect(h.fake.callsOf('session.form.reply')[0]?.args.answer).toEqual({
      tone: 'casual',
      words: 120,
    });
    expect(fs).toContainEqual(expect.objectContaining({ kind: 'tool-output', id: 'frm_1' }));
    expect(textOf(fs)).toBe('Drafted.');
  });

  it('interrupts the session on cancel and ends the stream as cancelled', async () => {
    h = await bootEngine({
      engine: (host) => openCode({ host }),
      script: async (t) => {
        t.emit('session.text.delta', { delta: 'Working…' });
        // Never finishes on its own.
      },
    });
    const { runId, threadId } = await h.service.chat({ actor, message: 'long task' });
    await framesUntil(h.service, runId, (f) => f.kind === 'text');
    await h.service.cancel(runId);
    const fs = await frames(h.service, runId);

    expect(h.fake.callsOf('session.interrupt')).toHaveLength(1);
    expect(fs.at(-1)).toEqual({ kind: 'cancelled' });
    expect((await h.store.getThread(threadId))?.activeRunId ?? null).toBeNull();
  });

  it('fails the stream with a typed error when the execution fails', async () => {
    h = await bootEngine({
      engine: (host) => openCode({ host }),
      script: async (t) => {
        t.emit('session.execution.failed', { error: { message: 'provider overloaded' } });
      },
    });
    const { runId } = await h.service.chat({ actor, message: 'hi' });
    await expect(frames(h.service, runId)).rejects.toMatchObject({
      code: 'run_failed',
      message: 'provider overloaded',
    });
  });

  it('starts the next queued message when a turn settles', async () => {
    let release: (() => void) | undefined;
    h = await bootEngine({
      engine: (host) => openCode({ host }),
      script: async (t) => {
        t.emit('session.text.delta', { delta: `echo: ${t.text}` });
        if (t.text === 'first') await new Promise<void>((resolve) => (release = resolve));
        t.succeed();
      },
    });
    const first = await h.service.chat({ actor, message: 'first' });
    await framesUntil(h.service, first.runId, (f) => f.kind === 'text');
    const queued = await h.service.send({
      actor,
      message: 'second',
      threadId: first.threadId,
      hostContext: { source: 'slack' },
    });
    expect(queued).toMatchObject({ queued: true });
    // The wire view of the queue never carries the host's context.
    expect(JSON.stringify((queued as { queue: unknown }).queue)).not.toContain('slack');
    release?.();
    const fs = await frames(h.service, first.runId);
    const started = fs.find((f) => f.kind === 'queue' && f.started !== undefined);
    expect(started).toBeDefined();
    const next = (started as { started: { runId: string } }).started.runId;
    expect(textOf(await frames(h.service, next))).toBe('echo: second');
  });
});

describe('engine wiring', () => {
  const engine = (durable = false): AgentEngine => ({
    name: 'opencode',
    durable,
    createRunner: () => {
      throw new Error('unused');
    },
  });

  it('needs a model or an engine', () => {
    expect(() => assertRunnable({})).toThrow(/set `model`.*or `engine`/);
    expect(() => assertRunnable({ engine: engine() })).not.toThrow();
  });

  it('refuses durable with an engine that is not durable', () => {
    expect(() => assertRunnable({ engine: engine(), durable: true })).toThrow(/opencode/);
    expect(() => assertRunnable({ engine: engine(true), durable: true })).not.toThrow();
  });

  it('builds a host class through the container', async () => {
    const fake = new FakeOpenCode();
    class ContainerHost extends TestHost {}
    const made: unknown[] = [];
    const built = openCode({ host: ContainerHost });
    await expect(
      (built as unknown as { buildTurns(c: unknown): Promise<unknown> }).buildTurns({}),
    ).rejects.toThrow(/container/);
    await (built as unknown as { buildTurns(c: unknown): Promise<unknown> }).buildTurns({
      make: async (klass: new (f: FakeOpenCode) => unknown) => {
        made.push(klass);
        return new klass(fake);
      },
    });
    expect(made).toEqual([ContainerHost]);
  });
});
