import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, RecordRunStartInput } from '../src/index.js';
import {
  AgentDepsFactory,
  AgentRegistry,
  DefaultToolAuthorizer,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  LucidAgentStore,
  LucidGovernanceQueries,
  registerDelegateTools,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryGovernanceQueries,
} from '../src/testing/index.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'], tenantRef: 'tenant-1' };

/**
 * Everything `recordRunStart` is handed has to come back out of the row the governance read-model
 * feeds on. `parentRunId` is the case this file exists for: the parent->child edge was journaled by
 * the durable runtime and nowhere else, so every reliability and cost surface — all of which read run
 * ROWS — saw a delegation's spend as an orphan turn.
 *
 * The fixture is typed `Required<RecordRunStartInput>` on purpose, the same way
 * `message-fields.spec.ts` is: a new field on the input then fails to COMPILE here until every
 * adapter's row can name it.
 */
function everyRunStartField(threadId: string): Required<RecordRunStartInput> {
  return {
    runId: 'run-child',
    threadId,
    actor,
    agentName: 'researcher',
    parentRunId: 'run-parent',
    durable: true,
  };
}

describe('a recorded run round-trips every field it was started with', () => {
  it('InMemoryAgentStore returns all of them from the governance feed', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor, persona: 'default' });
    const started = everyRunStartField(thread.id);

    await store.recordRunStart(started);

    expect(store.governanceRuns().find((run) => run.runId === started.runId)).toMatchObject({
      agentName: started.agentName,
      parentRunId: started.parentRunId,
      durable: started.durable,
    });
  });

  it('leaves the parent unset for a turn nobody delegated', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor, persona: 'default' });

    await store.recordRunStart({ runId: 'run-root', threadId: thread.id, actor });

    expect(store.governanceRuns()[0]?.parentRunId).toBeUndefined();
    const queries = new InMemoryGovernanceQueries(store);
    expect((await queries.runDetail('run-root'))?.run.parentRunId).toBeNull();
  });

  describe('LucidAgentStore — the column an in-memory map cannot have', () => {
    let db: Database;
    let store: LucidAgentStore;

    beforeEach(async () => {
      db = await makeStoreDb();
      store = new LucidAgentStore(asStoreDb(db));
    });

    afterEach(async () => {
      await db?.manager.closeAll();
    });

    it('reads every started field back off the run row', async () => {
      const thread = await store.createThread({ actor, persona: 'default' });
      const started = everyRunStartField(thread.id);

      await store.recordRunStart(started);

      const queries = new LucidGovernanceQueries(asStoreDb(db));
      expect(await queries.runDetail(started.runId)).toMatchObject({
        run: {
          agentName: started.agentName,
          parentRunId: started.parentRunId,
          durable: started.durable,
        },
      });
    });

    it('reads null for a turn nobody delegated', async () => {
      const thread = await store.createThread({ actor, persona: 'default' });
      await store.recordRunStart({ runId: 'run-root', threadId: thread.id, actor });

      const queries = new LucidGovernanceQueries(asStoreDb(db));
      expect((await queries.runDetail('run-root'))?.run.parentRunId).toBeNull();
    });
  });
});

/**
 * The threading is the half that can be dead without failing anything: a store with the column and a
 * runner that never fills it looks exactly like a deployment nobody delegates in. So this runs a real
 * delegation and asks the read-model which turn paid for the child.
 */
describe('a delegation names the run that asked for it', () => {
  let db: Database;

  beforeEach(async () => {
    db = await makeStoreDb();
  });

  afterEach(async () => {
    await db?.manager.closeAll();
  });

  it('records the parent run on the child run row', async () => {
    const store = new LucidAgentStore(asStoreDb(db));
    const registry = new ToolRegistry();
    const agents = new AgentRegistry();
    agents.register({
      name: 'orchestrator',
      systemPrompt: 'You delegate.',
      delegatesTo: [{ agent: 'researcher', roles: ['ADMIN'] }],
    });
    agents.register({ name: 'researcher', systemPrompt: 'You research.' });
    registerDelegateTools(registry, agents);

    // Turn 1 of whichever agent is running: the orchestrator delegates once, the researcher answers.
    const script: FakeScript = (args, turnIndex) => {
      if (args.system.includes('You research.')) {
        return { text: 'the answer' };
      }
      return turnIndex === 0
        ? { text: 'asking', toolCall: { name: 'ask_researcher', input: { task: 'find out' } } }
        : { text: 'done' };
    };
    const factory = new AgentDepsFactory({
      model: new FakeModelProvider(script),
      store,
      sink: new InProcessTokenStreamSink(),
      rolesPolicy: new DefaultToolAuthorizer(),
      registry,
      agents,
    });
    const runner = new InlineAgentRunner(factory, store);
    const thread = await store.createThread({ actor, persona: 'default' });

    const { runId } = await runner.start({
      threadId: thread.id,
      actor,
      userText: 'go',
      agentName: 'orchestrator',
    });

    const queries = new LucidGovernanceQueries(asStoreDb(db));
    await waitFor(async () => (await queries.listRuns({})).items.length === 2);
    const runs = (await queries.listRuns({})).items;
    const parents = Object.fromEntries(runs.map((run) => [run.agentName, run.parentRunId]));
    expect(parents).toEqual({ orchestrator: null, researcher: runId });
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => Promise<boolean>, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error('waitFor: condition never became true');
}
