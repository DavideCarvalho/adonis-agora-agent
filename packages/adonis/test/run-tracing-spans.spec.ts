import diagnostics_channel from 'node:diagnostics_channel';
import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Actor } from '../src/index.js';
import {
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  DefaultToolAuthorizer,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  LucidAgentStore,
  type Passage,
  type Retriever,
  ToolRegistry,
} from '../src/index.js';
import { FakeModelProvider, type FakeScript } from '../src/testing/index.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error('waitFor: condition never became true');
}

/** One captured span-phase envelope (the `SpanEvent` wire shape the agent publishes). */
interface SpanRecord {
  v: number;
  event: string;
  phase: string;
  spanId: string;
  traceId: string;
  ts: number;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

const SPAN_EVENTS = ['turn', 'llm.turn', 'tool.execution', 'retrieval'] as const;
const SPAN_PHASES = ['start', 'end', 'asyncStart', 'asyncEnd', 'error'] as const;

/** Subscribe to every `agora:agent:<event>:<phase>` span sub-channel and record what lands. */
function captureSpans(): { records: SpanRecord[]; stop: () => void } {
  const records: SpanRecord[] = [];
  const subs: Array<[string, (message: unknown) => void]> = [];
  for (const event of SPAN_EVENTS) {
    for (const phase of SPAN_PHASES) {
      const name = `agora:agent:${event}:${phase}`;
      const handler = (message: unknown) => records.push(message as SpanRecord);
      diagnostics_channel.subscribe(name, handler);
      subs.push([name, handler]);
    }
  }
  return {
    records,
    stop: () => {
      for (const [name, handler] of subs) diagnostics_channel.unsubscribe(name, handler);
    },
  };
}

const retriever: Retriever = {
  async retrieve(): Promise<Passage[]> {
    return [{ id: 'p1', text: 'a relevant passage', score: 1 }];
  },
};

function buildService(db: Database, script: FakeScript): AgentService {
  const store = new LucidAgentStore(asStoreDb(db));
  const sink = new InProcessTokenStreamSink();
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'getWeather',
      kind: 'read',
      description: 'weather',
      inputSchema: z.object({ city: z.string() }),
    },
    { execute: async (input: { city: string }) => ({ tempC: 21, city: input.city }) },
  );
  const factory = new AgentDepsFactory({
    model: new FakeModelProvider(script),
    store,
    sink,
    rolesPolicy: new DefaultToolAuthorizer(),
    registry,
    agents: new AgentRegistry(),
    retriever,
  });
  const runner = new InlineAgentRunner(factory, store);
  return new AgentService(runner, store, factory);
}

// A two-step turn: step 0 calls a read tool, step 1 answers — so the trace has 2 llm.turn spans, 1
// tool.execution span, and 1 retrieval span, all nested under the root turn span.
const twoStepScript: FakeScript = (_args, turnIndex) =>
  turnIndex === 0
    ? { text: 'checking', toolCall: { name: 'getWeather', input: { city: 'Recife' } } }
    : { text: 'it is 21C in Recife' };

let dbHandle: Database;
beforeEach(async () => {
  dbHandle = await makeStoreDb();
});
afterEach(async () => {
  await dbHandle.manager.closeAll();
});

describe('run-tracing spans', () => {
  it('emits a root turn span + nested child spans, all carrying traceId = runId', async () => {
    const capture = captureSpans();
    try {
      const service = buildService(dbHandle, twoStepScript);
      const { runId } = await service.chat({ actor, message: 'weather in Recife?' });
      for await (const _frame of service.subscribe(runId)) {
        /* drain to completion */
      }
      // The root span's asyncEnd fires after the loop resolves (just after the stream closes), so wait
      // for the whole trace to settle before asserting.
      await waitFor(() =>
        capture.records.some((r) => r.event === 'turn' && r.phase === 'asyncEnd'),
      );

      const starts = capture.records.filter((r) => r.phase === 'start');
      const byEvent = (event: string) => starts.filter((r) => r.event === event);

      // Exactly one root turn span, correlated to the run.
      const turnStarts = byEvent('turn');
      expect(turnStarts).toHaveLength(1);
      const root = turnStarts[0]!;
      expect(root.traceId).toBe(runId);
      expect(root.payload).toMatchObject({ runId });

      // Child step spans: 2 model calls, 1 tool execution, 1 retrieval.
      const llm = byEvent('llm.turn');
      const tool = byEvent('tool.execution');
      const retrieval = byEvent('retrieval');
      expect(llm).toHaveLength(2);
      expect(tool).toHaveLength(1);
      expect(retrieval).toHaveLength(1);

      // Every span of the turn carries traceId = runId — that's what makes them one trace.
      for (const record of [...llm, ...tool, ...retrieval]) {
        expect(record.traceId).toBe(runId);
      }

      // Payload shapes (redaction posture: names/lengths/counts, never prompt or output text).
      expect(tool[0]!.payload).toMatchObject({
        runId,
        toolName: 'getWeather',
        toolType: 'read',
      });
      expect(retrieval[0]!.payload).toMatchObject({
        runId,
        queryLength: 'weather in Recife?'.length,
      });
      expect(llm[0]!.payload).toMatchObject({ runId, step: 0 });

      // Tree shape: every child span's start falls within the root span's [start, asyncEnd] window
      // (the envelope carries no parentId — nesting is temporal + shared traceId, as telescope reads).
      const rootEnd = capture.records.find((r) => r.event === 'turn' && r.phase === 'asyncEnd')!;
      for (const child of [...llm, ...tool, ...retrieval]) {
        expect(child.ts).toBeGreaterThanOrEqual(root.ts);
        expect(child.ts).toBeLessThanOrEqual(rootEnd.ts);
      }

      // A child span carries a summary on its asyncEnd (token counts here), never the raw output.
      const llmEnd = capture.records.find((r) => r.event === 'llm.turn' && r.phase === 'asyncEnd');
      expect(llmEnd?.result).toHaveProperty('outputTokens');
    } finally {
      capture.stop();
    }
  });

  it('emits NO spans when nothing is subscribed (zero-cost hot path)', async () => {
    // No captureSpans() here — assert the run completes fine and that a late subscriber sees nothing
    // from a run that finished before it subscribed.
    const service = buildService(dbHandle, twoStepScript);
    const { runId } = await service.chat({ actor, message: 'weather?' });
    for await (const _frame of service.subscribe(runId)) {
      /* drain to completion */
    }
    const late = captureSpans();
    try {
      await sleep(20);
      expect(late.records).toHaveLength(0);
    } finally {
      late.stop();
    }
  });
});
