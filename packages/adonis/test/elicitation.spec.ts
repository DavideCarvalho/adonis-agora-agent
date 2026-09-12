import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { decodeFrame, parseSseEvent } from '../src/client/index.js';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  ASK_TOOL_NAME,
  askInputSchema,
  DEFAULT_INTAKE_PREAMBLE,
  type Decision,
  DefaultRolesPolicy,
  type ElicitationQuestion,
  type ElicitationReply,
  type ElicitationRequest,
  frameToSse,
  type HumanReply,
  isHumanDecision,
  normalizeElicitationReply,
  resolveElicitation,
  runAgentLoop,
  type StreamFrame,
  settleElicitation,
  ToolRegistry,
} from '../src/index.js';
import {
  echoScript,
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';
import { Journal } from './helpers/journal.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };

const SCOPE: ElicitationQuestion = {
  id: 'scope',
  prompt: 'How wide should I go?',
  options: [
    { value: 'narrow', label: 'This module only' },
    { value: 'everything', label: 'The whole repo' },
  ],
  defaults: ['narrow'],
};

function request(overrides: Partial<ElicitationRequest> = {}): ElicitationRequest {
  return { id: 'req-1', source: 'ask', questions: [SCOPE], ...overrides };
}

describe('resolving a reply against its request', () => {
  it('takes a question’s own defaults when the reply omits it', () => {
    const outcome = resolveElicitation({ request: request(), reply: { answers: {} } });
    expect(outcome).toEqual({
      answers: { scope: ['narrow'] },
      skipped: false,
      defaulted: ['scope'],
    });
  });

  it('treats a present-but-empty array as an explicit "none of these"', () => {
    const outcome = resolveElicitation({ request: request(), reply: { answers: { scope: [] } } });
    expect(outcome.answers.scope).toEqual([]);
    expect(outcome.defaulted).toEqual([]);
  });

  it('drops a submitted value that was never on offer', () => {
    const outcome = resolveElicitation({
      request: request(),
      reply: { answers: { scope: ['nowhere'] } },
    });
    expect(outcome.answers.scope).toEqual([]);
  });

  it('keeps a free-text answer when the question allows one', () => {
    const outcome = resolveElicitation({
      request: request({ questions: [{ ...SCOPE, allowFreeText: true }] }),
      reply: { answers: { scope: ['just src/rag'] } },
    });
    expect(outcome.answers.scope).toEqual(['just src/rag']);
  });

  it('collapses a single-choice question to one value', () => {
    const outcome = resolveElicitation({
      request: request(),
      reply: { answers: { scope: ['narrow', 'everything'] } },
    });
    expect(outcome.answers.scope).toEqual(['narrow']);
  });

  it('keeps every choice when the question is multiple', () => {
    const outcome = resolveElicitation({
      request: request({ questions: [{ ...SCOPE, multiple: true }] }),
      reply: { answers: { scope: ['narrow', 'everything'] } },
    });
    expect(outcome.answers.scope).toEqual(['narrow', 'everything']);
  });

  it('lands a skip on the same values, and records that nobody chose them', () => {
    const outcome = resolveElicitation({
      request: request(),
      reply: { answers: { scope: ['everything'] }, skipped: true },
    });
    expect(outcome).toEqual({
      answers: { scope: ['narrow'] },
      skipped: true,
      defaulted: ['scope'],
    });
  });

  it('shows the model the chosen LABELS, never the opaque values', () => {
    const result = settleElicitation({
      request: request(),
      reply: { answers: { scope: ['everything'] } },
    });
    expect(result.summary).toContain('The whole repo');
    expect(result.summary).not.toContain('everything');
  });

  it('tells the model a skip was an assumption rather than an answer', () => {
    const result = settleElicitation({ request: request(), reply: { answers: {}, skipped: true } });
    expect(result.summary).toContain('declined to answer');
  });
});

describe('a yes/no channel answering a question set', () => {
  it('reads Approve as "confirmed the pre-picked answers"', () => {
    expect(normalizeElicitationReply({ approved: true })).toEqual({ answers: {} });
  });

  it('reads Reject as a skip', () => {
    expect(normalizeElicitationReply({ approved: false })).toEqual({ answers: {}, skipped: true });
  });

  it('carries who decided through as who answered, so the audit row still names them', () => {
    expect(normalizeElicitationReply({ approved: true, executedByRef: 'ops-7' })).toEqual({
      answers: {},
      answeredByRef: 'ops-7',
    });
  });

  it('returns a real reply untouched', () => {
    const reply: ElicitationReply = { answers: { scope: ['everything'] } };
    expect(normalizeElicitationReply(reply)).toBe(reply);
  });

  it('tells a yes/no apart from a set of answers, so only one of them can settle an approval', () => {
    expect(isHumanDecision({ approved: true })).toBe(true);
    expect(isHumanDecision({ approved: false, reason: 'no' })).toBe(true);
    // No `approved` at all: the field an approval wait reads is simply absent, and `!undefined` is
    // true — which is why this has to be asked rather than assumed.
    expect(isHumanDecision({ answers: {} })).toBe(false);
    expect(isHumanDecision({ answers: {}, skipped: true })).toBe(false);
    expect(isHumanDecision({ answers: { scope: ['narrow'] }, answeredByRef: 'ops-7' })).toBe(false);
  });

  it('settles an Approve on the defaults rather than throwing on a missing `answers`', () => {
    const decision: Decision = { approved: true };
    expect(settleElicitation({ request: request(), reply: decision }).answers).toEqual({
      scope: ['narrow'],
    });
  });
});

describe('the ask tool’s input schema', () => {
  async function validate(input: unknown) {
    return askInputSchema['~standard'].validate(input);
  }

  it('refuses a question that pre-picked nothing', async () => {
    const result = await validate({
      questions: [{ id: 'q', prompt: 'p', options: [{ value: 'a', label: 'A' }] }],
    });
    expect(result.issues?.[0]?.message).toContain('pre-pick at least one option');
  });

  it('refuses defaults that name an option the question does not offer', async () => {
    const result = await validate({
      questions: [
        {
          id: 'q',
          prompt: 'p',
          options: [{ value: 'a', label: 'A' }],
          defaults: ['z'],
        },
      ],
    });
    expect(result.issues?.[0]?.message).toContain("this question's options");
  });

  it('accepts a well-formed question set', async () => {
    const result = await validate({ preamble: 'two questions', questions: [SCOPE] });
    expect(result.issues).toBeUndefined();
  });

  it('publishes a JSON Schema a provider can constrain generation against', () => {
    const converter = (askInputSchema['~standard'] as { jsonSchema?: { input: () => unknown } })
      .jsonSchema;
    expect(typeof converter?.input()).toBe('object');
  });
});

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    { name: 'ping', kind: 'read', description: 'ping', inputSchema: z.object({}) },
    { execute: async () => ({ pong: true }) },
  );
  return registry;
}

