import { describe, expect, it } from 'vitest';
import {
  AG_UI_CUSTOM,
  AgUiEncoder,
  type AgUiEvent,
  agUiEvents,
  decodeInterruptId,
  encodeInterruptId,
  planResume,
  readAnswersPayload,
  readApprovalPayload,
  readUserTurn,
} from '../src/ag-ui/index.js';
import type { StreamFrame } from '../src/spi/token-stream-sink.js';
import type { AgentStreamEvent } from '../src/stream-events.js';
import { assertConforms } from './helpers/ag-ui.js';

const ids = { threadId: 'thread-1', runId: 'run-1', streamRunId: 'lib-run-1' };
const ev = (event: AgentStreamEvent): StreamFrame => ({ t: 'event', event });

async function* ended(frames: StreamFrame[]): AsyncGenerator<StreamFrame> {
  yield* frames;
}

/** A stream that delivers its frames and then stays open, as a parked run's does. */
function parked(frames: StreamFrame[]): AsyncIterable<StreamFrame> & { returned: boolean } {
  const source = {
    returned: false,
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: () =>
          index < frames.length
            ? Promise.resolve({ value: frames[index++] as StreamFrame, done: false as const })
            : new Promise<IteratorResult<StreamFrame>>(() => {}),
        return: () => {
          source.returned = true;
          return Promise.resolve({ value: undefined, done: true as const });
        },
      };
    },
  };
  return source;
}

async function collect(
  frames: AsyncIterable<StreamFrame>,
  options: Partial<Parameters<typeof agUiEvents>[1]> = {},
): Promise<AgUiEvent[]> {
  const out: AgUiEvent[] = [];
  for await (const event of agUiEvents(frames, { ...ids, quietMs: 40, ...options })) {
    out.push(event);
  }
  return out;
}

const types = (events: AgUiEvent[]) => events.map((event) => event.type);
const protocol = (events: AgUiEvent[]) => events.filter((event) => event.type !== 'CUSTOM');

const approval: StreamFrame = {
  t: 'approval',
  runId: 'lib-run-1',
  id: 'call-1',
  toolName: 'refund',
  input: { id: 7 },
};

