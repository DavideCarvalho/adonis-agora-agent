import { LucidStateStore, WorkflowEngine } from '@adonis-agora/durable';
import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import * as before from 'agent-0-56';
import * as beforeDurable from 'agent-0-56/durable';
import * as beforeTesting from 'agent-0-56/testing';
import * as before58 from 'agent-0-58';
import * as before58Durable from 'agent-0-58/durable';
import * as before58Testing from 'agent-0-58/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as afterDurable from '../src/durable/index.js';
import * as after from '../src/index.js';
import * as afterTesting from '../src/testing/index.js';
import { makeMemoryDb } from './helpers/make-db.js';

/**
 * A run parked BEFORE the upgrade, replayed AFTER it — on the code that is actually in production.
 *
 * Phase one runs `@adonis-agora/agent@0.56.0` (installed under the `agent-0-56` alias): it starts a
 * turn on a durable engine over SQL and leaves it parked on a person. Phase two is a fresh engine over
 * the same database running THIS code — what a deploy is — and it delivers the decision. Every
 * position the old code recorded has to be asked for again, in the same order, under the same name,
 * or the runtime refuses the run as non-deterministic; the turn has to finish, run each tool once,
 * and start no child it did not start before.
 *
 * Over SQLite always, and over Postgres too when `AGENT_TEST_PG_URL` names one (CI provides it).
 */

type Module = typeof after;
type DurableModule = typeof afterDurable;
type TestingModule = typeof afterTesting;
interface Code {
  agent: Module;
  durable: DurableModule;
  testing: TestingModule;
}
const BEFORE = {
  agent: before as unknown as Module,
  durable: beforeDurable as unknown as DurableModule,
  testing: beforeTesting as unknown as TestingModule,
} satisfies Code;
/** The release that started a detached delegation as a `spawn:` child of the turn. */
const BEFORE_58 = {
  agent: before58 as unknown as Module,
  durable: before58Durable as unknown as DurableModule,
  testing: before58Testing as unknown as TestingModule,
} satisfies Code;
const AFTER = { agent: after, durable: afterDurable, testing: afterTesting } satisfies Code;

