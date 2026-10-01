import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentLoopDeps, AgentLoopHooks, AiToolCtx, Persona } from '../src/index.js';
import {
  DefaultRolesPolicy,
  runAgentLoop,
  ToolForbiddenError,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';
import { Journal } from './helpers/journal.js';

/**
 * Personas in the loop, as `@dudousxd/nestjs-agent` 1.20 has them: a run names its persona by id
 * (`AgentRunInput.persona`), the loop looks the definition up ONCE and freezes it in a
 * `persona:resolve` checkpoint — id, label, allow-list and the resolved prompt — so a parked run
 * resumes on the persona it started with whatever the config says by then. The allow-list narrows
 * the offer AND what may run (`ToolRegistry.invoke`), handoffs included.
 */

const actor = { id: 'u1', roles: ['ADMIN'] };
const RUN_ID = 'run-1';

interface Seen {
  systems: string[];
  offered: string[][];
  ctxPersonas: (string | undefined)[];
  executed: string[];
}

function buildRegistry(seen: Seen): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of ['executeSql', 'renderResult', 'deleteEverything']) {
    registry.register(
      { name, kind: 'read', description: name, inputSchema: z.object({}) },
      {
        execute: async (_input: unknown, ctx: AiToolCtx) => {
          seen.executed.push(name);
          seen.ctxPersonas.push(ctx.persona?.id);
          return { ok: name };
        },
      },
    );
  }
  registry.register(
    {
      name: 'ask_research',
      kind: 'agent',
      description: 'delegate',
      inputSchema: z.object({ task: z.string() }),
      targetAgent: 'research',
    },
    { execute: async () => ({}) },
  );
  return registry;
}

const PERSONAS: Persona[] = [
  { id: 'general', label: 'General' },
  {
    id: 'sql',
    label: 'SQL focused',
    systemPrompt: (ctx) => `${ctx.basePrompt}\nQuery first. (${ctx.persona?.id})`,
  },
  { id: 'flat', label: 'Flat', systemPrompt: 'Flat persona prompt.' },
  { id: 'read-only', label: 'Read only', allowedTools: ['executeSql', 'renderResult'] },
];

interface RunOptions {
  persona?: string | Persona;
  personas?: Persona[];
  script?: FakeScript;
  toolAllowList?: string[];
  journal?: Journal;
  store?: InMemoryAgentStore;
  threadId?: string;
  delegated?: string[];
}

async function run(options: RunOptions = {}) {
  const seen: Seen = { systems: [], offered: [], ctxPersonas: [], executed: [] };
  const store = options.store ?? new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const threadId = options.threadId ?? (await store.createThread({ actor, persona: '' })).id;
  const script = options.script ?? (() => ({ text: 'done' }));
  const deps: AgentLoopDeps = {
    model: new FakeModelProvider((args, turn) => {
      seen.systems.push(args.system);
      seen.offered.push(args.tools.map((tool) => tool.name));
      return script(args, turn);
    }),
    store,
    registry: buildRegistry(seen),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'Base agent prompt.',
    personas: new Map((options.personas ?? PERSONAS).map((persona) => [persona.id, persona])),
    ...(options.toolAllowList !== undefined ? { toolAllowList: options.toolAllowList } : {}),
  };
  const journal = options.journal;
  journal?.rewind();
  const hooks: AgentLoopHooks = {
    runId: RUN_ID,
    openSink: () => sink.open(RUN_ID),
    awaitApproval: async () => ({ approved: true }),
    step: (name, fn) => (journal === undefined ? fn() : journal.at(name, fn)),
    ...(journal !== undefined ? { patched: (id: string) => journal.patched(id) } : {}),
    runAgent: async (agentName) => {
      options.delegated?.push(agentName);
      return { text: 'delegate answer' };
    },
  };
  const result = await runAgentLoop(
    deps,
    {
      threadId,
      actor,
      userText: 'hi',
      ...(options.persona !== undefined ? { persona: options.persona } : {}),
    } as never,
    hooks,
  );
  const detail = await store.getThread(threadId);
  return { result, seen, detail, store, threadId };
}

