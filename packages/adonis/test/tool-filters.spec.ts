import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  type ModelProvider,
  type ModelTurnArgs,
  runAgentLoop,
  ToolRegistry,
} from '../src/index.js';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '../src/testing/index.js';

/** Two read tools: `alpha` any authed role, `beta` restricted to a `SUPER` role. */
function buildRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(
    { name: 'alpha', kind: 'read', description: 'a', inputSchema: z.object({}), roles: ['ADMIN'] },
    { execute: async () => ({}) },
  );
  reg.register(
    { name: 'beta', kind: 'read', description: 'b', inputSchema: z.object({}), roles: ['SUPER'] },
    { execute: async () => ({}) },
  );
  return reg;
}

/** A model that records the tool names it was offered, then finishes without calling any. */
function capturingModel(seen: string[][]): ModelProvider {
  return {
    async runTurn(args: ModelTurnArgs) {
      seen.push(args.tools.map((tool) => tool.name));
      await args.sink.write({ t: 'text', v: 'ok' });
      return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

async function runWith(
  toolAllowList: string[] | undefined,
  actorRoles: string[],
): Promise<string[]> {
  const seen: string[][] = [];
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const actor = { id: 'u1', roles: actorRoles };
  const thread = await store.createThread({ actor, persona: 'default' });
  const runId = 'run-1';
  const deps: AgentLoopDeps = {
    model: capturingModel(seen),
    store,
    registry: buildRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'test',
    ...(toolAllowList !== undefined ? { toolAllowList } : {}),
  };
  const hooks: AgentLoopHooks = {
    runId,
    openSink: () => sink.open(runId),
    awaitApproval: async () => ({ approved: true }),
    step: (_name, fn) => fn(),
  };
  await runAgentLoop(deps, { threadId: thread.id, actor, userText: 'hi' }, hooks);
  return seen[0] ?? [];
}

describe('tool filters (assembled tool list offered to the model)', () => {
  it('an agent allow-list hides a filtered tool from the model', async () => {
    const offered = await runWith(['alpha'], ['ADMIN']);
    expect(offered).toEqual(['alpha']);
    expect(offered).not.toContain('beta');
  });

  it('the role filter hides a tool the actor may not invoke', async () => {
    // The actor is ADMIN, so `beta` (SUPER-only) is dropped even without an allow-list.
    const offered = await runWith(undefined, ['ADMIN']);
    expect(offered).toEqual(['alpha']);
  });

  it('with no allow-list and a matching role, every permitted tool is offered', async () => {
    const offered = await runWith(undefined, ['ADMIN', 'SUPER']);
    expect(new Set(offered)).toEqual(new Set(['alpha', 'beta']));
  });
});