const actor = { id: 'u1', roles: ['ADMIN'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const pgUrl = process.env.AGENT_TEST_PG_URL;
const PG_SCHEMA = 'agent_detached_upgrade';

function makePgDb(): Database {
  const target = new URL(pgUrl as string);
  return new Database(
    {
      connection: 'pg',
      connections: {
        pg: {
          client: 'pg',
          connection: {
            host: target.hostname,
            port: Number(target.port || 5432),
            user: decodeURIComponent(target.username),
            password: decodeURIComponent(target.password),
            database: target.pathname.slice(1),
          },
          // Its own schema: other specs drop and create the agent tables in `public` concurrently.
          searchPath: [PG_SCHEMA],
          pool: { min: 0, max: 8 },
        },
      },
    },
    new Logger({ enabled: false }),
    new Emitter(undefined as never),
  );
}

async function freshDb(dialect: 'sqlite' | 'pg'): Promise<Database> {
  if (dialect === 'sqlite') {
    return makeMemoryDb();
  }
  const db = makePgDb();
  await db.rawQuery(`DROP SCHEMA IF EXISTS "${PG_SCHEMA}" CASCADE`);
  await db.rawQuery(`CREATE SCHEMA "${PG_SCHEMA}"`);
  return db;
}

/** The fake model's script, shared by two versions' types. */
type Script = (args: never, turnIndex: number) => unknown;

/** Every engine a test deployed, drained before its database goes away. */
const engines: WorkflowEngine[] = [];

/** Counts every real execution of a tool, across both phases. */
const executions: Record<string, number> = {};

interface Phase {
  service: InstanceType<Module['AgentService']>;
  store: InstanceType<Module['LucidAgentStore']>;
  engine: WorkflowEngine;
  db: Database;
}

/**
 * One deployment of one version of the code over `db`: the agents, the durable engine and the
 * service, exactly as an app wires them. `detached` is how the app declares its orch → research edge
 * in this deployment — an upgrade is also the moment an app starts using a new option.
 */
async function deploy(
  code: Code,
  db: Database,
  stateStore: LucidStateStore,
  script: Script,
  edge: { detached: boolean },
): Promise<Phase> {
  const { agent, durable, testing } = code;
  await agent.createAgentTables(db as never);
  const store = new agent.LucidAgentStore(db as never);
  const registry = new agent.ToolRegistry();
  for (const name of ['record_measure', 'purge_cache']) {
    registry.register(
      {
        name,
        kind: 'action',
        description: name,
        inputSchema: z.object({ value: z.string() }),
        roles: ['ADMIN'],
      },
      {
        execute: async (input: { value: string }) => {
          executions[`${name}:${input.value}`] = (executions[`${name}:${input.value}`] ?? 0) + 1;
          return { ok: input.value };
        },
      },
    );
  }
  const agents = new agent.AgentRegistry();
  agents.register({
    name: 'research',
    systemPrompt: 'research worker',
    tools: ['purge_cache'],
  });
  agents.register({
    name: 'orch',
    systemPrompt: 'orchestrator',
    tools: ['record_measure'],
    delegatesTo: [
      { agent: 'research', roles: ['ADMIN'], ...(edge.detached ? { detached: true } : {}) },
    ],
  });
  agent.registerDelegateTools(registry, agents);
  const factory = new agent.AgentDepsFactory({
    model: new testing.FakeModelProvider(script as never),
    store,
    sink: new testing.InMemoryTokenStreamSink(),
    rolesPolicy: new agent.DefaultToolAuthorizer(),
    registry,
    agents,
    defaultAgentName: 'orch',
  });
  const engine = new WorkflowEngine({ store: stateStore });
  engines.push(engine);
  durable.setDurableAgentContext({ factory, store });
  durable.registerAgentWorkflow(engine);
  const service = new agent.AgentService(
    new durable.DurableAgentRunner(engine, store),
    store,
    factory,
  );
  return { service, store, engine, db };
}

async function statusOf(phase: Phase, runId: string): Promise<string | undefined> {
  return (await phase.engine.getRun(runId))?.status;
}

async function parked(phase: Phase, runId: string, toolName: string): Promise<string> {
  // Read straight off the table: the same question on both versions, with no API in between.
  const callId = await eventually(async () => {
    const row = await phase.db
      .from(after.AGENT_TABLES.toolCalls)
      .where('run_id', runId)
      .where('tool_name', toolName)
      .where('status', 'pending_approval')
      .first();
    return row === null || row === undefined ? undefined : String(row.id);
  }, `${runId} to park on ${toolName}`);
  await eventually(
    async () => ((await statusOf(phase, runId)) === 'suspended' ? true : undefined),
    `${runId} to suspend`,
  );
  return callId;
}

async function settled(phase: Phase, runId: string): Promise<{ status?: string; error?: string }> {
  return eventually(async () => {
    const run = await phase.engine.getRun(runId);
    if (
      run === null ||
      run.status === 'running' ||
      run.status === 'pending' ||
      run.status === 'suspended'
    ) {
      return undefined;
    }
    return {
      status: run.status,
      ...(run.error?.message !== undefined ? { error: run.error.message } : {}),
    };
  }, `${runId} to settle`);
}

async function checkpointNames(phase: Phase, runId: string): Promise<string[]> {
  return (await phase.engine.listCheckpoints(runId)).map((checkpoint) => checkpoint.name);
}

/** The run `runId`'s single `detach:` step started. */
async function detachedChildOf(phase: Phase, runId: string): Promise<string> {
  const detaches = (await phase.engine.listCheckpoints(runId)).filter((checkpoint) =>
    checkpoint.name.startsWith('detach:'),
  );
  expect(detaches).toHaveLength(1);
  return String(detaches[0]?.output);
}

const dialects: ['sqlite' | 'pg'][] = [
  ['sqlite'],
  ...(pgUrl !== undefined ? [['pg'] as ['pg']] : []),
];

describe.each(dialects)('a run parked on 0.56.0, replayed on this release (%s)', (dialect) => {
  let db: Database | undefined;
  afterEach(async () => {
    // Settle whatever an engine still has in flight (a child's completion notice, a reconcile)
    // before the tables it writes to are dropped.
    await Promise.all(
      engines.splice(0).map((engine) => engine.drain(5_000).catch(() => undefined)),
    );
    afterDurable.setDurableAgentContext(undefined);
    BEFORE.durable.setDurableAgentContext(undefined);
    BEFORE_58.durable.setDurableAgentContext(undefined);
    for (const key of Object.keys(executions)) delete executions[key];
    if (db !== undefined && dialect === 'pg') {
      await db.rawQuery(`DROP SCHEMA IF EXISTS "${PG_SCHEMA}" CASCADE`).catch(() => undefined);
    }
    await db?.manager.closeAll();
    db = undefined;
  });

  async function stateStoreOver(database: Database): Promise<LucidStateStore> {
    const stateStore = new LucidStateStore(database);
    await stateStore.ensureSchema();
    return stateStore;
  }

  it('a turn parked on an approval finishes on the new code — and the schema is repaired under it', async () => {
    db = await freshDb(dialect);
    const stateStore = await stateStoreOver(db);
    const script = (_args: unknown, turnIndex: number) =>
      turnIndex === 0
        ? { text: 'recording', toolCall: { name: 'record_measure', input: { value: 'a' } } }
        : { text: 'recorded' };

    const old = await deploy(BEFORE, db, stateStore, script, { detached: false });
    const { runId } = await old.service.chat({ actor, message: 'record it' });
    const callId = await parked(old, runId, 'record_measure');
    const journalBefore = await checkpointNames(old, runId);

    // THE UPGRADE: this release's tables over the old ones (the `agent_name` column is repaired in),
    // and a new engine over the same durable state.
    const repairs = await after.createAgentTables(db as never);
    expect(repairs).toContain(`${after.AGENT_TABLES.messages}.agent_name`);
    const next = await deploy(AFTER, db, stateStore, script, { detached: true });
    await next.service.approve(runId, callId);

    expect(await settled(next, runId)).toEqual({ status: 'completed' });
    expect(executions).toEqual({ 'record_measure:a': 1 });
    const journalAfter = await checkpointNames(next, runId);
    expect(journalAfter.slice(0, journalBefore.length)).toEqual(journalBefore);
    expect(
      journalAfter.filter((name) => name.startsWith('spawn:') || name.startsWith('deliver:')),
    ).toEqual([]);
  });

  it('an awaited delegation parked inside its delegate stays awaited, even once the edge is declared detached', async () => {
    db = await freshDb(dialect);
    const stateStore = await stateStoreOver(db);
    const script = (args: { system: string; messages: { role: string }[] }, turnIndex: number) => {
      if (args.system.includes('research worker')) {
        return turnIndex === 0
          ? { text: 'digging', toolCall: { name: 'purge_cache', input: { value: 'cfg' } } }
          : { text: 'RESEARCH ANSWER' };
      }
      if (turnIndex === 0) {
        return { text: 'asking', toolCall: { name: 'ask_research', input: { task: 'dig' } } };
      }
      return { text: `orch got: ${JSON.stringify(args.messages.at(-1))}` };
    };

    const old = await deploy(BEFORE, db, stateStore, script, { detached: false });
    const { runId, threadId } = await old.service.chat({ actor, message: 'dig into it' });
    // The delegate parks on its own action; the parent is suspended on the child.
    const child = await eventually(async () => {
      const id = (await old.engine.getRunChildren(runId))[0];
      return id;
    }, 'the awaited child to start');
    const purgeId = await parked(old, child, 'purge_cache');
    await eventually(
      async () => ((await statusOf(old, runId)) === 'suspended' ? true : undefined),
      'the parent to suspend on its child',
    );

    await after.createAgentTables(db as never);
    const next = await deploy(AFTER, db, stateStore, script, { detached: true });
    await next.service.approve(child, purgeId);

    expect(await settled(next, child)).toEqual({ status: 'completed' });
    expect(await settled(next, runId)).toEqual({ status: 'completed' });
    expect(executions).toEqual({ 'purge_cache:cfg': 1 });
    // The parent's answer is built from the child's ANSWER — the awaited branch the journal holds.
    const detail = await next.store.getThread(threadId);
    expect(detail?.messages.at(-1)?.content).toContain('RESEARCH ANSWER');
    expect(detail?.messages.some((message) => message.agentName !== undefined)).toBe(false);
    const names = await checkpointNames(next, runId);
    expect(names.filter((name) => name.startsWith('spawn:'))).toEqual([]);
    expect(names.filter((name) => name.startsWith('signal:child:'))).toHaveLength(1);
  });

  it('a run parked before the upgrade delegates in the background in the steps it takes after it', async () => {
    db = await freshDb(dialect);
    const stateStore = await stateStoreOver(db);
    const script = (args: { system: string; messages: { role: string }[] }, turnIndex: number) => {
      if (args.system.includes('research worker')) {
        return turnIndex === 0
          ? { text: 'digging', toolCall: { name: 'purge_cache', input: { value: 'bg' } } }
          : { text: 'RESEARCH ANSWER' };
      }
      if (turnIndex === 0) {
        return { text: 'first', toolCall: { name: 'record_measure', input: { value: 'b' } } };
      }
      if (turnIndex === 1) {
        return {
          text: 'now research',
          toolCall: { name: 'start_research', input: { task: 'dig' } },
        };
      }
      return { text: 'started it' };
    };

    const old = await deploy(BEFORE, db, stateStore, script, { detached: false });
    const { runId, threadId } = await old.service.chat({ actor, message: 'go' });
    const callId = await parked(old, runId, 'record_measure');

    await after.createAgentTables(db as never);
    const next = await deploy(AFTER, db, stateStore, script, { detached: true });
    await next.service.approve(runId, callId);

    // The parent finishes WITHOUT the answer: the delegate is parked on its own approval.
    expect(await settled(next, runId)).toEqual({ status: 'completed' });
    const names = await checkpointNames(next, runId);
    // The shape this release starts a detached run with: a run of its own, from a `detach:` step.
    expect(names.filter((name) => name.startsWith('spawn:'))).toEqual([]);
    expect(names).toContain('patch:agent:detached-unlinked');
    const child = await detachedChildOf(next, runId);
    const purgeId = await parked(next, child, 'purge_cache');
    await next.service.approve(child, purgeId);

    expect(await settled(next, child)).toEqual({ status: 'completed' });
    const delivered = await eventually(
      async () =>
        (await next.store.getThread(threadId))?.messages.find(
          (message) => message.content === 'RESEARCH ANSWER',
        ),
      'the detached answer',
    );
    expect(delivered).toMatchObject({ runId: child, agentName: 'research' });
    expect(executions).toEqual({ 'record_measure:b': 1, 'purge_cache:bg': 1 });
  });
});

/**
 * A run parked on 0.58.0 — the release whose detached delegation was a `spawn:` child of the turn —
 * replayed on this one, which starts it as a run of its own. Such a run's journal holds the `spawn:`,
 * so it must replay it (no `patch:` marker, no `detach:`), and its Stop still cascades to the child:
 * what this release can still do for it is settle that child's card instead of leaving it "started".
 */
describe.each(dialects)(
  'a detached run parked on 0.58.0, replayed on this release (%s)',
  (dialect) => {
    let db: Database | undefined;
    afterEach(async () => {
      await Promise.all(
        engines.splice(0).map((engine) => engine.drain(5_000).catch(() => undefined)),
      );
      afterDurable.setDurableAgentContext(undefined);
      BEFORE_58.durable.setDurableAgentContext(undefined);
      for (const key of Object.keys(executions)) delete executions[key];
      if (db !== undefined && dialect === 'pg') {
        await db.rawQuery(`DROP SCHEMA IF EXISTS "${PG_SCHEMA}" CASCADE`).catch(() => undefined);
      }
      await db?.manager.closeAll();
      db = undefined;
    });

    /** Detaches, then parks on its own action: the parent is live after its `spawn:`. */
    const script = (args: { system: string }, turnIndex: number) => {
      if (args.system.includes('research worker')) {
        return turnIndex === 0
          ? { text: 'digging', toolCall: { name: 'purge_cache', input: { value: 'bg' } } }
          : { text: 'RESEARCH ANSWER' };
      }
      if (turnIndex === 0) {
        return { text: 'starting', toolCall: { name: 'start_research', input: { task: 'dig' } } };
      }
      if (turnIndex === 1) {
        return { text: 'and this', toolCall: { name: 'record_measure', input: { value: 'c' } } };
      }
      return { text: 'ORCH DONE' };
    };

    async function parkOn58(): Promise<{
      stateStore: LucidStateStore;
      runId: string;
      threadId: string;
      child: string;
    }> {
      db = await freshDb(dialect);
      const stateStore = new LucidStateStore(db);
      await stateStore.ensureSchema();
      const old = await deploy(BEFORE_58, db, stateStore, script, { detached: true });
      const { runId, threadId } = await old.service.chat({ actor, message: 'go' });
      await parked(old, runId, 'record_measure');
      const spawns = (await checkpointNames(old, runId)).filter((name) =>
        name.startsWith('spawn:'),
      );
      expect(spawns).toHaveLength(1);
      const child = (spawns[0] as string).slice('spawn:'.length);
      await parked(old, child, 'purge_cache');
      return { stateStore, runId, threadId, child };
    }

    it('replays the `spawn:` it journaled, and the child it started still delivers once', async () => {
      const { stateStore, runId, threadId, child } = await parkOn58();
      await after.createAgentTables(db as never);
      const next = await deploy(AFTER, db as Database, stateStore, script, { detached: true });

      const measure = await parked(next, runId, 'record_measure');
      await next.service.approve(runId, measure);
      expect(await settled(next, runId)).toEqual({ status: 'completed' });
      const purge = await parked(next, child, 'purge_cache');
      await next.service.approve(child, purge);
      expect(await settled(next, child)).toEqual({ status: 'completed' });

      const names = await checkpointNames(next, runId);
      expect(names.filter((name) => name.startsWith('spawn:'))).toEqual([`spawn:${child}`]);
      expect(names).not.toContain('patch:agent:detached-unlinked');
      expect(names.filter((name) => name.startsWith('detach:'))).toEqual([]);
      const messages = (await next.store.getThread(threadId))?.messages ?? [];
      expect(messages.filter((message) => message.content === 'RESEARCH ANSWER')).toHaveLength(1);
      expect(executions).toEqual({ 'record_measure:c': 1, 'purge_cache:bg': 1 });
    });

    it('settles the card of the child its Stop still cascades to', async () => {
      const { stateStore, runId, threadId, child } = await parkOn58();
      await after.createAgentTables(db as never);
      const next = await deploy(AFTER, db as Database, stateStore, script, { detached: true });

      await next.service.cancel(runId);
      expect((await settled(next, runId)).status).toBe('cancelled');
      expect((await settled(next, child)).status).toBe('cancelled');
      const card = await eventually(async () => {
        const row = await next.db
          .from(after.AGENT_TABLES.toolCalls)
          .where('tool_name', 'start_research')
          .first();
        const output = typeof row?.output === 'string' ? JSON.parse(row.output) : row?.output;
        return output?.status === 'cancelled' ? output : undefined;
      }, 'the card to say the child was stopped');
      expect(card).toMatchObject({ detached: true, status: 'cancelled', runId: child });
      const told = ((await next.store.getThread(threadId))?.messages ?? []).filter((message) =>
        message.content.includes('was stopped before it could answer'),
      );
      expect(told).toHaveLength(1);
      expect(executions).toEqual({});
    });
  },
);
