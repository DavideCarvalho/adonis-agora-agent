import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { decodeFrame, foldPart, parseSseEvent } from '../src/client/index.js';
import {
  type Actor,
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  AgentSseEncoder,
  type AgentStreamEvent,
  DefaultToolAuthorizer,
  frameToEvents,
  frameToSse,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  type StreamFrame,
  ToolRegistry,
} from '../src/index.js';
import { FakeModelProvider, type FakeScript, InMemoryAgentStore } from '../src/testing/index.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };

/** Every `data:` JSON of an SSE text, in order — what a reader of the agent protocol sees. */
function events(sse: string): AgentStreamEvent[] {
  return sse
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as AgentStreamEvent);
}

describe('agent protocol encoding', () => {
  it('writes each frame as the AgentStreamEvent it stands for', () => {
    const encoder = new AgentSseEncoder();
    const sse = [
      encoder.encode({ t: 'text', v: 'hi' }),
      encoder.encode({ t: 'event', event: { kind: 'reasoning', text: 'hmm' } }),
      encoder.encode({
        t: 'component',
        name: 'Chart',
        data: { a: 1 },
        id: 'c1:ui:0',
        toolCallId: 'c1',
      }),
      encoder.encode({ t: 'component', name: 'Legacy', data: [1, 2] }),
      encoder.close(),
    ].join('');
    expect(events(sse)).toEqual([
      { kind: 'text', text: 'hi' },
      { kind: 'reasoning', text: 'hmm' },
      { kind: 'ui', id: 'c1:ui:0', component: 'Chart', props: { a: 1 }, toolCallId: 'c1' },
      // No id on a frame buffered before the loop stamped them: numbered by its position, so a
      // re-attaching reader replaces it instead of drawing a copy.
      { kind: 'ui', id: 'ui:3', component: 'Legacy', props: { value: [1, 2] } },
    ]);
    expect(sse.endsWith('event: done\ndata: {}\n\n')).toBe(true);
  });

  it('maps a parked action to approval-requested, keeping what the legacy frame carried', () => {
    expect(
      frameToEvents(
        { t: 'approval', runId: 'r1', id: 'c1', toolName: 'refund', input: { id: 7 } },
        0,
      ),
    ).toEqual([
      {
        kind: 'approval-requested',
        id: 'c1',
        approver: 'requester',
        runId: 'r1',
        toolName: 'refund',
        input: { id: 7 },
      },
    ]);
  });

  it('ends a failed run with event: error and no done', () => {
    const encoder = new AgentSseEncoder();
    const sse =
      encoder.encode({
        t: 'error',
        code: 'quota_exceeded',
        message: 'Daily token quota exceeded',
      }) + encoder.close();
    expect(sse).toBe(
      'event: error\ndata: {"code":"quota_exceeded","message":"Daily token quota exceeded"}\n\n',
    );
  });

  it('keeps the legacy envelope byte-identical and skips what it cannot spell', () => {
    expect(frameToSse({ t: 'text', v: 'hi' })).toBe('data: {"delta":"hi"}\n\n');
    expect(frameToSse({ t: 'event', event: { kind: 'step-start' } })).toBe('');
    expect(frameToSse({ t: 'error', code: 'run_failed', message: 'boom' })).toBe(
      'data: {"delta":"\\n[error] boom"}\n\n',
    );
  });
});

describe('the package client reads the agent protocol', () => {
  function decode(sse: string) {
    const event = parseSseEvent(sse.trimEnd());
    return event === null ? null : decodeFrame(event);
  }

  it('decodes text, ui (replacing by id), approvals and errors', () => {
    expect(decode('data: {"kind":"text","text":"hi"}')).toEqual({ type: 'text', delta: 'hi' });
    const first = decode('data: {"kind":"ui","id":"u1","component":"Card","props":{"n":1}}');
    const second = decode('data: {"kind":"ui","id":"u1","component":"Card","props":{"n":2}}');
    expect(first && second && foldPart(foldPart([], first), second)).toEqual([
      { type: 'component', name: 'Card', data: { n: 2 }, id: 'u1' },
    ]);
    expect(
      decode(
        'data: {"kind":"approval-requested","id":"c1","approver":"requester","runId":"r1","toolName":"refund","input":{}}',
      ),
    ).toEqual({ type: 'approval', runId: 'r1', toolCallId: 'c1', toolName: 'refund', input: {} });
    expect(decode('event: error\ndata: {"code":"run_failed","message":"boom"}')).toEqual({
      type: 'error',
      code: 'run_failed',
      message: 'boom',
    });
    expect(decode('data: {"kind":"step-start"}')).toEqual({
      type: 'event',
      event: { kind: 'step-start' },
    });
  });
});

