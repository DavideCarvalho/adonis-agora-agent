import { InMemoryStateStore, WorkflowEngine } from '@adonis-agora/durable';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DurableAgentRunner,
  registerAgentWorkflow,
  setDurableAgentContext,
} from '../src/durable/index.js';
import type { Actor, ModelMessage, StreamFrame, UpdateToolCallInput } from '../src/index.js';
import {
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  DefaultToolAuthorizer,
  exposeStreamErrorDetails,
  RUN_ENDED_BEFORE_TOOL_CALL,
  RUN_FAILED_MESSAGE,
  RunNotActiveError,
  settleDanglingToolCalls,
  streamErrorFrame,
  ToolRegistry,
  UNFINISHED_TOOL_CALL,
} from '../src/index.js';
import {
  FakeModelProvider,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';

/**
 * One dead turn must not take its thread with it.
 *
 * In production a turn asked for two approvals in one step; both were given; the run then failed on
 * the first tool's `persist:toolexec` (the runtime refused the position). What it left behind: an
 * assistant message asking for two tools and answered by none, a call still `pending_approval`, a
 * run row still `running`, and a thread still pointed at the run. The person's next message on the
 * same thread then failed too — "No output generated. Check the stream for errors." — because the
 * provider was handed a tool call with no result after it.
 */

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean | Promise<boolean>, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return;
    await sleep(5);
  }
  throw new Error('waitFor: condition never became true');
}

/** The runtime's own refusal, as the loop recognises it: by name. */
class NonDeterminismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonDeterminismError';
  }
}

const SAVE = 'call-0-save_exam';
const MEASURE = 'call-0-record_measure';

class BreakingStore extends InMemoryAgentStore {
  /** The failure `persist:toolexec:<MEASURE>` raises, while armed. */
  breakWith: Error | undefined;

  override async updateToolCall(input: UpdateToolCallInput): Promise<void> {
    if (
      this.breakWith !== undefined &&
      input.toolCallId === MEASURE &&
      input.status === 'executed'
    ) {
      throw this.breakWith;
    }
    await super.updateToolCall(input);
  }
}

function buildGraph() {
  const store = new BreakingStore();
  const sink = new InMemoryTokenStreamSink();
  const registry = new ToolRegistry();
  const prompts: ModelMessage[][] = [];
  const executions: Record<string, number> = {};
  const model = new FakeModelProvider((args) => {
    prompts.push(args.messages);
    const asked = args.messages.filter((message) => message.role === 'user' && message.content);
    const answered = args.messages.some((message) => (message.toolCalls ?? []).length > 0);
    if (asked.length === 1 && !answered) {
      return {
        text: 'Deixa a Vó guardar isso.',
        toolCalls: [
          { name: 'save_exam', input: { examId: 'e1' } },
          { name: 'record_measure', input: { value: 7 } },
        ],
      };
    }
    return { text: 'Olhei aqui: o exame ficou salvo, a medida não.' };
  });
  const factory = new AgentDepsFactory({
    model,
    store,
    sink,
    rolesPolicy: new DefaultToolAuthorizer(),
    registry,
    agents: new AgentRegistry(),
  });
  const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
  setDurableAgentContext({ factory, store });
  registerAgentWorkflow(engine);
  const service = new AgentService(new DurableAgentRunner(engine), store, factory);
  for (const name of ['save_exam', 'record_measure']) {
    registry.register(
      {
        name,
        kind: 'action',
        description: name,
        inputSchema: z.object({}).passthrough(),
        roles: ['ADMIN'],
      },
      {
        execute: async () => {
          executions[name] = (executions[name] ?? 0) + 1;
          return { done: name };
        },
      },
    );
  }
  return { store, service, engine, prompts, executions };
}

async function frames(
  service: AgentService,
  runId: string,
): Promise<{ text: string; error?: Extract<StreamFrame, { t: 'error' }> }> {
  let text = '';
  let error: Extract<StreamFrame, { t: 'error' }> | undefined;
  for await (const frame of service.subscribe(runId)) {
    if (frame.t === 'text') text += frame.v;
    if (frame.t === 'error') error = frame;
  }
  return { text, ...(error !== undefined ? { error } : {}) };
}

async function failTheTurn(g: ReturnType<typeof buildGraph>, breakWith: Error) {
  const { runId, threadId } = await g.service.chat({ actor, message: 'guarda esse exame' });
  await waitFor(
    () => g.store.toolCallRows().filter((row) => row.status === 'pending_approval').length === 2,
  );
  await waitFor(async () => (await g.engine.getRun(runId))?.status === 'suspended');
  // Both confirmed, as in production. The first tool runs and is settled; the run parks on the
  // second approval, and dies settling what came after it.
  await g.service.approve(runId, SAVE);
  await waitFor(() => g.executions.save_exam === 1);
  await waitFor(async () => (await g.engine.getRun(runId))?.status === 'suspended');
  g.store.breakWith = breakWith;
  await g.service.approve(runId, MEASURE);
  await waitFor(async () => (await g.engine.getRun(runId))?.status === 'failed');
  // Left armed: the runtime may re-drive a failed run (a late wake from the suspension it was
  // resumed from), and a run that died this way dies the same way again.
  return { runId, threadId };
}

afterEach(() => {
  setDurableAgentContext(undefined);
  exposeStreamErrorDetails(undefined);
});

