import { describe, expect, it } from 'vitest';
import { defineCatalog } from '../src/genui/catalog.js';
import { defineSandbox } from '../src/genui/sandbox.js';
import { genuiTools } from '../src/genui/tools.js';
import {
  classifyGenuiError,
  type GenuiCallRow,
  GenuiRunRecorder,
  GenuiTurnTelemetry,
  observeGenuiFrames,
  scrubGenuiError,
  summarizeGenuiCalls,
} from '../src/genui-telemetry.js';
import {
  DefaultRolesPolicy,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  runAgentLoop,
  ToolRegistry,
} from '../src/index.js';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '../src/testing/index.js';

describe('classifyGenuiError', () => {
  it.each([
    [
      'invalid Sandbox code: jsx line 2:3: `flippy.send` — the bridge is `agent.send(payload)`',
      'bridge',
    ],
    [
      'invalid Sandbox code: html line 1:1: `agent.post` — the bridge has one method: `agent.send(payload)`',
      'bridge',
    ],
    ['invalid Sandbox code: jsx: no `App` — define `function App() …`', 'missing-app'],
    [
      'invalid UI tree code: children[0] jsx line 1:2: `<Foo>` is not a kit component — use …',
      'unknown-component',
    ],
    ['invalid Sandbox code: jsx line 2:21: Expected </span>, found </div>', 'syntax'],
    ['invalid UI tree: root.type: unknown component "Nope" (allowed: Card)', 'shape'],
    ['invalid Sandbox props: html: must be string', 'shape'],
    ['Invalid input for tool "ui__sandbox": Required', 'shape'],
    ['component "Chart" is not available here', 'unavailable'],
    ['boom', 'other'],
  ])('%s → %s', (message, category) => {
    expect(classifyGenuiError(message)).toBe(category);
  });
});

describe('scrubGenuiError', () => {
  it('drops quoted values (what a schema echoes back), keeps the code identifiers', () => {
    expect(
      scrubGenuiError(`invalid DealCard props: name: Expected 'a' | 'b', received 'Jane Doe'; "x"`),
    ).toBe(`invalid DealCard props: name: Expected '…' | '…', received '…'; "…"`);
    expect(scrubGenuiError('jsx line 2:3: `flippy.send` — the bridge')).toBe(
      'jsx line 2:3: `flippy.send` — the bridge',
    );
    expect(scrubGenuiError('x'.repeat(400))).toHaveLength(300);
  });
});

describe('observeGenuiFrames', () => {
  it("notes each call's first (preview) and complete frame, passing every chunk through", async () => {
    const written: unknown[] = [];
    let clock = 100;
    const { writer, times } = observeGenuiFrames(
      { write: (frame) => void written.push(frame), end() {} },
      () => clock,
    );
    await writer.write({ t: 'text', v: 'hi' });
    await writer.write({
      t: 'component',
      id: 'c1:ui:0',
      name: 'genui:tree',
      data: {},
      toolCallId: 'c1',
      partial: true,
    });
    clock = 250;
    await writer.write({ t: 'component', id: 'c1:ui:0', name: 'X', data: {}, toolCallId: 'c1' });
    expect(written).toHaveLength(3);
    expect(times.get('c1')).toEqual({ first: 100, complete: 250 });
  });
});

function row(overrides: { [K in keyof GenuiCallRow]?: GenuiCallRow[K] | undefined }): GenuiCallRow {
  return Object.fromEntries(
    Object.entries({
      toolCallId: 'c',
      runId: 'r1',
      threadId: 't1',
      actorRef: 'u1',
      step: 0,
      toolName: 'ui__sandbox',
      channel: 'web',
      mode: 'sandbox',
      modelId: 'm1',
      attempt: 1,
      outcome: 'ok',
      validity: 'first_try',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
      payloadBytes: 100,
      createdAt: new Date('2026-10-01T10:00:00Z'),
      ...overrides,
    }).filter(([, value]) => value !== undefined),
  ) as unknown as GenuiCallRow;
}