interface RunOptions {
  script?: FakeScript;
  intake?: AgentLoopDeps['intake'];
  ask?: boolean;
  reply?: HumanReply;
  awaitAnswers?: boolean;
  journal?: Journal;
  store?: InMemoryAgentStore;
  threadId?: string;
  /** Runs instead of returning `reply`, so a test can unwind the turn at the wait. */
  onAwait?: () => Promise<void>;
}

async function run(options: RunOptions = {}) {
  const store = options.store ?? new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const threadId =
    options.threadId ?? (await store.createThread({ actor: ACTOR, persona: 'default' })).id;
  const journal = options.journal;
  const seen: ElicitationRequest[] = [];
  const reply = options.reply ?? { answers: {} };
  const deps: AgentLoopDeps = {
    model: new FakeModelProvider(options.script ?? echoScript('done')),
    store,
    registry: buildRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'base',
    ...(options.intake !== undefined ? { intake: options.intake } : {}),
    ...(options.ask === true ? { ask: true } : {}),
  };
  const hooks: AgentLoopHooks = {
    runId: 'run-1',
    openSink: () => sink.open('run-1'),
    awaitApproval: async () => reply as Decision,
    ...(options.awaitAnswers === true
      ? {
          awaitAnswers: async (asked: ElicitationRequest) => {
            seen.push(asked);
            await options.onAwait?.();
            return reply;
          },
        }
      : {}),
    step: journal === undefined ? (_name, fn) => fn() : (name, fn) => journal.at(name, fn),
  };
  const result = await runAgentLoop(
    deps,
    { threadId, actor: ACTOR, userText: 'do the thing' },
    hooks,
  );
  const frames: StreamFrame[] = [];
  for await (const frame of sink.subscribe('run-1')) frames.push(frame);
  return { result, store, frames, seen, threadId, detail: await store.getThread(threadId) };
}

const INTAKE = { questions: [SCOPE] };

