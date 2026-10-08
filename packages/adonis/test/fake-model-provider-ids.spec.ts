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
  LucidGovernanceQueries,
  type ModelTurnArgs,
  ToolRegistry,
} from '../src/index.js';
import { FakeModelProvider, type FakeScript } from '../src/testing/index.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

/**
 * `agent_tool_call.id` is the model's tool call id and the table's primary key, across every thread.
 * One `FakeModelProvider` serving several threads (a test app, a demo) must therefore never hand two
 * calls the same id.
 */

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const script: FakeScript = (_args, turnIndex) =>
  turnIndex === 0
    ? { text: 'looking', toolCall: { name: 'lookup', input: { q: 'x' } } }
    : { text: 'answer' };

function argsAt(turns: number): ModelTurnArgs {
  const assistant = { role: 'assistant' as const, content: 'x' };
  return {
    system: '',
    messages: [{ role: 'user', content: 'hi' }, ...Array.from({ length: turns }, () => assistant)],
    tools: [],
    sink: { write: async () => {} } as unknown as ModelTurnArgs['sink'],
  };
}

describe('FakeModelProvider tool call ids', () => {
  it('keeps call-<turn>-<name> for the first call, and never repeats an id', async () => {
    const model = new FakeModelProvider(() => ({
      text: '',
      toolCalls: [
        { name: 'lookup', input: {} },
        { name: 'lookup', input: {} },
      ],
    }));
    const first = await model.runTurn(argsAt(0));
    const second = await model.runTurn(argsAt(0));
    const ids = [...first.toolCalls, ...second.toolCalls].map((call) => call.id);
    expect(ids[0]).toBe('call-0-lookup');
    expect(new Set(ids).size).toBe(4);
    // A fresh provider starts over: the ids are deterministic per instance.
    const again = await new FakeModelProvider(() => ({
      text: '',
      toolCall: { name: 'lookup', input: {} },
    })).runTurn(argsAt(0));
    expect(again.toolCalls[0]?.id).toBe('call-0-lookup');
  });
});

describe('FakeModelProvider over the Lucid store, several threads', () => {
  let db: Database;
  let store: LucidAgentStore;
  let gov: LucidGovernanceQueries;

  beforeEach(async () => {
    db = await makeStoreDb();
    store = new LucidAgentStore(asStoreDb(db));
    gov = new LucidGovernanceQueries(asStoreDb(db));
  });
  afterEach(async () => {
    await db?.manager.closeAll();
  });

  it('runs the same tool on turn 0 of two threads without a primary-key collision', async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'lookup',
        kind: 'read',
        description: 'reads',
        inputSchema: z.object({ q: z.string() }),
        roles: ['ADMIN'],
      },
      { execute: async () => ({ found: true }) },
    );
    const factory = new AgentDepsFactory({
      model: new FakeModelProvider(script),
      store,
      sink: new InProcessTokenStreamSink(),
      rolesPolicy: new DefaultToolAuthorizer(),
      registry,
      agents: new AgentRegistry(),
    });
    const service = new AgentService(new InlineAgentRunner(factory, store), store, factory);

    const statuses: (string | undefined)[] = [];
    for (const message of ['first thread', 'second thread']) {
      const { runId } = await service.chat({ actor, message });
      for await (const _frame of service.subscribe(runId)) {
        /* drain */
      }
      let status: string | undefined;
      for (let i = 0; i < 200; i += 1) {
        status = (await gov.runDetail(runId))?.run.status;
        if (status === 'completed' || status === 'failed') break;
        await sleep(5);
      }
      statuses.push(status);
      expect((await gov.runDetail(runId))?.toolCalls.map((call) => call.status)).toEqual([
        'executed',
      ]);
    }
    expect(statuses).toEqual(['completed', 'completed']);
  });
});