describe('summarizeGenuiCalls', () => {
  it('first-try rate per tool and model, errors, cost per turn and day, latency per turn', () => {
    const stats = summarizeGenuiCalls([
      row({ toolCallId: 'a', runId: 'r1', firstFrameMs: 100, completeFrameMs: 400 }),
      row({
        toolCallId: 'b',
        runId: 'r2',
        outcome: 'error',
        validity: 'failed',
        errorCategory: 'bridge',
        errorMessage: 'jsx line 1:1: `flippy.send` — the bridge is `agent.send(payload)`',
        firstFrameMs: 200,
      }),
      row({
        toolCallId: 'c',
        runId: 'r2',
        step: 1,
        attempt: 2,
        validity: 'retried',
        firstFrameMs: 900,
        completeFrameMs: 1200,
        costUsd: 0.03,
      }),
      row({
        toolCallId: 'd',
        runId: 'r3',
        toolName: 'ui__render',
        mode: 'tree',
        modelId: 'm2',
        costUsd: undefined,
        createdAt: new Date('2026-10-02T10:00:00Z'),
      }),
    ]);
    expect(stats.totals).toMatchObject({
      calls: 4,
      turns: 3,
      firstAttempts: 3,
      firstTrySuccesses: 2,
      retried: 1,
      failed: 1,
    });
    expect(stats.totals.firstTryRate).toBeCloseTo(2 / 3);
    expect(stats.totals.costUsd).toBeCloseTo(0.05);
    expect(stats.byToolModel).toEqual([
      expect.objectContaining({
        toolName: 'ui__sandbox',
        modelId: 'm1',
        calls: 3,
        firstAttempts: 2,
        firstTrySuccesses: 1,
        firstTryRate: 0.5,
      }),
      expect.objectContaining({
        toolName: 'ui__render',
        modelId: 'm2',
        firstTryRate: 1,
        costUsd: null,
      }),
    ]);
    expect(stats.errors).toEqual([
      expect.objectContaining({ category: 'bridge', toolName: 'ui__sandbox', count: 1 }),
    ]);
    expect(stats.byDay.map((day) => [day.day, day.calls, day.turns])).toEqual([
      ['2026-10-01', 3, 2],
      ['2026-10-02', 1, 1],
    ]);
    // r1 = 0.01, r2 = 0.04; r3 has no priced row.
    expect(stats.costPerTurn.turns).toBe(3);
    expect(stats.costPerTurn.avgUsd).toBeCloseTo(0.025);
    // Per turn: the earliest first frame, and the earliest complete frame of an accepted call.
    expect(stats.latency.firstFrame).toEqual({ samples: 2, p50Ms: 200, p95Ms: 200 });
    expect(stats.latency.complete).toEqual({ samples: 2, p50Ms: 1200, p95Ms: 1200 });
  });

  it('is all zeros and nulls without rows', () => {
    const stats = summarizeGenuiCalls([]);
    expect(stats.totals.firstTryRate).toBeNull();
    expect(stats.latency.firstFrame).toEqual({ samples: 0, p50Ms: null, p95Ms: null });
  });
});

