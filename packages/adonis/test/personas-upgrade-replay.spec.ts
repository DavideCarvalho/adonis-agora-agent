import { LucidStateStore, WorkflowEngine } from '@adonis-agora/durable';
import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import * as before from 'agent-0-59';
import * as beforeDurable from 'agent-0-59/durable';
import * as beforeTesting from 'agent-0-59/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as afterDurable from '../src/durable/index.js';
import * as after from '../src/index.js';
import * as afterTesting from '../src/testing/index.js';
import { makeMemoryDb } from './helpers/make-db.js';

/**
 * Personas under the durable runner, across deployments — the part of a persona that has to survive a
 * run being parked: the definition is frozen in `persona:resolve`, so every later step of the run
 * (each of them possibly on another deployment) runs on the prompt and the offer it started with,
 * whatever the config says by then.
 *
 * Two halves:
 *  - THIS code, redeployed between every signal: a run that parks twice is resumed first by a
 *    deployment that rewrote the persona, then by one that removed it.
 *  - The published `@adonis-agora/agent@0.59.0` (installed under the `agent-0-59` alias) parks a run,
 *    and this code resumes it: its journal has no `persona:resolve`, so none may be asked for — even
 *    once the agent declares personas and a default, or the agent was folded into another's persona.
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
const PG_SCHEMA = 'agent_personas_upgrade';

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

/** One model call: which deployment made it, and what it was handed. */
interface ModelCall {
  phase: string;
  system: string;
  tools: string[];
}

/** Every engine a test deployed, drained before its database goes away. */
const engines: WorkflowEngine[] = [];
/** Counts every real execution of a tool, across every deployment. */
const executions: Record<string, number> = {};
const calls: ModelCall[] = [];

/** Calls `record_a`, then `record_b` (each parks on its approval), then answers. */
function script(phase: string) {
  return (args: { system: string; tools: { name: string }[] }, turnIndex: number) => {
    calls.push({ phase, system: args.system, tools: args.tools.map((tool) => tool.name) });
    if (turnIndex === 0)
      return { text: 'a', toolCall: { name: 'record_a', input: { value: 'a' } } };
    if (turnIndex === 1)
      return { text: 'b', toolCall: { name: 'record_b', input: { value: 'b' } } };
    return { text: 'done' };
  };
}

interface Phase {
  service: InstanceType<Module['AgentService']>;
  store: InstanceType<Module['LucidAgentStore']>;
  engine: WorkflowEngine;
  db: Database;
}

/**
 * One deployment of one version of the code over `db`, exactly as an app wires it, with `agents` as
 * this deployment's `config/agent.ts` declares them.
 */