describe('a turn that died mid-step', () => {
  for (const [label, failure] of [
    [
      'the runtime refused a checkpoint position',
      new NonDeterminismError(
        'non-determinism at r#41: code expects "persist:toolexec:x" but history recorded "spawn:y"',
      ),
    ],
    ['an ordinary failure', new Error('connection reset by peer 10.0.0.7:5432')],
  ] as const) {
    it(`leaves its thread usable — ${label}`, async () => {
      exposeStreamErrorDetails(false);
      const g = buildGraph();
      const { runId, threadId } = await failTheTurn(g, failure);

      // The person is told it failed — in words meant for a person, under a code a client can use.
      const stream = await frames(g.service, runId);
      expect(stream.error?.message).toBe(RUN_FAILED_MESSAGE);
      expect(stream.error?.code).toBe(
        failure.name === 'NonDeterminismError' ? 'replay_diverged' : 'run_failed',
      );

      // Nothing is left waiting on the dead run.
      expect(g.executions).toEqual({ save_exam: 1, record_measure: 1 });
      const rows = g.store.toolCallRows();
      expect(rows.filter((row) => row.status === 'pending_approval')).toEqual([]);
      expect(rows.map((row) => row.status)).toEqual(['executed', 'failed']);
      expect(g.store.governanceRuns().find((run) => run.runId === runId)?.status).toBe('failed');
      expect(await g.store.activeRunForThread(threadId)).toBeNull();
      // A decision for it is refused, not swallowed.
      await expect(g.service.approve(runId, MEASURE)).rejects.toBeInstanceOf(RunNotActiveError);

      // "Acho que deu erro, não deve ter registrado a medida né" — on the SAME thread.
      const next = await g.service.chat({ actor, threadId, message: 'deu erro? vê aí' });
      const answer = await frames(g.service, next.runId);
      expect(answer.error).toBeUndefined();
      expect(answer.text).toContain('Olhei aqui');
      await waitFor(async () => (await g.engine.getRun(next.runId))?.status === 'completed');

      // What the model was shown: every call the dead turn made is answered.
      const prompt =
        g.prompts.find((messages) => messages.some((m) => m.content.startsWith('deu erro'))) ?? [];
      const asking = prompt.find((message) => (message.toolCalls ?? []).length > 0);
      expect(asking?.toolCalls?.map((call) => call.id)).toEqual([SAVE, MEASURE]);
      expect(asking?.toolResults?.map((result) => result.id)).toEqual([SAVE, MEASURE]);
      // The tool that ran is answered with what it returned — so it is not run again — and the one
      // the run died on with what its row says.
      expect(asking?.toolResults).toEqual([
        { id: SAVE, name: 'save_exam', output: { done: 'save_exam' } },
        { id: MEASURE, name: 'record_measure', output: null, error: RUN_ENDED_BEFORE_TOOL_CALL },
      ]);
      // Nothing was run again behind anyone's back.
      expect(g.executions).toEqual({ save_exam: 1, record_measure: 1 });
    });
  }
});

describe('settleDanglingToolCalls', () => {
  const asking: ModelMessage = {
    role: 'assistant',
    content: 'vou salvar',
    toolCalls: [
      { id: 'a', name: 'save_exam', input: {} },
      { id: 'b', name: 'record_measure', input: {} },
      { id: 'c', name: 'delete_all', input: {} },
    ],
  };

  it('answers each dangling call with what its row says happened', () => {
    const [healed] = settleDanglingToolCalls(
      [asking],
      [
        { id: 'a', status: 'executed', output: { saved: true } },
        { id: 'c', status: 'rejected' },
      ],
    );
    expect(healed?.toolResults).toEqual([
      { id: 'a', name: 'save_exam', output: { saved: true } },
      { id: 'b', name: 'record_measure', output: null, error: UNFINISHED_TOOL_CALL },
      expect.objectContaining({ id: 'c', denied: true }),
    ]);
  });

  it('keeps the results a message already has, and leaves a whole history untouched', () => {
    const partial: ModelMessage = {
      ...asking,
      toolResults: [{ id: 'a', name: 'save_exam', output: 1 }],
    };
    const [healed] = settleDanglingToolCalls([partial]);
    expect(healed?.toolResults?.map((result) => result.id)).toEqual(['a', 'b', 'c']);
    expect(healed?.toolResults?.[0]).toEqual({ id: 'a', name: 'save_exam', output: 1 });

    const whole: ModelMessage[] = [{ role: 'user', content: 'oi' }, healed as ModelMessage];
    expect(settleDanglingToolCalls(whole)).toEqual(whole);
    expect(settleDanglingToolCalls(whole)[1]).toBe(whole[1]);
  });
});

describe('streamErrorFrame', () => {
  it('keeps internals off the frame in production, and the code stable', () => {
    exposeStreamErrorDetails(false);
    const noOutput = new Error('No output generated. Check the stream for errors.');
    noOutput.name = 'AI_NoOutputGeneratedError';
    expect(streamErrorFrame(noOutput, 'r1')).toEqual({
      t: 'error',
      code: 'model_no_output',
      message: RUN_FAILED_MESSAGE,
    });
    expect(streamErrorFrame(new NonDeterminismError('non-determinism at r#41'), 'r1')).toEqual({
      t: 'error',
      code: 'replay_diverged',
      message: RUN_FAILED_MESSAGE,
    });
  });

  it('carries the error itself where the reader is the one debugging it', () => {
    exposeStreamErrorDetails(true);
    expect(streamErrorFrame(new Error('boom'), 'r1')).toEqual({
      t: 'error',
      code: 'run_failed',
      message: 'boom',
    });
  });
});