describe('GenuiTurnTelemetry', () => {
  const facts = {
    runId: 'r1',
    threadId: 't1',
    actorRef: 'u1',
    channel: 'web',
    modelId: 'm',
    startedAt: 1000,
    costSource: 'provider' as const,
    markerOf: (name: string) =>
      name === 'ui__render'
        ? { mode: 'tree' as const }
        : name === 'ui__sandbox'
          ? { mode: 'sandbox' as const, telemetry: { samplePayloads: true } }
          : undefined,
    frames: new Map(),
    now: 5000,
  };

  it('counts attempts across steps and UI tools, shares the step by characters written', () => {
    const telemetry = new GenuiTurnTelemetry();
    const first = telemetry.rows({
      ...facts,
      step: 0,
      usage: { inputTokens: 100, outputTokens: 40 },
      costUsd: 0.4,
      text: '',
      calls: [
        { id: 'a', name: 'ui__render', input: { type: 'X' } },
        { id: 'b', name: 'lookup', input: { type: 'X' } },
      ],
      results: [
        { id: 'a', error: 'invalid UI tree: root.type: unknown component "X"' },
        { id: 'b' },
      ],
    });
    expect(first).toEqual([
      expect.objectContaining({
        toolCallId: 'a',
        attempt: 1,
        outcome: 'error',
        validity: 'failed',
        errorCategory: 'shape',
        errorMessage: 'invalid UI tree: root.type: unknown component "…"',
        inputTokens: 50,
        outputTokens: 20,
        costUsd: 0.2,
        costSource: 'provider',
      }),
    ]);
    expect(first[0]).not.toHaveProperty('payload');
    const second = telemetry.rows({
      ...facts,
      step: 1,
      usage: { inputTokens: 10, outputTokens: 4 },
      costUsd: null,
      text: '',
      calls: [{ id: 'c', name: 'ui__sandbox', input: { html: '<b>secret</b>' } }],
      results: [{ id: 'c', output: { shown: 'Sandbox', id: 'c:ui:0' } }],
      frames: new Map([['c', { first: 2000, complete: 3000 }]]),
    });
    expect(second).toEqual([
      expect.objectContaining({
        attempt: 2,
        validity: 'retried',
        firstFrameMs: 1000,
        completeFrameMs: 2000,
        payload: '{"html":"<b>secret</b>"}',
      }),
    ]);
    expect(second[0]).not.toHaveProperty('costUsd');
  });

  it('records nothing for a tool whose telemetry is off', () => {
    const rows = new GenuiTurnTelemetry().rows({
      ...facts,
      markerOf: () => ({ mode: 'tree', telemetry: false }),
      step: 0,
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: null,
      text: '',
      calls: [{ id: 'a', name: 'ui__render', input: {} }],
      results: [{ id: 'a' }],
    });
    expect(rows).toEqual([]);
  });
});

/** Writes a sandbox with a wrong bridge, reads the tool error, then writes it right. */
class RetryingModel implements ModelProvider {
  readonly errors: string[] = [];
  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const last = [...args.messages].reverse().find((message) => message.toolResults !== undefined);
    const error = last?.toolResults?.[0]?.error;
    if (error !== undefined) this.errors.push(error);
    const step = args.messages.filter((message) => message.role === 'assistant').length;
    const html =
      step === 0
        ? '<button onclick="flippy.send({ text: \'go\' })">Go</button>'
        : '<button onclick="agent.send({ text: \'go\' })">Go</button>';
    return {
      text: '',
      toolCalls: [{ id: `call-${step}`, name: 'ui__sandbox', input: { title: 'Go', html } }],
      usage: { inputTokens: 100, outputTokens: 30 },
      costUsd: 0.002,
    };
  }
}