describe('the configured intake', () => {
  it('asks before the first model call and persists one pending question set', async () => {
    const { store, journal } = await (async () => {
      const journal = new Journal();
      const out = await run({ intake: INTAKE, journal, awaitAnswers: true });
      return { ...out, journal };
    })();
    const names = journal.names();
    expect(names.indexOf('intake:ask')).toBeLessThan(names.indexOf('llm:0'));
    const row = store.governanceToolCalls().find((call) => call.toolName === ASK_TOOL_NAME);
    expect(row).toMatchObject({ toolType: 'action', status: 'executed' });
  });

  it('costs no model call and writes no usage row of its own', async () => {
    const { store } = await run({ intake: INTAKE, awaitAnswers: true });
    expect(store.usageRows().map((row) => row.purpose)).toEqual(['chat']);
  });

  it('streams the whole request, so a client can render "Question 1 of N"', async () => {
    const { frames } = await run({ intake: INTAKE, awaitAnswers: true });
    const asked = frames.find((frame) => frame.t === 'elicitation');
    expect(asked).toMatchObject({ t: 'elicitation', id: 'intake-run-1' });
    expect(asked?.t === 'elicitation' && asked.request.questions).toHaveLength(1);
  });

  it('puts the answers on the transcript as an ordinary tool round-trip', async () => {
    const model: string[] = [];
    const script: FakeScript = (args) => {
      model.push(JSON.stringify(args.messages.at(-1)));
      return { text: 'done' };
    };
    await run({
      intake: INTAKE,
      script,
      awaitAnswers: true,
      reply: { answers: { scope: ['everything'] } },
    });
    expect(model[0]).toContain('The whole repo');
  });

  it('lands the settled answers on the message that asked, so a reopened thread shows them', async () => {
    const { detail } = await run({
      intake: INTAKE,
      awaitAnswers: true,
      reply: { answers: { scope: ['everything'] } },
    });
    const asked = detail?.messages.find((message) => message.toolCalls !== undefined);
    expect(asked?.toolResults).toMatchObject([
      { id: 'intake-run-1', name: ASK_TOOL_NAME, output: { answers: { scope: ['everything'] } } },
    ]);
  });

  it('records a skip as rejected, not executed — declining is not choosing', async () => {
    const { store } = await run({
      intake: INTAKE,
      awaitAnswers: true,
      reply: { answers: {}, skipped: true },
    });
    const row = store.governanceToolCalls().find((call) => call.toolName === ASK_TOOL_NAME);
    expect(row?.status).toBe('rejected');
  });

  it('asks once per thread by default', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
    const first = await run({ intake: INTAKE, awaitAnswers: true, store, threadId: thread.id });
    const second = await run({ intake: INTAKE, awaitAnswers: true, store, threadId: thread.id });
    expect(first.seen).toHaveLength(1);
    expect(second.seen).toHaveLength(0);
  });

  it('asks every turn when told to', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
    const intake = { ...INTAKE, when: 'every-turn' as const };
    await run({ intake, awaitAnswers: true, store, threadId: thread.id });
    const second = await run({ intake, awaitAnswers: true, store, threadId: thread.id });
    expect(second.seen).toHaveLength(1);
  });

  it('completes against a host that only ever implemented approval', async () => {
    const { store } = await run({ intake: INTAKE, reply: { approved: true } as Decision });
    const row = store.governanceToolCalls().find((call) => call.toolName === ASK_TOOL_NAME);
    expect(row?.status).toBe('executed');
  });

  it('does not re-ask when a run resumes from the wait', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
    const journal = new Journal();
    const attempt = () =>
      run({ intake: INTAKE, journal, store, threadId: thread.id, awaitAnswers: true });
    // The first attempt asks and then unwinds at the wait, exactly as a durable suspend does.
    const suspend = async (): Promise<void> => {
      throw new Error('suspended');
    };
    await expect(
      run({
        intake: INTAKE,
        journal,
        store,
        threadId: thread.id,
        awaitAnswers: true,
        onAwait: suspend,
      }),
    ).rejects.toThrow('suspended');
    journal.rewind();

    // By now the thread already holds the intake's own assistant message. A resume that decided
    // "has this thread been asked?" from a fresh read would answer no on the way in and yes on the
    // way back, and land the model call where the history holds the wait.
    const resumed = await attempt();
    expect(resumed.result.text).toBe('done');
    expect(journal.names().filter((name) => name === 'intake:ask')).toHaveLength(1);
    // The wait is re-entered on a resume — it is not a checkpoint — but the question set was posted
    // exactly once: one row, one message, and the model call at the position the history holds.
    expect(
      store.governanceToolCalls().filter((call) => call.toolName === ASK_TOOL_NAME),
    ).toHaveLength(1);
    expect(
      (await store.getThread(thread.id))?.messages.filter(
        (message) => message.content === DEFAULT_INTAKE_PREAMBLE,
      ),
    ).toHaveLength(1);
  });

  it('spends no checkpoint at all when no intake is configured', async () => {
    const journal = new Journal();
    await run({ journal });
    expect(journal.names().some((name) => name.startsWith('intake:'))).toBe(false);
  });
});