describe('AgUiEncoder', () => {
  it('projects a text turn onto a bracketed run, step and message', async () => {
    const events = await collect(
      ended([
        ev({ kind: 'step-start' }),
        { t: 'text', v: 'Hello ' },
        { t: 'text', v: 'there' },
        ev({ kind: 'step-finish', usage: { inputTokens: 10, outputTokens: 4 }, model: 'gpt-x' }),
        ev({ kind: 'title', title: 'Greeting' }),
      ]),
    );
    await assertConforms(events);
    expect(types(protocol(events))).toEqual([
      'RUN_STARTED',
      'STEP_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'STEP_FINISHED',
      'RUN_FINISHED',
    ]);
    expect(events[0]).toEqual({
      type: 'RUN_STARTED',
      threadId: 'thread-1',
      runId: 'run-1',
      protocolVersion: '1.0',
    });
    expect(events[1]).toEqual({
      type: 'CUSTOM',
      name: AG_UI_CUSTOM.run,
      value: { runId: 'lib-run-1', threadId: 'thread-1' },
    });
    // an absent outcome means success; usage is one entry per model, totals computed
    expect(events.at(-1)).toEqual({
      type: 'RUN_FINISHED',
      threadId: 'thread-1',
      runId: 'run-1',
      usage: [{ model: 'gpt-x', inputTokens: 10, outputTokens: 4, totalTokens: 14 }],
    });
    expect(events).toContainEqual({
      type: 'CUSTOM',
      name: AG_UI_CUSTOM.title,
      value: { title: 'Greeting' },
    });
  });

  it('sums usage per model and keeps counts the provider did not report absent', async () => {
    const events = await collect(
      ended([
        ev({ kind: 'step-start' }),
        ev({
          kind: 'step-finish',
          usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, reasoningTokens: 5 },
          model: 'a',
        }),
        ev({ kind: 'step-start' }),
        ev({ kind: 'step-finish', usage: { inputTokens: 50, outputTokens: 10 }, model: 'a' }),
        ev({ kind: 'step-start' }),
        ev({ kind: 'step-finish', usage: { inputTokens: 7, outputTokens: 3 }, model: 'b' }),
      ]),
    );
    await assertConforms(events);
    const finished = events.at(-1) as Extract<AgUiEvent, { type: 'RUN_FINISHED' }>;
    expect(finished.usage).toEqual([
      {
        model: 'a',
        inputTokens: 150,
        outputTokens: 30,
        totalTokens: 180,
        cachedInputTokens: 60,
        reasoningTokens: 5,
      },
      { model: 'b', inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    ]);
  });

  it('streams a tool call announced piece by piece, and answers it with its own message', async () => {
    const events = await collect(
      ended([
        ev({ kind: 'step-start' }),
        { t: 'text', v: 'Let me look.' },
        ev({ kind: 'tool-input-start', id: 'c1', name: 'search', toolKind: 'read' }),
        ev({ kind: 'tool-input-delta', id: 'c1', delta: '{"q":' }),
        ev({ kind: 'tool-input-delta', id: 'c1', delta: '"x"}' }),
        ev({
          kind: 'tool-input-available',
          id: 'c1',
          name: 'search',
          input: { q: 'x' },
          toolKind: 'read',
        }),
        ev({ kind: 'step-finish' }),
        ev({ kind: 'tool-output', id: 'c1', output: { hits: 3 } }),
      ]),
    );
    await assertConforms(events);
    const start = events.find((event) => event.type === 'TOOL_CALL_START');
    expect(start).toEqual({
      type: 'TOOL_CALL_START',
      toolCallId: 'c1',
      toolCallName: 'search',
      parentMessageId: 'run-1:m1',
    });
    const args = events.filter((event) => event.type === 'TOOL_CALL_ARGS');
    expect(args.map((event) => (event as { delta: string }).delta).join('')).toBe('{"q":"x"}');
    expect(events).toContainEqual({
      type: 'TOOL_CALL_RESULT',
      messageId: 'run-1:tool:c1',
      toolCallId: 'c1',
      content: '{"hits":3}',
      role: 'tool',
    });
    // the message closed before the call opened
    expect(types(events).indexOf('TEXT_MESSAGE_END')).toBeLessThan(
      types(events).indexOf('TOOL_CALL_START'),
    );
  });

  it('writes a whole call when only its final input was announced, and marks failures', async () => {
    const events = await collect(
      ended([
        ev({
          kind: 'tool-input-available',
          id: 'c1',
          name: 'pay',
          input: { n: 1 },
          toolKind: 'read',
        }),
        ev({
          kind: 'tool-input-available',
          id: 'c1',
          name: 'pay',
          input: { n: 1 },
          toolKind: 'read',
        }),
        ev({ kind: 'tool-output-error', id: 'c1', error: 'boom' }),
        ev({ kind: 'tool-input-available', id: 'c2', name: 'pay', input: {}, toolKind: 'action' }),
        ev({ kind: 'tool-output-denied', id: 'c2', reason: 'not now' }),
      ]),
    );
    await assertConforms(events);
    expect(types(protocol(events))).toEqual([
      'RUN_STARTED',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      'RUN_FINISHED',
    ]);
    const results = events.filter((event) => event.type === 'TOOL_CALL_RESULT');
    expect(results.map((event) => event.metadata)).toEqual([
      { 'agora.outcome': 'error' },
      { 'agora.outcome': 'denied' },
    ]);
  });

  it('brackets reasoning as a span with one message, apart from the answer', async () => {
    const events = await collect(
      ended([
        ev({ kind: 'step-start' }),
        ev({ kind: 'reasoning', text: 'thinking' }),
        ev({ kind: 'reasoning', text: ' hard' }),
        { t: 'text', v: 'Answer' },
        ev({ kind: 'step-finish' }),
      ]),
    );
    await assertConforms(events);
    expect(types(protocol(events))).toEqual([
      'RUN_STARTED',
      'STEP_STARTED',
      'REASONING_START',
      'REASONING_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_END',
      'REASONING_END',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'STEP_FINISHED',
      'RUN_FINISHED',
    ]);
  });

  it('carries generative UI as a CUSTOM event', async () => {
    const events = await collect(
      ended([
        { t: 'component', name: 'Chart', data: { points: [1] }, id: 'c1:ui:0', toolCallId: 'c1' },
      ]),
    );
    await assertConforms(events);
    expect(events).toContainEqual({
      type: 'CUSTOM',
      name: AG_UI_CUSTOM.ui,
      value: { id: 'c1:ui:0', component: 'Chart', props: { points: [1] }, toolCallId: 'c1' },
    });
  });

  it('reports a failed run with RUN_ERROR and nothing after it', async () => {
    const events = await collect(
      ended([
        ev({ kind: 'step-start' }),
        { t: 'text', v: 'Hal' },
        { t: 'error', code: 'run_failed', message: 'the model went away' },
        { t: 'text', v: 'ignored' },
      ]),
    );
    await assertConforms(events);
    expect(events.at(-1)).toEqual({
      type: 'RUN_ERROR',
      message: 'the model went away',
      code: 'run_failed',
    });
  });

  it('reports a stopped run as cancelled, never as success', async () => {
    const events = await collect(
      ended([ev({ kind: 'step-start' }), { t: 'text', v: 'Part' }, ev({ kind: 'cancelled' })]),
    );
    await assertConforms(events);
    expect(events.at(-1)).toMatchObject({ type: 'RUN_FINISHED', outcome: { type: 'cancelled' } });
    expect(types(events)).toContain('STEP_FINISHED');
  });
});