async function deploy(
  code: Code,
  db: Database,
  stateStore: LucidStateStore,
  phase: string,
  agents: Record<string, unknown>[],
): Promise<Phase> {
  const { agent, durable, testing } = code;
  await agent.createAgentTables(db as never);
  const store = new agent.LucidAgentStore(db as never);
  const registry = new agent.ToolRegistry();
  for (const name of ['record_a', 'record_b', 'drop_tables']) {
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
  const registered = new agent.AgentRegistry();
  for (const definition of agents) registered.register(definition as never);
  const factory = new agent.AgentDepsFactory({
    model: new testing.FakeModelProvider(script(phase) as never),
    store,
    sink: new testing.InMemoryTokenStreamSink(),
    rolesPolicy: new agent.DefaultToolAuthorizer(),
    registry,
    agents: registered,
    defaultAgentName: String(agents[0]?.name),
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

async function parked(phase: Phase, runId: string, toolName: string): Promise<string> {
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
    async () => ((await phase.engine.getRun(runId))?.status === 'suspended' ? true : undefined),
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

/** Retire a deployment: let its engine finish what it has in flight, as a draining pod would. */
async function retire(phase: Phase): Promise<void> {
  await phase.engine.drain(5_000).catch(() => undefined);
}

const dialects: ['sqlite' | 'pg'][] = [
  ['sqlite'],
  ...(pgUrl !== undefined ? [['pg'] as ['pg']] : []),
];

describe.each(dialects)('personas — a parked run across deployments (%s)', (dialect) => {
  let db: Database | undefined;
  afterEach(async () => {
    await Promise.all(
      engines.splice(0).map((engine) => engine.drain(5_000).catch(() => undefined)),
    );
    afterDurable.setDurableAgentContext(undefined);
    BEFORE.durable.setDurableAgentContext(undefined);
    for (const key of Object.keys(executions)) delete executions[key];
    calls.splice(0);
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

  const ops = (personas: unknown[], extra: Record<string, unknown> = {}) => ({
    name: 'ops',
    systemPrompt: 'ops base',
    personas,
    ...extra,
  });
  const RO_V1 = {
    id: 'ro',
    label: 'Recorder',
    systemPrompt: (ctx: { basePrompt: string }) => `${ctx.basePrompt} | recorder v1`,
    allowedTools: ['record_a', 'record_b'],
  };

  it('phase one really is the release without durable personas', () => {
    expect((before as Record<string, unknown>).resolvePersonaAlias).toBeUndefined();
    expect((before as Record<string, unknown>).PersonaNotFoundError).toBeUndefined();
    expect(after.resolvePersonaAlias).toBeTypeOf('function');
  });

  it('resumes between signals on the persona it started with — rewritten, then removed', async () => {
    db = await freshDb(dialect);
    const stateStore = await stateStoreOver(db);

    const first = await deploy(AFTER, db, stateStore, 'v1', [ops([RO_V1])]);
    const { runId, threadId } = await first.service.chat({
      actor,
      message: 'record both',
      agentName: 'ops',
      personaId: 'ro',
    });
    const callA = await parked(first, runId, 'record_a');
    await retire(first);

    // Deployment two rewrote the persona: another prompt, and an allow-list without `record_b`.
    const second = await deploy(AFTER, db, stateStore, 'v2', [
      ops([{ ...RO_V1, systemPrompt: 'recorder v2', allowedTools: ['record_a', 'drop_tables'] }]),
    ]);
    await second.service.approve(runId, callA);
    const callB = await parked(second, runId, 'record_b');
    await retire(second);

    // Deployment three removed it altogether.
    const third = await deploy(AFTER, db, stateStore, 'v3', [ops([])]);
    await third.service.approve(runId, callB);
    expect(await settled(third, runId)).toEqual({ status: 'completed' });

    // Every model call — each on a different deployment — ran on the recorded prompt and offer.
    expect(calls).toEqual([
      { phase: 'v1', system: 'ops base | recorder v1', tools: ['record_a', 'record_b'] },
      { phase: 'v2', system: 'ops base | recorder v1', tools: ['record_a', 'record_b'] },
      { phase: 'v3', system: 'ops base | recorder v1', tools: ['record_a', 'record_b'] },
    ]);
    expect(executions).toEqual({ 'record_a:a': 1, 'record_b:b': 1 });
    const names = await checkpointNames(third, runId);
    expect(names[0]).toBe('persona:resolve');
    expect(names.filter((name) => name === 'persona:resolve')).toHaveLength(1);
    // Every message of the turn says which persona wrote it.
    const detail = await third.store.getThread(threadId);
    expect(new Set(detail?.messages.map((message) => message.persona))).toEqual(new Set(['ro']));
  });

  it('a run parked on 0.59.0 replays on the sequence it recorded once its agent declares personas and a default', async () => {
    db = await freshDb(dialect);
    const stateStore = await stateStoreOver(db);

    const old = await deploy(BEFORE, db, stateStore, '0.59', [ops([])]);
    const { runId } = await old.service.chat({ actor, message: 'record both', agentName: 'ops' });
    const callA = await parked(old, runId, 'record_a');
    const journalBefore = await checkpointNames(old, runId);
    await retire(old);

    // THE UPGRADE, and the app starts using personas in the same deploy.
    await after.createAgentTables(db as never);
    const withDefault = [
      { id: 'general', label: 'General', systemPrompt: 'general persona' },
      RO_V1,
    ];
    const next = await deploy(AFTER, db, stateStore, 'next', [
      ops(withDefault, { defaultPersona: 'general' }),
    ]);
    await next.service.approve(runId, callA);
    const callB = await parked(next, runId, 'record_b');
    await retire(next);

    const last = await deploy(AFTER, db, stateStore, 'last', [
      ops(withDefault, { defaultPersona: 'ro' }),
    ]);
    await last.service.approve(runId, callB);
    expect(await settled(last, runId)).toEqual({ status: 'completed' });

    expect(executions).toEqual({ 'record_a:a': 1, 'record_b:b': 1 });
    const journalAfter = await checkpointNames(last, runId);
    expect(journalAfter.slice(0, journalBefore.length)).toEqual(journalBefore);
    expect(journalAfter).not.toContain('persona:resolve');
    // It named no persona when it started, and it never picks one up: the base prompt throughout.
    expect(calls.map((call) => call.system)).toEqual(['ops base', 'ops base', 'ops base']);
  });

  it('a run parked on 0.59.0 under a persona keeps it, with no checkpoint it never recorded', async () => {
    db = await freshDb(dialect);
    const stateStore = await stateStoreOver(db);
    const flat = {
      id: 'ro',
      label: 'Recorder',
      systemPrompt: 'recorder flat',
      allowedTools: ['record_a', 'record_b'],
    };

    const old = await deploy(BEFORE, db, stateStore, '0.59', [ops([flat])]);
    const { runId } = await old.service.chat({
      actor,
      message: 'record both',
      agentName: 'ops',
      personaId: 'ro',
    });
    const callA = await parked(old, runId, 'record_a');
    const journalBefore = await checkpointNames(old, runId);
    await retire(old);

    await after.createAgentTables(db as never);
    const next = await deploy(AFTER, db, stateStore, 'next', [
      ops([{ ...flat, systemPrompt: 'recorder rewritten', allowedTools: ['record_a'] }]),
    ]);
    await next.service.approve(runId, callA);
    const callB = await parked(next, runId, 'record_b');
    await retire(next);

    const last = await deploy(AFTER, db, stateStore, 'last', [ops([])]);
    await last.service.approve(runId, callB);
    expect(await settled(last, runId)).toEqual({ status: 'completed' });

    expect(executions).toEqual({ 'record_a:a': 1, 'record_b:b': 1 });
    const journalAfter = await checkpointNames(last, runId);
    expect(journalAfter.slice(0, journalBefore.length)).toEqual(journalBefore);
    expect(journalAfter).not.toContain('persona:resolve');
    // The persona rode the run's input on 0.59.0 — what a resume reads, not the config.
    expect(calls).toEqual([
      { phase: '0.59', system: 'recorder flat', tools: ['record_a', 'record_b'] },
      { phase: 'next', system: 'recorder flat', tools: ['record_a', 'record_b'] },
      { phase: 'last', system: 'recorder flat', tools: ['record_a', 'record_b'] },
    ]);
  });

  it('finishes a run parked on 0.59.0 under an agent that is now a persona of another', async () => {
    db = await freshDb(dialect);
    const stateStore = await stateStoreOver(db);

    const old = await deploy(BEFORE, db, stateStore, '0.59', [
      { name: 'assistant', systemPrompt: 'assistant base' },
      { name: 'recorder', systemPrompt: 'recorder agent', tools: ['record_a', 'record_b'] },
    ]);
    const { runId } = await old.service.chat({
      actor,
      message: 'record both',
      agentName: 'recorder',
    });
    const callA = await parked(old, runId, 'record_a');
    const journalBefore = await checkpointNames(old, runId);
    await retire(old);

    // The fold: `recorder` is now a persona of `assistant`, answering for the old name.
    await after.createAgentTables(db as never);
    const folded = [
      {
        name: 'assistant',
        systemPrompt: 'assistant base',
        personas: [
          {
            id: 'recorder',
            label: 'Recorder',
            systemPrompt: 'recorder agent',
            allowedTools: ['record_a', 'record_b'],
            aliases: ['recorder'],
          },
        ],
      },
    ];
    const next = await deploy(AFTER, db, stateStore, 'next', folded);
    await next.service.approve(runId, callA);
    const callB = await parked(next, runId, 'record_b');
    await retire(next);

    const last = await deploy(AFTER, db, stateStore, 'last', folded);
    await last.service.approve(runId, callB);
    expect(await settled(last, runId)).toEqual({ status: 'completed' });

    expect(executions).toEqual({ 'record_a:a': 1, 'record_b:b': 1 });
    const journalAfter = await checkpointNames(last, runId);
    expect(journalAfter.slice(0, journalBefore.length)).toEqual(journalBefore);
    expect(journalAfter).not.toContain('persona:resolve');
    // Served as the persona that took the name over: its prompt and its allow-list, as config.
    expect(calls.map((call) => [call.system, call.tools])).toEqual([
      ['recorder agent', ['record_a', 'record_b']],
      ['recorder agent', ['record_a', 'record_b']],
      ['recorder agent', ['record_a', 'record_b']],
    ]);
  });
});
