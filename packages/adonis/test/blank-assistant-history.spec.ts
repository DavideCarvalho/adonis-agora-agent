import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  type AgentStore,
  DefaultRolesPolicy,
  LucidAgentStore,
  type ModelMessage,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  runAgentLoop,
  ToolRegistry,
} from '../src/index.js';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '../src/testing/index.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

/**
 * A model can end a step with no text at all — Claude does it right after a tool whose result IS
 * the answer (`renderResult` drawing a card). Anthropic and Bedrock refuse a request that replays an
 * empty assistant message, so one stored on a thread failed every later turn on it. These pin both
 * halves, through the in-memory store and through Lucid (SQLite here; Postgres and MySQL under
 * `pnpm test:db`): the loop never writes one, and a thread that already holds one still answers.
 */

const ACTOR = { id: 'u1', roles: ['ADMIN'] };
let runSeq = 0;
let callSeq = 0;

type Step = Pick<ModelTurnResult, 'text' | 'toolCalls'>;

/** Plays `steps` in order, one per model call, and snapshots every prompt it was handed. */
class ScriptedModel implements ModelProvider {
  readonly prompts: ModelMessage[][] = [];
  private next = 0;

  constructor(private readonly steps: Step[]) {}

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.prompts.push(args.messages.map((message) => ({ ...message })));
    const step = this.steps[this.next] ?? { text: 'fallback', toolCalls: [] };
    this.next += 1;
    return { ...step, usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

function registry(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register(
    { name: 'renderResult', kind: 'read', description: 'draw a card', inputSchema: z.object({}) },
    { execute: async () => ({ rendered: true }) },
  );
  return tools;
}

async function turn(
  store: AgentStore,
  model: ModelProvider,
  threadId: string,
  userText: string,
): Promise<string> {
  runSeq += 1;
  const runId = `run-blank-${runSeq}`;
  const sink = new InMemoryTokenStreamSink();
  const deps: AgentLoopDeps = {
    model,
    store,
    registry: registry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-10-08',
    systemPrompt: 'You are a test agent.',
  };
  const hooks: AgentLoopHooks = {
    runId,
    openSink: () => sink.open(runId),
    awaitApproval: async () => ({ approved: true }),
    step: (_name, fn) => fn(),
  };
  const result = await runAgentLoop(deps, { threadId, actor: ACTOR, userText }, hooks);
  return result.text;
}

/** Assistant messages a provider refuses: blank text and nothing else. */
function blankAssistants(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter(
    (message) =>
      message.role === 'assistant' &&
      message.content.trim().length === 0 &&
      (message.toolCalls?.length ?? 0) === 0 &&
      (message.toolResults?.length ?? 0) === 0,
  );
}

let db: Database | undefined;
afterEach(async () => {
  await db?.manager.closeAll();
  db = undefined;
});

type StoreCase = [name: string, open: () => Promise<AgentStore>];
const lucid: StoreCase = [
  'LucidAgentStore',
  async () => {
    db = await makeStoreDb();
    return new LucidAgentStore(asStoreDb(db));
  },
];
const inMemory: StoreCase = ['InMemoryAgentStore', async () => new InMemoryAgentStore()];
// The Postgres and MySQL projects re-run this file for the Lucid store only.
const stores: StoreCase[] =
  process.env.AGENT_TEST_BACKEND === undefined ? [inMemory, lucid] : [lucid];

describe.each(stores)('empty assistant messages — %s', (_name, openStore) => {
  it('a step that ends with no text after a tool is not stored, and the next turn replays none', async () => {
    const store = await openStore();
    const thread = await store.createThread({ actor: ACTOR });
    callSeq += 1;
    const callId = `call-render-${callSeq}`;
    const model = new ScriptedModel([
      // Turn 1: call the tool with no text, then stop with no text either.
      { text: '', toolCalls: [{ id: callId, name: 'renderResult', input: {} }] },
      { text: '', toolCalls: [] },
      // Turn 2.
      { text: 'second answer', toolCalls: [] },
    ]);

    await turn(store, model, thread.id, 'show me the users');
    await turn(store, model, thread.id, 'and now?');

    const stored = (await store.getThread(thread.id))?.messages ?? [];
    // The tool exchange stays, as a tool-call-only assistant message — valid for every provider.
    expect(stored.map((message) => [message.role, message.content])).toEqual([
      ['user', 'show me the users'],
      ['assistant', ''],
      ['user', 'and now?'],
      ['assistant', 'second answer'],
    ]);
    expect(stored[1]?.toolCalls?.map((call) => call.id)).toEqual([callId]);
    expect(stored[1]?.toolResults?.map((result) => result.output)).toEqual([{ rendered: true }]);

    const secondTurnPrompt = model.prompts[2] ?? [];
    expect(blankAssistants(secondTurnPrompt)).toEqual([]);
    expect(secondTurnPrompt.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(secondTurnPrompt[1]?.toolCalls?.map((call) => call.id)).toEqual([callId]);
  });

  it('a step whose text is whitespace only is not stored', async () => {
    const store = await openStore();
    const thread = await store.createThread({ actor: ACTOR });
    const model = new ScriptedModel([{ text: ' \n\t', toolCalls: [] }]);

    await turn(store, model, thread.id, 'hi');

    const stored = (await store.getThread(thread.id))?.messages ?? [];
    expect(stored.map((message) => message.role)).toEqual(['user']);
  });

  it('a thread already holding empty assistant messages heals on its next turn', async () => {
    const store = await openStore();
    const thread = await store.createThread({ actor: ACTOR });
    callSeq += 1;
    const callId = `old-render-${callSeq}`;
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'show me the users' });
    await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: '',
      toolCalls: [{ id: callId, name: 'renderResult', input: {} }],
      toolResults: [{ id: callId, name: 'renderResult', output: { rendered: true } }],
    });
    // What the loop wrote for a blank final step before this fix.
    await store.appendMessage({ threadId: thread.id, role: 'assistant', content: '' });
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'still there?' });
    await store.appendMessage({ threadId: thread.id, role: 'assistant', content: ' \n ' });
    const model = new ScriptedModel([{ text: 'healed', toolCalls: [] }]);

    expect(await turn(store, model, thread.id, 'hello?')).toBe('healed');

    const prompt = model.prompts[0] ?? [];
    expect(blankAssistants(prompt)).toEqual([]);
    expect(prompt.map((message) => [message.role, message.content])).toEqual([
      ['user', 'show me the users'],
      ['assistant', ''],
      ['user', 'still there?'],
      ['user', 'hello?'],
    ]);
    expect(prompt[1]?.toolCalls?.map((call) => call.id)).toEqual([callId]);
  });
});