describe('interrupts', () => {
  const upToApproval: StreamFrame[] = [
    ev({ kind: 'step-start' }),
    ev({
      kind: 'tool-input-available',
      id: 'call-1',
      name: 'refund',
      input: { id: 7 },
      toolKind: 'action',
    }),
    ev({ kind: 'step-finish', usage: { inputTokens: 5, outputTokens: 2 } }),
    approval,
  ];

  it('ends the run with the interrupt outcome as soon as it only waits on a person', async () => {
    const source = parked(upToApproval);
    const events = await collect(source, { quietMs: 60_000 });
    await assertConforms(events);
    const finished = events.at(-1) as Extract<AgUiEvent, { type: 'RUN_FINISHED' }>;
    expect(finished.outcome?.type).toBe('interrupt');
    const [interrupt] = (finished.outcome as { interrupts: { id: string }[] }).interrupts;
    expect(interrupt).toMatchObject({
      reason: 'tool_approval',
      toolCallId: 'call-1',
      metadata: { 'agora.toolName': 'refund', 'agora.input': { id: 7 } },
    });
    expect(decodeInterruptId(interrupt?.id)).toEqual({
      kind: 'approval',
      parked: 'lib-run-1',
      stream: 'lib-run-1',
      toolCallId: 'call-1',
      position: 4,
    });
    // the library stream is left alone, not drained
    expect(source.returned).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'CUSTOM', name: AG_UI_CUSTOM.approvalRequested }),
    );
  });

  it('waits out the quiet window while other announced work is still in flight', async () => {
    const frames = [
      ...upToApproval.slice(0, 2),
      ev({
        kind: 'tool-input-available',
        id: 'call-2',
        name: 'lookup',
        input: {},
        toolKind: 'read',
      }),
      approval,
    ];
    const startedAt = Date.now();
    const events = await collect(parked(frames), { quietMs: 120 });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    await assertConforms(events);
    expect(events.at(-1)).toMatchObject({ outcome: { type: 'interrupt' } });
  });

  it('collects every approval of a turn into one interrupt outcome', async () => {
    const second: StreamFrame = { ...approval, id: 'call-2', toolName: 'charge' };
    const events = await collect(
      parked([
        ev({
          kind: 'tool-input-available',
          id: 'call-1',
          name: 'refund',
          input: {},
          toolKind: 'action',
        }),
        ev({
          kind: 'tool-input-available',
          id: 'call-2',
          name: 'charge',
          input: {},
          toolKind: 'action',
        }),
        approval,
        second,
      ]),
      { quietMs: 60 },
    );
    await assertConforms(events);
    const finished = events.at(-1) as unknown as {
      outcome: { interrupts: { toolCallId: string }[] };
    };
    expect(finished.outcome.interrupts.map((entry) => entry.toolCallId)).toEqual([
      'call-1',
      'call-2',
    ]);
  });

  it('turns a question set into an interrupt whose schema describes the answer', async () => {
    const events = await collect(
      parked([
        {
          t: 'elicitation',
          runId: 'lib-run-1',
          id: 'ask-1',
          request: {
            id: 'ask-1',
            source: 'intake',
            preamble: 'Two things first',
            questions: [
              {
                id: 'account',
                prompt: 'Which account?',
                options: [
                  { value: 'a', label: 'A' },
                  { value: 'b', label: 'B' },
                ],
              },
            ],
          },
        },
      ]),
    );
    await assertConforms(events);
    const finished = events.at(-1) as unknown as {
      outcome: { interrupts: Record<string, unknown>[] };
    };
    expect(finished.outcome.interrupts[0]).toMatchObject({
      reason: 'input_required',
      message: 'Two things first',
      responseSchema: {
        properties: {
          answers: {
            properties: {
              account: { title: 'Which account?', items: { enum: ['a', 'b'] }, maxItems: 1 },
            },
          },
        },
      },
    });
    expect(finished.outcome.interrupts[0]).not.toHaveProperty('toolCallId');
  });

  it('a resumed run skips what was delivered and reports only what it did itself', async () => {
    const whole: StreamFrame[] = [
      ...upToApproval,
      ev({ kind: 'approval-settled', id: 'call-1', status: 'approved' }),
      ev({ kind: 'tool-output', id: 'call-1', output: { refunded: true } }),
      ev({ kind: 'step-start' }),
      { t: 'text', v: 'Done.' },
      ev({ kind: 'step-finish', usage: { inputTokens: 9, outputTokens: 1 } }),
    ];
    const events = await collect(ended(whole), {
      runId: 'run-2',
      skip: upToApproval.length,
      answered: ['call-1'],
    });
    await assertConforms(events);
    expect(types(protocol(events))).toEqual([
      'RUN_STARTED',
      'TOOL_CALL_RESULT',
      'STEP_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'STEP_FINISHED',
      'RUN_FINISHED',
    ]);
    // usage does not carry across the gap: the interrupted run already reported its own
    expect(events.at(-1)).toMatchObject({
      runId: 'run-2',
      usage: [{ inputTokens: 9, outputTokens: 1, totalTokens: 10 }],
    });
    expect(events.at(-1)).not.toHaveProperty('outcome');
  });

  it('does not re-report an interrupt the resume answered while the run is still waking', async () => {
    const events: AgUiEvent[] = [];
    const late = (async function* () {
      yield* upToApproval;
      await new Promise((resolve) => setTimeout(resolve, 150));
      yield ev({ kind: 'tool-output', id: 'call-1', output: 'ok' });
    })();
    for await (const event of agUiEvents(late, {
      ...ids,
      runId: 'run-2',
      skip: upToApproval.length,
      answered: ['call-1'],
      quietMs: 20,
    })) {
      events.push(event);
    }
    await assertConforms(events);
    expect(types(protocol(events))).toEqual(['RUN_STARTED', 'TOOL_CALL_RESULT', 'RUN_FINISHED']);
  });

  it('keeps an interrupt open when the resume left it uncovered', async () => {
    const second: StreamFrame = { ...approval, id: 'call-2', toolName: 'charge' };
    const frames = [
      ev({
        kind: 'tool-input-available',
        id: 'call-1',
        name: 'refund',
        input: {},
        toolKind: 'action',
      }),
      ev({
        kind: 'tool-input-available',
        id: 'call-2',
        name: 'charge',
        input: {},
        toolKind: 'action',
      }),
      approval,
      second,
    ];
    const events = await collect(parked(frames), { runId: 'run-2', skip: 4, answered: ['call-1'] });
    await assertConforms(events);
    const finished = events.at(-1) as unknown as {
      outcome: { interrupts: { toolCallId: string }[] };
    };
    expect(finished.outcome.interrupts.map((entry) => entry.toolCallId)).toEqual(['call-2']);
  });

  it('a run that ended is waiting on no one', () => {
    const encoder = new AgUiEncoder(ids);
    encoder.start();
    encoder.encode(approval);
    expect(encoder.waiting).toBe(true);
    expect(encoder.finish(true).at(-1)).not.toHaveProperty('outcome');
  });
});

