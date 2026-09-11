import { describe, expect, it } from 'vitest';
import type {
  AgentLoopDeps,
  AgentLoopHooks,
  MemoryConfig,
  MemoryProvider,
  MemoryRecord,
  ModelMessage,
  ModelProvider,
  ModelTurnArgs,
  ModelTurnResult,
  StoreMemoryInput,
} from '../src/index.js';
import { DefaultRolesPolicy, GLOBAL_SCOPE, runAgentLoop, ToolRegistry } from '../src/index.js';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '../src/testing/index.js';
import { Journal } from './helpers/journal.js';

const RUN_ID = 'run-1';
const ACTOR = { id: 'u1', roles: ['ADMIN'] };

function record(key: string, scope: string, text: string, author: 'agent' | 'human'): MemoryRecord {
  return {
    id: `${scope}/${key}`,
    key,
    text,
    scope,
    origin: { author, threadId: 't0', runId: 'r0', actorRef: 'u1' },
    updatedAt: '2026-09-10T00:00:00.000Z',
  };
}

/** Calls `remember` on its first turn when told to, then answers. */
class RememberingModel implements ModelProvider {
  readonly systems: string[] = [];
  readonly transcripts: ModelMessage[][] = [];
  readonly offered: string[][] = [];
  failAt?: number;

  constructor(private readonly writes?: { key: string; fact: string }) {}

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const answered = args.messages.filter((message) => message.role === 'assistant').length;
    if (this.failAt === answered) {
      throw new Error('the run came apart here');
    }
    this.systems.push(args.system);
    this.offered.push(args.tools.map((tool) => tool.name));
    this.transcripts.push(args.messages.map((message) => ({ ...message })));
    const first = answered === 0;
    const text = first ? 'noting that' : 'done';
    await args.sink.write({ t: 'text', v: text });
    return {
      text,
      toolCalls:
        first && this.writes !== undefined
          ? [{ id: 'call-remember', name: 'remember', input: this.writes }]
          : [],
      usage: { inputTokens: args.messages.length, outputTokens: text.length },
    };
  }
}

interface PassOptions {
  model: ModelProvider;
  memory?: MemoryConfig;
  journal?: Journal;
}

async function pass(options: PassOptions) {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
  const deps: AgentLoopDeps = {
    model: options.model,
    store,
    registry: new ToolRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'You are a test agent.',
    ...(options.memory !== undefined ? { memory: options.memory } : {}),
  };
  const journal = options.journal;
  const hooks: AgentLoopHooks = {
    runId: RUN_ID,
    openSink: () => sink.open(RUN_ID),
    awaitApproval: async () => ({ approved: true }),
    step: journal === undefined ? (_name, fn) => fn() : (name, fn) => journal.at(name, fn),
    ...(journal === undefined ? {} : { patched: (id) => journal.patched(id) }),
  };
  journal?.rewind();
  await runAgentLoop(deps, { threadId: thread.id, actor: ACTOR, userText: 'hi' }, hooks);
  return { store };
}

/** A provider over a fixed set, recording every write it was asked for. */
function providerOf(
  records: MemoryRecord[],
  options: { writable?: boolean } = {},
): MemoryProvider & { written: StoreMemoryInput[] } {
  const written: StoreMemoryInput[] = [];
  const base: MemoryProvider & { written: StoreMemoryInput[] } = {
    written,
    list: ({ scopes }) => records.filter((entry) => scopes.includes(entry.scope)),
    forget: () => true,
  };
  if (options.writable !== false) {
    base.write = (input) => {
      written.push(input);
      return {
        id: `new/${input.key}`,
        key: input.key,
        text: input.text,
        scope: input.scope,
        origin: input.origin,
        updatedAt: '2026-09-11T00:00:00.000Z',
      };
    };
  }
  return base;
}