const ASK_CALL = {
  name: ASK_TOOL_NAME,
  input: {
    preamble: 'one question first',
    questions: [SCOPE],
  },
};

describe('the model-callable ask tool', () => {
  const askThenAnswer: FakeScript = (_args, turnIndex) =>
    turnIndex === 0 ? { text: 'let me check', toolCall: ASK_CALL } : { text: 'done' };

  it('is offered to the model only when the module turns it on', async () => {
    const offered: string[][] = [];
    const script: FakeScript = (args) => {
      offered.push(args.tools.map((tool) => tool.name));
      return { text: 'done' };
    };
    await run({ script });
    await run({ script, ask: true });
    expect(offered[0]).not.toContain(ASK_TOOL_NAME);
    expect(offered[1]).toContain(ASK_TOOL_NAME);
  });

  it('parks the call as a pending action, then settles it with the answers', async () => {
    const { store } = await run({
      script: askThenAnswer,
      ask: true,
      awaitAnswers: true,
      reply: { answers: { scope: ['everything'] } },
    });
    const row = store.governanceToolCalls().find((call) => call.toolName === ASK_TOOL_NAME);
    expect(row).toMatchObject({ toolType: 'action', status: 'executed' });
    expect(
      store.toolCallRows().find((call) => call.toolName === ASK_TOOL_NAME)?.output,
    ).toMatchObject({ answers: { scope: ['everything'] } });
  });

  it('writes the same persisted shape an intake does, so nothing downstream can tell them apart', async () => {
    const fromAsk = await run({ script: askThenAnswer, ask: true, awaitAnswers: true });
    const fromIntake = await run({ intake: INTAKE, awaitAnswers: true });
    const shape = (store: InMemoryAgentStore) => {
      const row = store.governanceToolCalls().find((call) => call.toolName === ASK_TOOL_NAME);
      return { toolName: row?.toolName, toolType: row?.toolType, status: row?.status };
    };
    expect(shape(fromAsk.store)).toEqual(shape(fromIntake.store));
  });

  it('costs no model call beyond the step that proposed it', async () => {
    const { store } = await run({ script: askThenAnswer, ask: true, awaitAnswers: true });
    expect(store.usageRows().map((row) => row.purpose)).toEqual(['chat', 'chat']);
  });

  it('hands a malformed question set back as a tool failure the model can fix', async () => {
    const malformed: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? {
            text: 'asking',
            toolCall: {
              name: ASK_TOOL_NAME,
              input: {
                questions: [{ id: 'q', prompt: 'p', options: [{ value: 'a', label: 'A' }] }],
              },
            },
          }
        : { text: 'fixed' };
    const { result, store } = await run({ script: malformed, ask: true, awaitAnswers: true });
    expect(result.text).toBe('fixed');
    const row = store.toolCallRows().find((call) => call.toolName === ASK_TOOL_NAME);
    expect(row?.status).toBe('failed');
  });

  it('settles the kind inside the persist checkpoint, never from the running process’s registry', async () => {
    const journal = new Journal();
    await run({ script: askThenAnswer, ask: true, awaitAnswers: true, journal });
    journal.rewind();
    // A process that no longer offers `ask` must still replay the parked branch its journal holds.
    const replayed = await run({ script: askThenAnswer, ask: false, awaitAnswers: true, journal });
    expect(replayed.result.text).toBe('done');
  });

  it('records a skip as rejected', async () => {
    const { store } = await run({
      script: askThenAnswer,
      ask: true,
      awaitAnswers: true,
      reply: { answers: {}, skipped: true },
    });
    expect(store.toolCallRows().find((call) => call.toolName === ASK_TOOL_NAME)?.status).toBe(
      'rejected',
    );
  });
});