describe('input', () => {
  it('round-trips an interrupt address and rejects ids it did not mint', () => {
    const address = {
      kind: 'elicitation' as const,
      parked: 'child',
      stream: 'parent',
      toolCallId: 'c:1',
      position: 12,
    };
    expect(decodeInterruptId(encodeInterruptId(address))).toEqual(address);
    expect(decodeInterruptId('int-1')).toBeNull();
    expect(decodeInterruptId('agora_bm9wZQ')).toBeNull();
    expect(decodeInterruptId(42)).toBeNull();
  });

  it('plans a resume: one run, one point, each interrupt once', () => {
    const a = encodeInterruptId({
      kind: 'approval',
      parked: 'r',
      stream: 'r',
      toolCallId: 'a',
      position: 3,
    });
    const b = encodeInterruptId({
      kind: 'approval',
      parked: 'r',
      stream: 'r',
      toolCallId: 'b',
      position: 3,
    });
    const other = encodeInterruptId({
      kind: 'approval',
      parked: 'x',
      stream: 'x',
      toolCallId: 'a',
      position: 3,
    });
    const plan = planResume([
      { interruptId: a, status: 'resolved', payload: true },
      { interruptId: 'foreign', status: 'cancelled' },
      { interruptId: b, status: 'cancelled' },
    ]);
    expect(plan).toMatchObject({ unrecognised: ['foreign'] });
    expect((plan as { decisions: unknown[] }).decisions).toHaveLength(2);
    expect(
      planResume([
        { interruptId: a, status: 'resolved' },
        { interruptId: other, status: 'resolved' },
      ]),
    ).toBe('the resume entries answer interrupts of different runs');
    expect(
      planResume([
        { interruptId: a, status: 'resolved' },
        { interruptId: a, status: 'resolved' },
      ]),
    ).toBe('an interrupt is answered twice');
  });

  it('reads the payloads an interrupt asks for', () => {
    expect(readApprovalPayload(true)).toEqual({ approved: true });
    expect(readApprovalPayload({ approved: false, reason: 'no' })).toEqual({
      approved: false,
      reason: 'no',
    });
    expect(readApprovalPayload({ ok: true })).toBeNull();
    expect(readAnswersPayload({ answers: { q: ['a'], r: 'b' } })).toEqual({ q: ['a'], r: ['b'] });
    expect(readAnswersPayload({ q: ['a'] })).toEqual({ q: ['a'] });
    expect(readAnswersPayload({ q: 3 })).toBeNull();
  });

  it('answers the last user message: text parts are the text, inline media the attachments', () => {
    expect(readUserTurn([{ id: '1', role: 'assistant', content: 'hi' }])).toBeNull();
    const turn = readUserTurn([
      { id: '1', role: 'user', content: 'first' },
      { id: '2', role: 'assistant', content: 'ok' },
      {
        id: '3',
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          {
            type: 'image',
            source: {
              type: 'data',
              value: Buffer.from('png').toString('base64'),
              mimeType: 'image/PNG',
            },
          },
          { type: 'document', source: { type: 'url', value: 'https://example.com/a.pdf' } },
          { type: 'image', source: { type: 'file', value: 'file-123', provider: 'openai' } },
        ],
      },
    ]);
    expect(turn?.text).toBe('What is this?');
    expect(turn?.media).toEqual([
      {
        kind: 'image',
        contentType: 'image/png',
        data: Buffer.from('png'),
        filename: 'image-2.png',
      },
    ]);
    expect(turn?.dropped).toHaveLength(2);
    expect(turn?.dropped[0]).toContain('url source');
  });
});
