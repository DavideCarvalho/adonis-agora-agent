import { InMemoryStateStore, WorkflowEngine } from '@adonis-agora/durable';
import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DurableAgentRunner,
  registerAgentWorkflow,
  setDurableAgentContext,
} from '../src/durable/index.js';
import {
  type Actor,
  type AgentDefinition,
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  ASK_TOOL_NAME,
  DefaultToolAuthorizer,
  type ElicitationQuestion,
  InlineAgentRunner,
  type LucidDatabaseLike,
  LucidTokenStreamSink,
  type StreamFrame,
  type TokenStreamSink,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';
import { makeMemoryDb } from './helpers/make-db.js';

/**
 * `ask` / `intake` declared on an agent's DEFINITION (what `config/agent.ts` holds) reach the loop —
 * and, under the durable runner with the Lucid sink, a run parked on the question is watched and
 * answered through objects that share nothing with the one running it but the database and the
 * engine's store. That is the several-replicas-without-Redis deployment.
 */
const actor: Actor = { id: 'u1', roles: ['ADMIN'] };

const SCOPE: ElicitationQuestion = {
  id: 'scope',
  prompt: 'How wide should I go?',
  options: [
    { value: 'narrow', label: 'This module only' },
    { value: 'everything', label: 'The whole repo' },
  ],
  defaults: ['narrow'],
};

/** Asks once, then answers with what the human picked (read back off the tool result). */
function askingScript(offered: string[][]): FakeScript {
  return (args, turnIndex) => {
    offered.push(args.tools.map((tool) => tool.name));
    return turnIndex === 0
      ? {
          text: 'one question first',
          toolCall: { name: ASK_TOOL_NAME, input: { questions: [SCOPE] } },
        }
      : { text: `going ${JSON.stringify(args.messages.at(-1)?.toolResults ?? [])}` };
  };
}

function factoryFor(
  definition: Omit<AgentDefinition, 'name'>,
  script: FakeScript,
  sink: TokenStreamSink,
  store: InMemoryAgentStore,
): AgentDepsFactory {
  const agents = new AgentRegistry();
  agents.register({ name: 'default', ...definition });
  return new AgentDepsFactory({
    model: new FakeModelProvider(script),
    store,
    sink,
    rolesPolicy: new DefaultToolAuthorizer(),
    registry: new ToolRegistry(),
    agents,
  });
}

/** Follow `runId` on `sink`; settle the first question set seen with `answer`, and return every frame. */
async function followAndAnswer(
  sink: TokenStreamSink,
  runId: string,
  answer: (parked: { runId: string; toolCallId: string }) => Promise<void>,
): Promise<StreamFrame[]> {
  const frames: StreamFrame[] = [];
  for await (const frame of sink.subscribe(runId)) {
    frames.push(frame);
    if (frame.t === 'elicitation') {
      await answer({ runId: frame.runId, toolCallId: frame.id });
    }
  }
  return frames;
}

const textOf = (frames: StreamFrame[]) =>
  frames.map((frame) => (frame.t === 'text' ? frame.v : '')).join('');

describe('ask / intake on the agent definition', () => {
  it('reach the loop deps only for the agent that declares them', () => {
    const agents = new AgentRegistry();
    agents.register({ name: 'default' });
    agents.register({ name: 'scoper', ask: true, intake: { questions: [SCOPE] } });
    const factory = new AgentDepsFactory({
      model: new FakeModelProvider(() => ({ text: 'ok' })),
      store: new InMemoryAgentStore(),
      sink: new InMemoryTokenStreamSink(),
      rolesPolicy: new DefaultToolAuthorizer(),
      registry: new ToolRegistry(),
      agents,
    });
    expect(factory.forAgent('scoper')).toMatchObject({
      ask: true,
      intake: { questions: [SCOPE] },
    });
    expect(factory.forAgent()).not.toHaveProperty('ask');
    expect(factory.forAgent()).not.toHaveProperty('intake');
  });

  it('offers the ask tool, parks the run and resumes it on the answer (inline runner)', async () => {
    const offered: string[][] = [];
    const store = new InMemoryAgentStore();
    const sink = new InMemoryTokenStreamSink();
    const factory = factoryFor({ ask: true }, askingScript(offered), sink, store);
    const service = new AgentService(new InlineAgentRunner(factory, store), store, factory);

    const { runId } = await service.chat({ actor, message: 'tidy up' });
    const frames = await followAndAnswer(sink, runId, (parked) =>
      service.answer({ ...parked, answers: { scope: ['everything'] } }),
    );

    expect(offered[0]).toContain(ASK_TOOL_NAME);
    expect(frames.some((frame) => frame.t === 'elicitation')).toBe(true);
    expect(textOf(frames)).toContain('everything');
  });

  it('asks an authored intake before the first model call', async () => {
    const offered: string[][] = [];
    const store = new InMemoryAgentStore();
    const sink = new InMemoryTokenStreamSink();
    const factory = factoryFor(
      { intake: { questions: [SCOPE] } },
      (args) => {
        offered.push(args.tools.map((tool) => tool.name));
        return { text: 'done' };
      },
      sink,
      store,
    );
    const service = new AgentService(new InlineAgentRunner(factory, store), store, factory);

    const { runId } = await service.chat({ actor, message: 'tidy up' });
    let modelCallsWhenAsked = -1;
    const frames = await followAndAnswer(sink, runId, async (parked) => {
      modelCallsWhenAsked = offered.length;
      await service.answer({ ...parked, answers: { scope: ['narrow'] } });
    });

    expect(modelCallsWhenAsked).toBe(0);
    expect(offered[0]).not.toContain(ASK_TOOL_NAME); // intake alone does not offer the tool
    expect(textOf(frames)).toContain('done');
  });
});

describe('a durable run parked on ask, watched and answered from another replica', () => {
  let db: Database | undefined;

  afterEach(async () => {
    setDurableAgentContext(undefined);
    await db?.manager.closeAll();
    db = undefined;
  });

  it('streams through a second Lucid sink instance and resumes on a signal sent through a second runner', async () => {
    db = makeMemoryDb();
    const lucid = (options = {}) =>
      new LucidTokenStreamSink(db as unknown as LucidDatabaseLike, {
        pollIntervalMs: 5,
        flushMs: 10,
        autoPurge: false,
        ...options,
      });
    const offered: string[][] = [];
    const store = new InMemoryAgentStore();

    // Replica A: runs the turn, writes the frames.
    const factory = factoryFor({ ask: true }, askingScript(offered), lucid(), store);
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    setDurableAgentContext({ factory, store });
    registerAgentWorkflow(engine);
    const service = new AgentService(new DurableAgentRunner(engine), store, factory);

    // Replica B: holds the browser's SSE and takes the answer. Its own sink, its own runner — what
    // it shares with A is the frame table and the engine's state.
    const otherSink = lucid();
    const otherFactory = factoryFor({ ask: true }, askingScript([]), otherSink, store);
    const otherService = new AgentService(new DurableAgentRunner(engine), store, otherFactory);

    const { runId } = await service.chat({ actor, message: 'tidy up' });
    const frames = await followAndAnswer(otherSink, runId, (parked) =>
      otherService.answer({ ...parked, answers: { scope: ['everything'] } }),
    );

    expect(offered[0]).toContain(ASK_TOOL_NAME);
    expect(frames.find((frame) => frame.t === 'elicitation')).toMatchObject({ runId });
    expect(textOf(frames).startsWith('one question first')).toBe(true);
    expect(textOf(frames)).toContain('everything');
    // The run ended: a subscriber arriving now replays the same stream and terminates.
    const replayed: StreamFrame[] = [];
    for await (const frame of lucid().subscribe(runId)) replayed.push(frame);
    expect(replayed).toEqual(frames);
  });
});