describe('the loop streams the agent vocabulary', () => {
  function build(script: FakeScript) {
    const store = new InMemoryAgentStore();
    const sink = new InProcessTokenStreamSink();
    const registry = new ToolRegistry();
    const factory = new AgentDepsFactory({
      model: new FakeModelProvider(script),
      store,
      sink,
      rolesPolicy: new DefaultToolAuthorizer(),
      registry,
      agents: new AgentRegistry(),
    });
    const runner = new InlineAgentRunner(factory, store);
    return { service: new AgentService(runner, store, factory), registry, store };
  }

  async function run(
    g: ReturnType<typeof build>,
    onFrame?: (frame: StreamFrame, runId: string) => Promise<void>,
  ) {
    const { runId } = await g.service.chat({ actor, message: 'look it up' });
    const encoder = new AgentSseEncoder();
    let sse = '';
    for await (const frame of g.service.subscribe(runId)) {
      sse += encoder.encode(frame);
      await onFrame?.(frame, runId);
    }
    return events(sse + encoder.close());
  }

  it('announces, settles and brackets a read tool call, then titles the thread', async () => {
    const g = build((_args, turn) =>
      turn === 0 ? { text: '', toolCall: { name: 'lookup', input: { id: 1 } } } : { text: 'Paid.' },
    );
    g.registry.register(
      {
        name: 'lookup',
        kind: 'read',
        description: 'look an order up',
        inputSchema: z.object({ id: z.number() }),
        roles: ['ADMIN'],
      },
      { execute: async () => ({ status: 'paid' }) },
    );

    const kinds = await run(g);
    expect(kinds.map((event) => event.kind)).toEqual([
      'step-start',
      'tool-input-available',
      'tool-output',
      'step-finish',
      'step-start',
      'text',
      'step-finish',
      'title',
    ]);
    // The fake provider streams no tool frames, so the loop announced the call itself.
    expect(kinds[1]).toEqual({
      kind: 'tool-input-available',
      id: 'call-0-lookup',
      name: 'lookup',
      input: { id: 1 },
      toolKind: 'read',
    });
    expect(kinds[2]).toEqual({
      kind: 'tool-output',
      id: 'call-0-lookup',
      output: { status: 'paid' },
    });
    expect(kinds[3]).toMatchObject({
      kind: 'step-finish',
      usage: { inputTokens: 1 },
      costUsd: null,
    });
    expect(kinds.at(-1)).toEqual({ kind: 'title', title: 'look it up' });
  });

  it('streams a declined action as tool-output-denied with the reason', async () => {
    const g = build((_args, turn) =>
      turn === 0 ? { text: '', toolCall: { name: 'refund', input: { id: 1 } } } : { text: 'OK.' },
    );
    g.registry.register(
      {
        name: 'refund',
        kind: 'action',
        description: 'refund an order',
        inputSchema: z.object({ id: z.number() }),
        roles: ['ADMIN'],
      },
      { execute: async () => ({ refunded: true }) },
    );

    const kinds = await run(g, async (frame, runId) => {
      if (frame.t === 'approval') {
        // Named by the call alone, as the shared React client sends it.
        const owning = await g.service.toolCallRun(frame.id);
        expect(owning).toBe(runId);
        await g.service.reject(runId, frame.id, 'not this one');
      }
    });
    expect(
      kinds.filter((event) => event.kind.startsWith('tool-') || event.kind.startsWith('approval')),
    ).toEqual([
      {
        kind: 'tool-input-available',
        id: 'call-0-refund',
        name: 'refund',
        input: { id: 1 },
        toolKind: 'action',
      },
      expect.objectContaining({
        kind: 'approval-requested',
        id: 'call-0-refund',
        approver: 'requester',
      }),
      // Who declined it (the run's own actor, since the service call named nobody) — then the outcome.
      {
        kind: 'approval-settled',
        id: 'call-0-refund',
        status: 'rejected',
        decidedBy: 'u1',
        reason: 'not this one',
      },
      { kind: 'tool-output-denied', id: 'call-0-refund', reason: 'not this one' },
    ]);
  });

  it('ends a cancelled run with a cancelled frame', async () => {
    const g = build(() => ({ text: '', toolCall: { name: 'refund', input: { id: 1 } } }));
    g.registry.register(
      {
        name: 'refund',
        kind: 'action',
        description: 'refund an order',
        inputSchema: z.object({ id: z.number() }),
        roles: ['ADMIN'],
      },
      { execute: async () => ({}) },
    );
    const kinds = await run(g, async (frame, runId) => {
      if (frame.t === 'approval') await g.service.cancel(runId);
    });
    expect(kinds.at(-1)).toEqual({ kind: 'cancelled' });
  });
});
