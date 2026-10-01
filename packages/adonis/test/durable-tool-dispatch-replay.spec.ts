import {
  BaseWorkflow,
  InMemoryStateStore,
  setWorkflowEngineResolver,
  type WorkflowCtx,
  WorkflowEngine,
} from '@adonis-agora/durable';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DurableAgentRunner,
  registerAgentWorkflow,
  setDurableAgentContext,
} from '../src/durable/index.js';
import type { Actor } from '../src/index.js';
import {
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  DefaultToolAuthorizer,
  type ToolHandler,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';

/**
 * A tool that starts a workflow of the app's own — `SomeWorkflow.dispatch(...)`, reached through
 * whatever service the tool calls — runs INSIDE the agent run's `tool:<callId>` step. The durable
 * runtime routes a `BaseWorkflow` static by the ambient workflow ctx, so inside the agent run's turn
 * that dispatch became `ctx.startChild`: a `spawn:<id>` checkpoint at the position right after the
 * tool's own, written from inside a step body. A replay skips a completed step's body, never asks for
 * that position, and hands it to the next checkpoint the loop wants — `persist:toolexec:<callId>` —
 * which the runtime refuses:
 *
 *   non-determinism at <run>#41: code expects "persist:toolexec:call_…" but history recorded
 *   "spawn:…". The workflow changed under an in-flight run — register a new workflow version.
 *
 * Nothing changed under the run. It takes a REPLAY after such a tool to see it, which is why one
 * approval per turn never did: two actions awaiting approval in the same step suspend the run
 * between the first tool and the second, and the resume is that replay.
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

/** The app's own workflow, started by a tool. Counts the runs that actually executed. */
const ingested: string[] = [];
class IngestWorkflow extends BaseWorkflow {
  static override workflow = { name: 'test.ingest', version: '1' };

  async run(ctx: WorkflowCtx, input: { examId: string }): Promise<{ ok: true }> {
    await ctx.localStep('ingest', async () => {
      ingested.push(input.examId);
    });
    return { ok: true };
  }
}

interface Graph {
  service: AgentService;
  store: InMemoryAgentStore;
  registry: ToolRegistry;
  engine: WorkflowEngine;
  executions: Record<string, number>;
}

function buildGraph(script: FakeScript, preflight?: ToolHandler['preflight']): Graph {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const registry = new ToolRegistry();
  const factory = new AgentDepsFactory({
    model: new FakeModelProvider(script),
    store,
    sink,
    rolesPolicy: new DefaultToolAuthorizer(),
    registry,
    agents: new AgentRegistry(),
  });
  const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
  setDurableAgentContext({ factory, store });
  registerAgentWorkflow(engine);
  const meta = IngestWorkflow.workflow;
  engine.register(meta.name, meta.version, (ctx, input) =>
    new IngestWorkflow().run(ctx, input as { examId: string }),
  );
  // What a `BaseWorkflow` static resolves OUTSIDE a workflow body — the container's engine, in an app.
  setWorkflowEngineResolver(() => engine);
  const service = new AgentService(new DurableAgentRunner(engine), store, factory);
  const executions: Record<string, number> = {};

  // `salvar_exame`: stores something, then hands the rest to a workflow of the app's own.
  registry.register(
    {
      name: 'save_exam',
      kind: 'action',
      description: 'saves the exam and queues its ingest',
      inputSchema: z.object({ examId: z.string() }),
      roles: ['ADMIN'],
    },
    {
      ...(preflight !== undefined ? { preflight } : {}),
      execute: async (input: { examId: string }) => {
        executions.save_exam = (executions.save_exam ?? 0) + 1;
        const { runId } = await IngestWorkflow.dispatch(
          { examId: input.examId },
          { runId: `ingest-${input.examId}` },
        );
        return { saved: true, ingestRunId: runId };
      },
    },
  );
  registry.register(
    {
      name: 'record_measure',
      kind: 'action',
      description: 'records a measure',
      inputSchema: z.object({ value: z.number() }),
      roles: ['ADMIN'],
    },
    {
      execute: async () => {
        executions.record_measure = (executions.record_measure ?? 0) + 1;
        return { recorded: true };
      },
    },
  );
  registry.register(
    {
      name: 'reingest',
      kind: 'read',
      description: 'a read that also kicks a workflow',
      inputSchema: z.object({ examId: z.string() }),
      roles: ['ADMIN'],
    },
    {
      execute: async (input: { examId: string }) => {
        executions.reingest = (executions.reingest ?? 0) + 1;
        await IngestWorkflow.dispatch({ examId: input.examId });
        return { queued: true };
      },
    },
  );
  return { service, store, registry, engine, executions };
}

/** One model step asking for BOTH actions, then an answer. */
const twoActions: FakeScript = (_args, turnIndex) =>
  turnIndex === 0
    ? {
        text: 'Deixa a Vó guardar isso.',
        toolCalls: [
          { name: 'save_exam', input: { examId: 'e1' } },
          { name: 'record_measure', input: { value: 7 } },
        ],
      }
    : { text: 'Prontinho.' };

const SAVE = 'call-0-save_exam';
const MEASURE = 'call-0-record_measure';

async function pendingApprovals(g: Graph): Promise<void> {
  await waitFor(
    () => g.store.toolCallRows().filter((row) => row.status === 'pending_approval').length === 2,
  );
}

async function expectSettledCleanly(g: Graph, runId: string): Promise<void> {
  await waitFor(async () => {
    const status = (await g.engine.getRun(runId))?.status;
    return status === 'completed' || status === 'failed' || status === 'dead';
  });
  const run = await g.engine.getRun(runId);
  expect(run?.error?.message).toBeUndefined();
  expect(run?.status).toBe('completed');
  expect(g.executions.save_exam).toBe(1);
  expect(g.executions.record_measure).toBe(1);
  const rows = g.store.toolCallRows();
  expect(rows.find((row) => row.toolName === 'save_exam')?.status).toBe('executed');
  expect(rows.find((row) => row.toolName === 'record_measure')?.status).toBe('executed');
  // The workflow the tool started ran once, as a run of its own.
  await waitFor(async () => (await g.engine.getRun('ingest-e1'))?.status === 'completed');
  expect(ingested).toEqual(['e1']);
  // Nothing the tool did took a position in the agent run's journal.
  const names = (await g.engine.listCheckpoints(runId)).map((checkpoint) => checkpoint.name);
  expect(names.filter((name) => name.startsWith('spawn:'))).toEqual([]);
}

afterEach(() => {
  setDurableAgentContext(undefined);
  ingested.length = 0;
});

describe('a tool that dispatches a workflow, replayed (durable runner)', () => {
  it('two approvals in one step, approved in the announced order with a replay between them', async () => {
    const g = buildGraph(twoActions);
    const { runId } = await g.service.chat({ actor, message: 'guarda esse exame' });
    await pendingApprovals(g);
    await waitFor(async () => (await g.engine.getRun(runId))?.status === 'suspended');

    await g.service.approve(runId, SAVE);
    await waitFor(() => g.executions.save_exam === 1);
    // The run parks again on the second approval: the next resume replays past the first tool.
    await waitFor(async () => (await g.engine.getRun(runId))?.status === 'suspended');
    await g.service.approve(runId, MEASURE);

    await expectSettledCleanly(g, runId);
  });

  it('two approvals in one step, approved in the reverse order', async () => {
    const g = buildGraph(twoActions);
    const { runId } = await g.service.chat({ actor, message: 'guarda esse exame' });
    await pendingApprovals(g);
    await waitFor(async () => (await g.engine.getRun(runId))?.status === 'suspended');

    // Nobody is waiting on the second call yet: its decision is buffered until the run gets there.
    await g.service.approve(runId, MEASURE);
    await sleep(20);
    expect(g.executions.record_measure).toBeUndefined();
    await g.service.approve(runId, SAVE);

    await expectSettledCleanly(g, runId);
  });

  it('two approvals in one step, approved at the same time', async () => {
    const g = buildGraph(twoActions);
    const { runId } = await g.service.chat({ actor, message: 'guarda esse exame' });
    await pendingApprovals(g);
    await waitFor(async () => (await g.engine.getRun(runId))?.status === 'suspended');

    await Promise.all([g.service.approve(runId, SAVE), g.service.approve(runId, MEASURE)]);

    await expectSettledCleanly(g, runId);
  });

  it('a read that dispatches, then an approval in a LATER step', async () => {
    const script: FakeScript = (_args, turnIndex) => {
      if (turnIndex === 0) {
        return { text: 'olhando', toolCall: { name: 'reingest', input: { examId: 'e9' } } };
      }
      return turnIndex === 1
        ? { text: 'agora salvo', toolCall: { name: 'record_measure', input: { value: 1 } } }
        : { text: 'feito' };
    };
    const g = buildGraph(script);
    const { runId } = await g.service.chat({ actor, message: 'vai' });
    await waitFor(() => g.store.toolCallRows().some((row) => row.status === 'pending_approval'));
    await waitFor(async () => (await g.engine.getRun(runId))?.status === 'suspended');

    await g.service.approve(runId, 'call-1-record_measure');

    await waitFor(async () => {
      const status = (await g.engine.getRun(runId))?.status;
      return status === 'completed' || status === 'failed' || status === 'dead';
    });
    const run = await g.engine.getRun(runId);
    expect(run?.error?.message).toBeUndefined();
    expect(run?.status).toBe('completed');
    expect(g.executions.reingest).toBe(1);
    expect(g.executions.record_measure).toBe(1);
    expect(ingested).toEqual(['e9']);
  });
});

describe('preflight durable journal', () => {
  it('journals prepare once and execution denial before replay resumes the next approval', async () => {
    const phases: string[] = [];
    const g = buildGraph(twoActions, (_input, _ctx, { phase }) => {
      phases.push(phase);
      return phase === 'prepare'
        ? { status: 'ready' }
        : { status: 'denied', reason: 'Order closed' };
    });
    const { runId } = await g.service.chat({ actor, message: 'save it' });
    await pendingApprovals(g);
    await waitFor(async () => (await g.engine.getRun(runId))?.status === 'suspended');
    await g.service.approve(runId, SAVE);
    await waitFor(() =>
      g.store.toolCallRows().some((row) => row.toolName === 'save_exam' && row.status === 'failed'),
    );
    await waitFor(async () => (await g.engine.getRun(runId))?.status === 'suspended');
    await g.service.approve(runId, MEASURE);
    await waitFor(async () => (await g.engine.getRun(runId))?.status === 'completed');
    expect(phases).toEqual(['prepare', 'execute']);
    expect(g.executions.save_exam).toBeUndefined();
    expect(g.executions.record_measure).toBe(1);
    const checkpoints = await g.engine.listCheckpoints(runId);
    expect(checkpoints.find((checkpoint) => checkpoint.name === `tool:${SAVE}`)?.status).toBe(
      'completed',
    );
  });
});
