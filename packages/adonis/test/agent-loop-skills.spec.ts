import { describe, expect, it } from 'vitest';
import type {
  AgentLoopDeps,
  AgentLoopHooks,
  ModelMessage,
  ModelProvider,
  ModelTurnArgs,
  ModelTurnResult,
  SkillProvider,
  SkillsConfig,
} from '../src/index.js';
import { DefaultRolesPolicy, GLOBAL_SCOPE, runAgentLoop, ToolRegistry } from '../src/index.js';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '../src/testing/index.js';
import { Journal } from './helpers/journal.js';

const RUN_ID = 'run-1';
const ACTOR = { id: 'u1', roles: ['ADMIN'] };

/** Asks for the named skill on its first turn, then answers. What a model does with a catalog. */
class SkillCallingModel implements ModelProvider {
  readonly systems: string[] = [];
  readonly transcripts: ModelMessage[][] = [];
  /** Turn index to fail at, standing in for whatever unwinds a run mid-turn. */
  failAt?: number;

  constructor(private readonly asksFor: string | undefined) {}

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    if (this.failAt === args.messages.filter((message) => message.role === 'assistant').length) {
      throw new Error('the run came apart here');
    }
    this.systems.push(args.system);
    this.transcripts.push(args.messages.map((message) => ({ ...message })));
    // Read off the TRANSCRIPT, not off a counter of its own: a resumed pass replays the earlier
    // turns from the journal without calling this model, so a counter would restart mid-run.
    const first = args.messages.every((message) => message.role !== 'assistant');
    const text = first ? 'let me read up' : 'done';
    await args.sink.write({ t: 'text', v: text });
    return {
      text,
      toolCalls:
        first && this.asksFor !== undefined
          ? [{ id: 'call-skill', name: 'skill', input: { name: this.asksFor } }]
          : [],
      usage: { inputTokens: args.messages.length, outputTokens: text.length },
    };
  }
}

interface PassOptions {
  model: ModelProvider;
  skills?: SkillsConfig;
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
    ...(options.skills !== undefined ? { skills: options.skills } : {}),
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
  return { store, detail: await store.getThread(thread.id) };
}

function providerOf(bodies: Record<string, string>): SkillProvider {
  return {
    list: () =>
      Object.keys(bodies).map((name) => ({
        name,
        description: `does ${name}`,
        scope: GLOBAL_SCOPE,
      })),
    load: ({ name }) => bodies[name] ?? null,
  };
}

describe('a turn’s skills catalog', () => {
  it('puts one line per skill in the system prompt and no body anywhere near it', async () => {
    const model = new SkillCallingModel(undefined);
    await pass({
      model,
      skills: { provider: providerOf({ triage: 'STEP ONE: read the queue.' }) },
    });
    expect(model.systems[0]).toContain('- triage [global] — does triage');
    expect(model.systems[0]).not.toContain('STEP ONE');
  });

  it('writes no block at all when the actor’s scopes yield nothing', async () => {
    const model = new SkillCallingModel(undefined);
    await pass({ model, skills: { provider: providerOf({}) } });
    expect(model.systems[0]).not.toContain('<skills>');
  });

  it('offers the `skill` tool only where skills are configured', async () => {
    const withSkills = new SkillCallingModel(undefined);
    await pass({ model: withSkills, skills: { provider: providerOf({ triage: 'body' }) } });
    const without = new SkillCallingModel(undefined);
    await pass({ model: without });
    expect(withSkills.systems[0]).toContain('<skills>');
    expect(without.systems[0]).not.toContain('<skills>');
  });

  it('spends no checkpoint at all when no skills are configured', async () => {
    const journal = new Journal();
    await pass({ model: new SkillCallingModel(undefined), journal });
    expect(journal.names().some((name) => name.startsWith('skills:'))).toBe(false);
  });
});

