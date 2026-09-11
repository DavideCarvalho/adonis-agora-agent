import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, AgentLoopDeps, AgentLoopHooks, ToolResult } from '../src/index.js';
import {
  AgentDepsFactory,
  AgentRegistry,
  DefaultRolesPolicy,
  DefaultToolAuthorizer,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  LucidAgentStore,
  LucidGovernanceQueries,
  registerDelegateTools,
  runAgentLoop,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';
import { Journal } from './helpers/journal.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };

/** Two agents that hand off to each other — the mutual edge, which no single declaration expresses. */
function agentsWithHandoffs(): { registry: ToolRegistry; agents: AgentRegistry } {
  const registry = new ToolRegistry();
  const agents = new AgentRegistry();
  agents.register({
    name: 'alpha',
    systemPrompt: 'You are alpha.',
    delegatesTo: [{ agent: 'beta', roles: ['ADMIN'] }],
  });
  agents.register({
    name: 'beta',
    systemPrompt: 'You are beta.',
    delegatesTo: [{ agent: 'alpha', roles: ['ADMIN'] }],
  });
  registerDelegateTools(registry, agents);
  return { registry, agents };
}

/** Every agent delegates once, immediately — so nothing but a guard can end the chain. */
const alwaysHandsOff: FakeScript = (args, turnIndex) => {
  const target = args.system.includes('You are alpha.') ? 'beta' : 'alpha';
  return turnIndex === 0
    ? { text: 'handing off', toolCall: { name: `ask_${target}`, input: { task: 'keep going' } } }
    : { text: 'done' };
};

interface LoopPass {
  results: ToolResult[];
  delegatedTo: string[];
  journalNames: string[];
}

/**
 * One turn of `alpha`, with the chain that reached it supplied directly — so a refusal can be
 * asserted without running the whole chain that would produce it.
 */
async function oneTurn(options: {
  delegationPath?: readonly string[];
  delegationDepth?: number;
  maxAgentAppearances?: number;
  maxDelegationDepth?: number;
  journal?: Journal;
}): Promise<LoopPass> {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const journal = options.journal ?? new Journal();
  const { registry } = agentsWithHandoffs();
  const thread = await store.createThread({ actor, persona: 'default' });
  const delegatedTo: string[] = [];
  const deps: AgentLoopDeps = {
    model: new FakeModelProvider(alwaysHandsOff),
    store,
    registry,
    rolesPolicy: new DefaultRolesPolicy(),
    day: '2026-09-11',
    systemPrompt: 'You are alpha.',
    ...(options.maxAgentAppearances !== undefined
      ? { maxAgentAppearances: options.maxAgentAppearances }
      : {}),
    ...(options.maxDelegationDepth !== undefined
      ? { maxDelegationDepth: options.maxDelegationDepth }
      : {}),
  };
  const hooks: AgentLoopHooks = {
    runId: 'run-1',
    openSink: () => sink.open('run-1'),
    awaitApproval: async () => ({ approved: true }),
    step: (name, fn) => journal.at(name, () => fn()),
    patched: (id) => journal.patched(id),
    runAgent: async (agentName) => {
      delegatedTo.push(agentName);
      return { text: `${agentName} answered` };
    },
  };
  journal.rewind();
  await runAgentLoop(
    deps,
    {
      threadId: thread.id,
      actor,
      userText: 'go',
      agentName: 'alpha',
      ...(options.delegationPath !== undefined ? { delegationPath: options.delegationPath } : {}),
      ...(options.delegationDepth !== undefined
        ? { delegationDepth: options.delegationDepth }
        : {}),
    },
    hooks,
  );
  const detail = await store.getThread(thread.id);
  const results = (detail?.messages ?? []).flatMap((message) => message.toolResults ?? []);
  return { results, delegatedTo, journalNames: journal.names() };
}

describe('a delegation cycle is refused as a cycle', () => {
  it('lets a first delegation through', async () => {
    const pass = await oneTurn({ delegationPath: [] });

    expect(pass.delegatedTo).toEqual(['beta']);
    expect(pass.results[0]?.error).toBeUndefined();
  });

  it('names the whole chain, including this run’s own agent, and the count', async () => {
    const pass = await oneTurn({ delegationPath: ['beta'] });

    expect(pass.delegatedTo).toEqual([]);
    // `beta → alpha` is the chain that reached here; `→ beta` is the hop that closes it. Reading the
    // ancestry alone would name `beta → beta`, an edge no deployment declares.
    expect(pass.results[0]?.error).toBe(
      'delegation cycle: beta → alpha → beta — beta 2 times on one chain',
    );
  });

  it('admits exactly one deliberate return at two appearances', async () => {
    const once = await oneTurn({ delegationPath: ['beta'], maxAgentAppearances: 2 });
    expect(once.delegatedTo).toEqual(['beta']);

    const twice = await oneTurn({
      delegationPath: ['beta', 'alpha', 'beta'],
      maxAgentAppearances: 2,
    });
    expect(twice.results[0]?.error).toBe(
      'delegation cycle: beta → alpha → beta → alpha → beta — beta 3 times on one chain',
    );
  });

  it('reports depth only when nothing on the chain is circular', async () => {
    // Six DISTINCT agents with `alpha` on the end: long, but going nowhere twice. A count alone
    // refuses exactly this for resembling a cycle it is not.
    const distinct = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const long = await oneTurn({ delegationPath: distinct, delegationDepth: distinct.length });
    expect(long.results[0]?.error).toBe('delegation depth limit of 5 reached');

    // And the same chain under a raised ceiling delegates, because nothing about it repeats.
    const raised = await oneTurn({
      delegationPath: distinct,
      delegationDepth: distinct.length,
      maxDelegationDepth: 8,
    });
    expect(raised.delegatedTo).toEqual(['beta']);
  });

  it('names the cycle rather than the depth when a chain is both', async () => {
    const circular = ['beta', 'alpha', 'beta', 'alpha'];
    const pass = await oneTurn({
      delegationPath: circular,
      delegationDepth: circular.length,
    });

    // Both guards would fire; the cycle is the one that points at the wiring.
    expect(pass.results[0]?.error).toContain('delegation cycle:');
  });

  it('falls back to depth alone for a runner that threads no chain', async () => {
    const pass = await oneTurn({ delegationDepth: 5 });

    expect(pass.results[0]?.error).toBe('delegation depth limit of 5 reached');
  });

  it('settles the refusal inside the call’s own checkpoint, adding no position', async () => {
    const journal = new Journal();
    await oneTurn({ delegationPath: ['beta'], journal });
    const refused = journal.names();

    // A replay reads the verdict back out of `persist:toolcall`; nothing re-derives it, so the same
    // history replays to the same refusal with the same sequence.
    const replay = await oneTurn({ delegationPath: ['beta'], journal });
    expect(replay.journalNames).toEqual(refused);
    expect(refused.filter((name) => name.startsWith('persist:toolcall:'))).toHaveLength(1);
    expect(refused.some((name) => name.startsWith('persist:toolexec:'))).toBe(false);
  });
});

/**
 * The threading is the part that can be dead without failing anything: the guard reads
 * `input.delegationPath`, and a runner that never fills it hands every chain an empty ancestry. So
 * this runs a real mutual handoff and counts the agent turns it took to stop.
 */
describe('a real mutual handoff stops at the cycle, not at the depth', () => {
  let db: Database;

  beforeEach(async () => {
    db = await makeStoreDb();
  });

  afterEach(async () => {
    await db?.manager.closeAll();
  });

  it('costs two agent turns and names both agents', async () => {
    const store = new LucidAgentStore(asStoreDb(db));
    const { registry, agents } = agentsWithHandoffs();
    const factory = new AgentDepsFactory({
      model: new FakeModelProvider(alwaysHandsOff),
      store,
      sink: new InProcessTokenStreamSink(),
      rolesPolicy: new DefaultToolAuthorizer(),
      registry,
      agents,
    });
    const runner = new InlineAgentRunner(factory, store);
    const thread = await store.createThread({ actor, persona: 'default' });

    await runner.start({ threadId: thread.id, actor, userText: 'go', agentName: 'alpha' });

    const queries = new LucidGovernanceQueries(asStoreDb(db));
    // alpha's own turn, and beta's — then beta's delegation back to alpha is refused, so there is no
    // third. Under a depth ceiling alone this chain burns five agent turns first.
    await waitFor(async () => {
      const runs = (await queries.listRuns({})).items;
      return runs.length >= 2 && runs.every((run) => run.status !== 'running');
    });
    const runs = (await queries.listRuns({})).items;
    expect(runs.map((run) => run.agentName).sort()).toEqual(['alpha', 'beta']);

    // beta's own (transient) subthread holds the refusal, naming the chain that produced it.
    const betaThreadId = runs.find((run) => run.agentName === 'beta')?.threadId ?? '';
    const betaThread = await store.getThread(betaThreadId);
    const refusals = (betaThread?.messages ?? [])
      .flatMap((message) => message.toolResults ?? [])
      .map((result) => result.error)
      .filter((error): error is string => error !== undefined);
    expect(refusals).toEqual([
      'delegation cycle: alpha → beta → alpha — alpha 2 times on one chain',
    ]);
  });
});

/**
 * The ceilings are authored per agent and read by the loop off `AgentDeps`, copied across by one
 * hand-written spread per field — which is how a declared option ends up never being read.
 */
describe('an agent’s own ceilings reach the turn that enforces them', () => {
  it('carries both off the definition, and neither where none is declared', async () => {
    const { registry, agents } = agentsWithHandoffs();
    agents.register({
      name: 'supervisor',
      systemPrompt: 'You supervise.',
      maxDelegationDepth: 9,
      maxAgentAppearances: 3,
    });
    const factory = new AgentDepsFactory({
      model: new FakeModelProvider(alwaysHandsOff),
      store: new InMemoryAgentStore(),
      sink: new InMemoryTokenStreamSink(),
      rolesPolicy: new DefaultRolesPolicy(),
      registry,
      agents,
    });

    expect(factory.forAgent('supervisor')).toMatchObject({
      maxDelegationDepth: 9,
      maxAgentAppearances: 3,
    });
    const plain = factory.forAgent('alpha');
    expect(plain.maxDelegationDepth).toBeUndefined();
    expect(plain.maxAgentAppearances).toBeUndefined();
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => Promise<boolean>, tries = 300): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error('waitFor: condition never became true');
}