describe('a bad sandbox in the agent loop (scripted model)', () => {
  async function run(telemetry?: { samplePayloads: boolean }) {
    const store = new InMemoryAgentStore();
    const registry = new ToolRegistry();
    for (const tool of genuiTools(defineCatalog([defineSandbox()]), {
      componentTools: ['Sandbox'],
      terminal: true,
      ...(telemetry !== undefined ? { telemetry } : {}),
    })) {
      registry.register(tool.spec, tool.handler);
    }
    const actor = { id: 'u1', roles: ['ADMIN'] };
    const thread = await store.createThread({ actor });
    const sink = new InMemoryTokenStreamSink();
    const model = new RetryingModel();
    await runAgentLoop(
      {
        model,
        store,
        registry,
        rolesPolicy: new DefaultRolesPolicy(),
        modelId: 'scripted',
        day: '2026-10-11',
        systemPrompt: 'test',
      },
      {
        threadId: thread.id,
        actor,
        userText: 'a go button',
        pageContext: { channel: 'web' },
      },
      {
        runId: 'run-1',
        openSink: () => sink.open('run-1'),
        awaitApproval: async () => ({ approved: true }),
        step: (_name, fn) => fn(),
      },
    );
    return { store, model };
  }

  it('gets the precise error, retries once, and both attempts are recorded as metadata', async () => {
    const { store, model } = await run();
    expect(model.errors).toEqual([
      'invalid Sandbox code: html line 1:18: `flippy.send` — the bridge is `agent.send(payload)`',
    ]);
    const rows = store.genuiCallRows();
    expect(rows).toEqual([
      expect.objectContaining({
        toolCallId: 'call-0',
        runId: 'run-1',
        toolName: 'ui__sandbox',
        mode: 'sandbox',
        channel: 'web',
        modelId: 'scripted',
        step: 0,
        attempt: 1,
        validity: 'failed',
        errorCategory: 'bridge',
        costUsd: 0.002,
        costSource: 'provider',
      }),
      expect.objectContaining({
        toolCallId: 'call-1',
        step: 1,
        attempt: 2,
        validity: 'retried',
        outcome: 'ok',
      }),
    ]);
    // The call is all the step wrote: the whole step is the UI's.
    expect(rows[1]).toMatchObject({ inputTokens: 100, outputTokens: 30 });
    expect(rows[1]?.completeFrameMs).toBeGreaterThanOrEqual(0);
    expect(rows[1]?.firstFrameMs).toBeLessThanOrEqual(rows[1]?.completeFrameMs ?? 0);
    // Privacy default: no generated code, no props.
    for (const each of rows) {
      expect(each.payload).toBeUndefined();
      expect(JSON.stringify(each)).not.toContain('<button');
    }
  });

  it('samples the payload only when asked', async () => {
    const { store } = await run({ samplePayloads: true });
    expect(store.genuiCallRows()[1]?.payload).toContain('agent.send');
  });
});

describe('GenuiRunRecorder (UI calls made outside the loop)', () => {
  const base = {
    runId: 'r1',
    threadId: 't1',
    actorRef: 'u1',
    channel: 'web',
    modelId: 'oc',
    marker: { mode: 'sandbox' as const },
  };

  it('records each call, counting attempts per run; never changes what the call returns', async () => {
    const recorded: unknown[] = [];
    const store = {
      recordGenuiCalls: async (rows: readonly unknown[]) => void recorded.push(...rows),
    };
    const recorder = new GenuiRunRecorder();
    await expect(
      recorder.track(
        { ...base, store, call: { id: 'a', name: 'ui__sandbox', input: {} } },
        async () => {
          throw new Error(
            'invalid Sandbox code: html line 1:1: `x.send` — the bridge is `agent.send(payload)`',
          );
        },
      ),
    ).rejects.toThrow('the bridge is');
    const out = await recorder.track(
      { ...base, store, call: { id: 'b', name: 'ui__sandbox', input: {} } },
      async () => ({ shown: 'Sandbox', id: 'b:ui:0' }),
    );
    expect(out).toEqual({ shown: 'Sandbox', id: 'b:ui:0' });
    expect(recorded).toEqual([
      expect.objectContaining({
        toolCallId: 'a',
        attempt: 1,
        validity: 'failed',
        errorCategory: 'bridge',
      }),
      expect.objectContaining({ toolCallId: 'b', attempt: 2, validity: 'retried', inputTokens: 0 }),
    ]);
    expect(recorded[1]).not.toHaveProperty('firstFrameMs');
  });

  it('records nothing for a tool that is not a UI tool, and survives a failing store', async () => {
    const recorded: unknown[] = [];
    const recorder = new GenuiRunRecorder();
    await recorder.track(
      {
        ...base,
        marker: undefined,
        store: {
          recordGenuiCalls: async (rows: readonly unknown[]) => void recorded.push(...rows),
        },
        call: { id: 'a', name: 'lookup', input: {} },
      },
      async () => 1,
    );
    expect(recorded).toEqual([]);
    const value = await recorder.track(
      {
        ...base,
        store: { recordGenuiCalls: async () => Promise.reject(new Error('db down')) },
        call: { id: 'b', name: 'ui__sandbox', input: {} },
      },
      async () => 2,
    );
    expect(value).toBe(2);
  });
});