describe('loading a skill mid-turn', () => {
  it('hands the body back as an ordinary tool result, on the transcript', async () => {
    const model = new SkillCallingModel('triage');
    const { store } = await pass({
      model,
      skills: { provider: providerOf({ triage: 'STEP ONE: read the queue.' }) },
    });

    // The body rides the TRANSCRIPT, where the history window governs it — never the system block.
    expect(JSON.stringify(model.transcripts[1])).toContain('STEP ONE: read the queue.');
    expect(model.systems[1]).not.toContain('STEP ONE');
    // And it settles as a plain executed read, so a governance surface needs no new vocabulary.
    const row = store.governanceToolCalls().find((call) => call.toolName === 'skill');
    expect(row).toMatchObject({ toolType: 'read', status: 'executed' });
  });

  it('spends a read’s checkpoints exactly, so the shape of a turn does not depend on the kind', async () => {
    const journal = new Journal();
    await pass({
      model: new SkillCallingModel('triage'),
      skills: { provider: providerOf({ triage: 'body' }) },
      journal,
    });
    expect(journal.toolNames().slice(0, 3)).toEqual([
      'persist:toolcall:call-skill',
      'tool:call-skill',
      'persist:toolexec:call-skill',
    ]);
  });

  it('refuses a name the turn was never offered, as a tool failure the model can act on', async () => {
    const model = new SkillCallingModel('someone-elses-skill');
    const { store } = await pass({
      model,
      skills: { provider: providerOf({ triage: 'body' }) },
    });
    const row = store.governanceToolCalls().find((call) => call.toolName === 'skill');
    expect(row).toMatchObject({ status: 'failed' });
    expect(String(row?.error)).toContain('Available: triage.');
  });
});

describe('a resumed run reads its skills back out of the journal', () => {
  it('keeps the scopes the first attempt resolved, not the ones a resolver would give now', async () => {
    const journal = new Journal();
    // A resolver whose answer moves between attempts — a membership table someone edited in between.
    let resolutions = 0;
    const scopes = {
      resolve: () => {
        resolutions += 1;
        return resolutions === 1 ? [GLOBAL_SCOPE] : ['tenant:base-7'];
      },
    };
    const provider: SkillProvider = {
      list: ({ scopes: asked }) =>
        asked.map((scope) => ({ name: `triage-${scope}`, description: 'sort a queue', scope })),
      load: () => 'body',
    };

    // The first attempt resolves the catalog, then comes apart before the model call it feeds.
    const first = new SkillCallingModel(undefined);
    first.failAt = 0;
    await expect(pass({ model: first, skills: { provider, scopes }, journal })).rejects.toThrow(
      /came apart/,
    );

    const second = new SkillCallingModel(undefined);
    await pass({ model: second, skills: { provider, scopes }, journal });

    expect(resolutions).toBe(1);
    expect(second.systems[0]).toContain('- triage-global [global]');
    expect(second.systems[0]).not.toContain('tenant:base-7');
  });

  it('keeps the body the first attempt loaded, not the one the provider holds now', async () => {
    const journal = new Journal();
    const bodies = { triage: 'STEP ONE: read the queue.' };
    const provider: SkillProvider = {
      list: () => [{ name: 'triage', description: 'does triage', scope: GLOBAL_SCOPE }],
      load: () => bodies.triage,
    };

    // The first attempt loads the body, then comes apart before the model call it feeds.
    const first = new SkillCallingModel('triage');
    first.failAt = 1;
    await expect(pass({ model: first, skills: { provider }, journal })).rejects.toThrow(
      /came apart/,
    );

    // Someone rewrites the procedure between the unwind and the resume.
    bodies.triage = 'STEP ONE: do the opposite.';
    const second = new SkillCallingModel('triage');
    await pass({ model: second, skills: { provider }, journal });

    const resumed = JSON.stringify(second.transcripts.at(-1));
    expect(resumed).toContain('STEP ONE: read the queue.');
    expect(resumed).not.toContain('do the opposite');
  });
});