describe('agent loop — personas (the prompt)', () => {
  it('lets a persona PromptBuilder wrap the agent base prompt, and shows it the persona', async () => {
    const { seen } = await run({ persona: 'sql' });
    expect(seen.systems[0]).toBe('Base agent prompt.\nQuery first. (sql)');
  });

  it('a flat persona prompt stands in for the base prompt', async () => {
    const { seen } = await run({ persona: 'flat' });
    expect(seen.systems[0]).toBe('Flat persona prompt.');
  });

  it('a persona without a prompt keeps the base prompt', async () => {
    const { seen } = await run({ persona: 'general' });
    expect(seen.systems[0]).toBe('Base agent prompt.');
  });

  it('the base prompt builder can branch on the persona itself', async () => {
    const seen: string[] = [];
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor, persona: '' });
    await runAgentLoop(
      {
        model: new FakeModelProvider((args) => {
          seen.push(args.system);
          return { text: 'ok' };
        }),
        store,
        registry: new ToolRegistry(),
        rolesPolicy: new DefaultRolesPolicy(),
        day: '2026-06-30',
        systemPrompt: (ctx) => `base for ${ctx.persona?.label ?? 'nobody'}`,
        personas: new Map([['general', { id: 'general', label: 'General' }]]),
      },
      { threadId: thread.id, actor, userText: 'hi', persona: 'general' },
      {
        runId: RUN_ID,
        openSink: () => new InMemoryTokenStreamSink().open(RUN_ID),
        awaitApproval: async () => ({ approved: true }),
        step: (_name, fn) => fn(),
      },
    );
    expect(seen).toEqual(['base for General']);
  });

  it('runs on the base prompt alone when the turn names no persona', async () => {
    const { seen } = await run();
    expect(seen.systems[0]).toBe('Base agent prompt.');
  });
});

describe('agent loop — personas (the tool allow-list)', () => {
  it('offers only the persona allow-list, after the agent allow-list', async () => {
    const { seen } = await run({
      persona: 'read-only',
      toolAllowList: ['executeSql', 'deleteEverything'],
    });
    expect(seen.offered[0]).toEqual(['executeSql']);
  });

  it('a persona with no allow-list leaves the agent offer as it was', async () => {
    const { seen } = await run({ persona: 'general' });
    expect(seen.offered[0]).toEqual([
      'executeSql',
      'renderResult',
      'deleteEverything',
      'ask_research',
    ]);
  });

  it('refuses a call to a tool the persona was not offered, even when the model names it', async () => {
    const { seen, detail } = await run({
      persona: 'read-only',
      script: (_args, turn) =>
        turn === 0
          ? { text: 'deleting', toolCall: { name: 'deleteEverything', input: {} } }
          : { text: 'done' },
    });
    expect(seen.executed).toEqual([]);
    const results = detail?.messages.flatMap((message) => message.toolResults ?? []) ?? [];
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0])).toMatch(/forbidden|not allowed|deleteEverything/i);
  });

  it('still runs a tool on the persona list, and hands it the persona it runs under', async () => {
    const { seen } = await run({
      persona: 'read-only',
      script: (_args, turn) =>
        turn === 0
          ? { text: 'querying', toolCall: { name: 'executeSql', input: {} } }
          : { text: 'done' },
    });
    expect(seen.executed).toEqual(['executeSql']);
    expect(seen.ctxPersonas).toEqual(['read-only']);
  });
});

describe('ToolRegistry.invoke — the allow-list it is handed', () => {
  it('refuses a tool off the list, after the other gates, and runs one on it', async () => {
    const seen: Seen = { systems: [], offered: [], ctxPersonas: [], executed: [] };
    const registry = buildRegistry(seen);
    const ctx = { actor, threadId: 't', requestId: 'r' } as unknown as AiToolCtx;
    await expect(
      registry.invoke('deleteEverything', {}, ctx, new DefaultRolesPolicy(), {
        allowedTools: ['executeSql'],
      }),
    ).rejects.toBeInstanceOf(ToolForbiddenError);
    await expect(
      registry.invoke('executeSql', {}, ctx, new DefaultRolesPolicy(), {
        allowedTools: ['executeSql'],
      }),
    ).resolves.toEqual({ ok: 'executeSql' });
    // No list → no such check (every caller predating personas).
    await expect(
      registry.invoke('deleteEverything', {}, ctx, new DefaultRolesPolicy()),
    ).resolves.toEqual({ ok: 'deleteEverything' });
  });
});

describe('agent loop — personas (delegation)', () => {
  it('refuses a handoff the persona was not offered, without starting the delegate', async () => {
    const delegated: string[] = [];
    const { detail } = await run({
      persona: 'read-only',
      delegated,
      script: (_args, turn) =>
        turn === 0
          ? { text: 'asking', toolCall: { name: 'ask_research', input: { task: 'dig' } } }
          : { text: 'done' },
    });
    expect(delegated).toEqual([]);
    const results = detail?.messages.flatMap((message) => message.toolResults ?? []) ?? [];
    expect(JSON.stringify(results)).toMatch(/ask_research/);
  });
});

describe('agent loop — personas (provenance)', () => {
  it('records the persona on every message the turn writes', async () => {
    const { detail } = await run({
      persona: 'read-only',
      script: (_args, turn) =>
        turn === 0
          ? { text: 'querying', toolCall: { name: 'executeSql', input: {} } }
          : { text: 'done' },
    });
    const messages = detail?.messages ?? [];
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(messages.map((message) => message.persona)).toEqual(messages.map(() => 'read-only'));
  });

  it('records no persona on a turn that has none', async () => {
    const { detail } = await run();
    expect(detail?.messages.map((message) => message.persona)).toEqual([undefined, undefined]);
  });

  it('runs without a persona when the one the turn names is no longer declared', async () => {
    const { seen, detail } = await run({ persona: 'ghost' });
    expect(seen.systems[0]).toBe('Base agent prompt.');
    expect(detail?.messages.map((message) => message.persona)).toEqual([undefined, undefined]);
  });
});