describe('a reply of the wrong shape for an approval wait', () => {
  it('gives up rather than spinning when a host hook resolves without ever waiting', async () => {
    // Both shipped runners actually wait here, so this ceiling is out of reach for a person. What it
    // rules out is a hook that resolves synchronously with the wrong shape forever, which would peg
    // the only thread the process has.
    const store = new InMemoryAgentStore();
    const sink = new InMemoryTokenStreamSink();
    const { id: threadId } = await store.createThread({ actor: ACTOR, persona: 'default' });
    const registry = buildRegistry();
    registry.register(
      { name: 'voidInvoice', kind: 'action', description: 'v', inputSchema: z.object({}) },
      { execute: async () => ({ voided: true }) },
    );
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'acting', toolCall: { name: 'voidInvoice', input: {} } }
        : { text: 'done' };

    await expect(
      runAgentLoop(
        {
          model: new FakeModelProvider(script),
          store,
          registry,
          rolesPolicy: new DefaultRolesPolicy(),
          modelId: 'fake-1',
          day: '2026-06-30',
          systemPrompt: 'base',
        } as AgentLoopDeps,
        { threadId, actor: ACTOR, userText: 'void it' },
        {
          runId: 'run-1',
          openSink: () => sink.open('run-1'),
          // Never a `Decision`, and never a wait.
          awaitApproval: async () => ({ answers: {} }) as unknown as Decision,
          step: (_name, fn) => fn(),
        },
      ),
    ).rejects.toThrow(/replies that carried no approve\/reject/);
  });
});

describe('a question set a delegated run parks on', () => {
  it('carries the run to answer it against, which is the CHILD, not the stream it arrived on', async () => {
    // A delegated run forwards its frames into its top-level ancestor's stream, because that is the
    // only stream anyone subscribed to. So the run id on the frame and the run id of the stream are
    // different, and answering against the stream's would signal the wrong run.
    const store = new InMemoryAgentStore();
    const sink = new InMemoryTokenStreamSink();
    const { id: threadId } = await store.createThread({ actor: ACTOR, persona: 'default' });
    const asked: ElicitationRequest[] = [];
    await runAgentLoop(
      {
        model: new FakeModelProvider(echoScript('done')),
        store,
        registry: buildRegistry(),
        rolesPolicy: new DefaultRolesPolicy(),
        modelId: 'fake-1',
        day: '2026-06-30',
        systemPrompt: 'base',
        intake: { questions: [SCOPE] },
      } as AgentLoopDeps,
      { threadId, actor: ACTOR, userText: 'do the thing' },
      {
        runId: 'child-1',
        // The ancestor's stream, exactly as both runners wire a delegated run.
        openSink: () => sink.open('parent-1'),
        awaitApproval: async () => ({ approved: true }) as Decision,
        awaitAnswers: async (request: ElicitationRequest) => {
          asked.push(request);
          return { answers: {} };
        },
        step: (_name, fn) => fn(),
      },
    );

    const frames: StreamFrame[] = [];
    for await (const frame of sink.subscribe('parent-1')) frames.push(frame);
    const posted = frames.find((frame) => frame.t === 'elicitation');
    expect(posted).toMatchObject({ t: 'elicitation', runId: 'child-1', id: 'intake-child-1' });
    expect(asked).toHaveLength(1);
  });
});

describe('the elicitation stream frame', () => {
  it('serializes as its own SSE event, carrying the whole request and the run to answer', () => {
    const sse = frameToSse({
      t: 'elicitation',
      runId: 'child-1',
      id: 'req-1',
      request: request(),
    });
    expect(sse.startsWith('event: elicitation\n')).toBe(true);
    expect(sse).toContain('"runId":"child-1"');
    expect(sse).toContain('"id":"req-1"');
    expect(sse).toContain('How wide should I go?');
  });

  it('round-trips through the client decoder with the run and call to address', () => {
    const sse = frameToSse({
      t: 'elicitation',
      runId: 'child-1',
      id: 'req-1',
      request: request(),
    });
    const event = parseSseEvent(sse.trimEnd());
    expect(event).not.toBeNull();
    // Without this the id is on the wire and unreadable by the library's own client.
    expect(event && decodeFrame(event)).toMatchObject({
      type: 'elicitation',
      runId: 'child-1',
      toolCallId: 'req-1',
    });
  });

  it('leaves a text frame’s envelope byte-identical', () => {
    expect(frameToSse({ t: 'text', v: 'hi' })).toBe('data: {"delta":"hi"}\n\n');
  });
});