describe('a turn’s memory block', () => {
  it('carries one line per memory, framed by who asserted it', async () => {
    const model = new RememberingModel();
    await pass({
      model,
      memory: {
        provider: providerOf([
          record(
            'fiscal-year',
            GLOBAL_SCOPE,
            'the organisation reports on the calendar year',
            'human',
          ),
          record('units', 'actor:u1', 'they prefer nautical miles', 'agent'),
        ]),
      },
    });
    const block = model.systems[0] ?? '';
    expect(block).toContain(
      '- [global] fiscal-year: the organisation reports on the calendar year',
    );
    expect(block).toContain('- [actor:u1] units: they prefer nautical miles');
    // An organisational decision is an instruction; the agent's own inference is a guess.
    expect(block).toContain('Stated by people.');
    expect(block).toContain('Concluded by you.');
  });

  it('writes no block at all when nothing is on file', async () => {
    const model = new RememberingModel();
    await pass({ model, memory: { provider: providerOf([]) } });
    expect(model.systems[0]).not.toContain('<memory>');
  });

  it('spends no checkpoint at all when no memory is configured', async () => {
    const journal = new Journal();
    await pass({ model: new RememberingModel(), journal });
    expect(journal.names().some((name) => name.startsWith('memory:'))).toBe(false);
  });

  it('offers `remember` only where the provider can write, and names it only there', async () => {
    const records = [record('units', 'actor:u1', 'they prefer nautical miles', 'agent')];
    const writable = new RememberingModel();
    await pass({ model: writable, memory: { provider: providerOf(records) } });
    const readOnly = new RememberingModel();
    await pass({
      model: readOnly,
      memory: { provider: providerOf(records, { writable: false }) },
    });

    expect(writable.offered[0]).toEqual(['remember']);
    expect(readOnly.offered[0]).toEqual([]);
    // And the block names the tool only where the deployment has one to name.
    expect(writable.systems[0]).toContain('`remember`');
    expect(readOnly.systems[0]).toContain('<memory>');
    expect(readOnly.systems[0]).not.toContain('`remember`');
  });
});

describe('writing a memory mid-turn', () => {
  it('stores at the actor’s OWN scope, with this run recorded as the origin', async () => {
    const provider = providerOf([]);
    const { store } = await pass({
      model: new RememberingModel({ key: 'units', fact: 'they prefer nautical miles' }),
      memory: { provider },
    });
    expect(provider.written).toHaveLength(1);
    expect(provider.written[0]).toMatchObject({
      key: 'units',
      text: 'they prefer nautical miles',
      // The model never named a scope — `remember` has no such parameter.
      scope: 'actor:u1',
      origin: { author: 'agent', runId: RUN_ID, actorRef: 'u1' },
    });
    const row = store.governanceToolCalls().find((call) => call.toolName === 'remember');
    expect(row).toMatchObject({ toolType: 'read', status: 'executed' });
  });

  it('spends a read’s checkpoints exactly, so the shape of a turn does not depend on the kind', async () => {
    const journal = new Journal();
    await pass({
      model: new RememberingModel({ key: 'units', fact: 'nautical miles' }),
      memory: { provider: providerOf([]) },
      journal,
    });
    expect(journal.toolNames().slice(0, 3)).toEqual([
      'persist:toolcall:call-remember',
      'tool:call-remember',
      'persist:toolexec:call-remember',
    ]);
  });

  it('hands a fact over the deployment’s ceiling back as a tool failure the model can fix', async () => {
    const { store } = await pass({
      model: new RememberingModel({ key: 'units', fact: 'x'.repeat(50) }),
      memory: { provider: providerOf([]), maxFactChars: 20 },
    });
    const row = store.governanceToolCalls().find((call) => call.toolName === 'remember');
    expect(row).toMatchObject({ status: 'failed' });
    expect(String(row?.error)).toContain('at most 20 characters');
  });
});

describe('a resumed run reads its memory back out of the journal', () => {
  it('keeps the selection the first attempt made, not the one an index would give now', async () => {
    const journal = new Journal();
    const everything = [
      record('units', 'actor:u1', 'nautical miles', 'agent'),
      record('fiscal-year', GLOBAL_SCOPE, 'the calendar year', 'human'),
    ];
    // An index that moves between attempts — a neighbour written, embeddings recomputed.
    let searches = 0;
    const provider: MemoryProvider = {
      list: () => everything,
      forget: () => true,
      search: ({ scopes }) => {
        searches += 1;
        const ranked = searches === 1 ? everything : [...everything].reverse();
        return ranked.filter((entry) => scopes.includes(entry.scope)).slice(0, 1);
      },
    };

    const first = new RememberingModel();
    first.failAt = 0;
    await expect(pass({ model: first, memory: { provider }, journal })).rejects.toThrow(
      /came apart/,
    );
    const second = new RememberingModel();
    await pass({ model: second, memory: { provider }, journal });

    expect(searches).toBe(1);
    expect(second.systems[0]).toContain('units: nautical miles');
    expect(second.systems[0]).not.toContain('the calendar year');
  });

  it('does not store a second copy of a fact the model only decided once', async () => {
    const journal = new Journal();
    const provider = providerOf([]);
    const writes = { key: 'units', fact: 'nautical miles' };

    // The first attempt writes the fact, then comes apart before the model call it feeds.
    const first = new RememberingModel(writes);
    first.failAt = 1;
    await expect(pass({ model: first, memory: { provider }, journal })).rejects.toThrow(
      /came apart/,
    );
    expect(provider.written).toHaveLength(1);

    await pass({ model: new RememberingModel(writes), memory: { provider }, journal });
    expect(provider.written).toHaveLength(1);
  });
});