describe('agent loop — personas under replay', () => {
  it('journals the persona the turn resolved, ahead of every other checkpoint', async () => {
    const journal = new Journal();
    await run({ persona: 'sql', journal });
    expect(journal.names()[0]).toBe('persona:resolve');
    expect(JSON.parse(journal.recorded('persona:resolve'))).toEqual({
      id: 'sql',
      label: 'SQL focused',
      prompt: 'Base agent prompt.\nQuery first. (sql)',
    });
  });

  it('spends no checkpoint on a turn without a persona — the sequence a run before personas had', async () => {
    const journal = new Journal();
    await run({ journal });
    expect(journal.names()).not.toContain('persona:resolve');
    expect(journal.names()[0]).toBe('persist:run:start');
  });

  it('spends no checkpoint on a persona handed over whole (what releases before 0.60 recorded)', async () => {
    const journal = new Journal();
    const { seen, detail } = await run({
      journal,
      persona: { id: 'legacy', label: 'Legacy', systemPrompt: 'Legacy prompt.' },
    });
    expect(journal.names()).not.toContain('persona:resolve');
    expect(seen.systems[0]).toBe('Legacy prompt.');
    expect(detail?.messages[0]?.persona).toBe('legacy');
  });

  /** Park on an action tool so the second pass is a resume, then replay it under other config. */
  async function parkedThenResumed(second: Persona[]) {
    const journal = new Journal();
    const store = new InMemoryAgentStore();
    const threadId = (await store.createThread({ actor, persona: '' })).id;
    const script: FakeScript = (_args, turn) =>
      turn === 0
        ? { text: 'querying', toolCall: { name: 'executeSql', input: {} } }
        : { text: 'done' };
    const first = await run({
      persona: 'sql-ro',
      personas: [SQL_RO],
      journal,
      store,
      threadId,
      script,
    });
    const recorded = journal.names();
    // Resume — the same history, replayed by a process whose config says something else.
    const again = await run({
      persona: 'sql-ro',
      personas: second,
      journal,
      store,
      threadId,
      script,
    });
    return { first, again, recorded, journal };
  }

  const SQL_RO: Persona = {
    id: 'sql-ro',
    label: 'SQL',
    systemPrompt: 'SQL prompt v1.',
    allowedTools: ['executeSql'],
  };

  it('replays on the persona it recorded after the persona’s config changed under it', async () => {
    const { again, recorded, journal } = await parkedThenResumed([
      { ...SQL_RO, systemPrompt: 'SQL prompt v2.', allowedTools: ['renderResult'] },
    ]);
    expect(journal.names()).toEqual(recorded);
    // Nothing re-ran: every model call and the tool were read back from the journal.
    expect(again.seen.systems).toEqual([]);
    expect(again.seen.executed).toEqual([]);
  });

  it('a run that reaches new steps after the config changed keeps its recorded prompt and offer', async () => {
    const journal = new Journal();
    const store = new InMemoryAgentStore();
    const threadId = (await store.createThread({ actor, persona: '' })).id;
    const script: FakeScript = (_args, turn) =>
      turn === 0
        ? { text: 'querying', toolCall: { name: 'executeSql', input: {} } }
        : { text: 'done' };
    await run({ persona: 'sql-ro', personas: [SQL_RO], journal, store, threadId, script });
    // Trim the history back to just after `persona:resolve` and the first model call — a run
    // parked there — then resume it under a rewritten persona, and under one that is gone.
    const keep = journal.names().indexOf('llm:0') + 1;
    for (const personas of [
      [{ ...SQL_RO, systemPrompt: 'SQL prompt v2.', allowedTools: ['renderResult'] }],
      [] as Persona[],
    ]) {
      while (journal.names().length > keep) journal.dropAt(journal.names().length - 1);
      const again = await run({ persona: 'sql-ro', personas, journal, store, threadId, script });
      expect(again.seen.systems).toEqual(['SQL prompt v1.']);
      expect(again.seen.offered).toEqual([['executeSql']]);
      expect(again.seen.executed).toEqual(['executeSql']);
      expect(again.seen.ctxPersonas).toEqual(['sql-ro']);
    }
  });

  it('replays on the persona it recorded after the persona was removed', async () => {
    const { again, recorded, journal } = await parkedThenResumed([]);
    expect(journal.names()).toEqual(recorded);
    expect(again.seen.executed).toEqual([]);
  });
});
