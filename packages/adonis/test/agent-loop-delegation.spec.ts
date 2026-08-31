import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  type RolesPolicy,
  runAgentLoop,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';

/**
 * Regression coverage for the delegation authorization hole: `agent`-kind tool calls were handled
 * at the loop level and called `hooks.runAgent` directly, never through `ToolRegistry.invoke` — so
 * the `policy.can(actor, spec)` re-check, the persona/agent allow-list filter, and Zod input
 * validation were all skipped. A model steered by injected content (delegate tool names are
 * advertised in sibling delegate descriptions) could name a delegate directly and run it regardless
 * of the actor's role or the agent's configured allow-list.
 *
 * Synthesized delegate specs (`registerDelegateTools` in agent-deps-factory.ts) carry no `roles`
 * and no `ability` — under `DefaultRolesPolicy` that defaults to ADMIN-only, and under an authz
 * posture a tool with no `ability` is always denied. They are meant to be unreachable by a
 * non-privileged actor; this suite proves the loop actually enforces that.
 */

function buildRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  // A delegate tool synthesized the way `registerDelegateTools` does: kind 'agent', no roles, no
  // ability. Under `DefaultRolesPolicy` (ADMIN-only fallback) only an ADMIN actor may call it.
  reg.register(
    {
      name: 'ask_billing',
      kind: 'agent',
      targetAgent: 'billing-agent',
      description: 'Delegate a task to the "billing-agent" agent and get its answer.',
      inputSchema: z.object({ task: z.string() }),
    },
    { execute: async () => ({ text: 'unused — agent-kind tools are loop-handled' }) },
  );
  return reg;
}

function buildDeps(overrides: Partial<AgentLoopDeps> = {}): {
  deps: AgentLoopDeps;
  store: InMemoryAgentStore;
} {
  const store = new InMemoryAgentStore();
  const deps: AgentLoopDeps = {
    model: new FakeModelProvider(() => ({ text: 'unused' })),
    store,
    registry: buildRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    day: '2026-07-29',
    systemPrompt: 'You are a test agent.',
    ...overrides,
  };
  return { deps, store };
}

interface RunResult {
  result: { text: string };
  store: InMemoryAgentStore;
}

async function run(
  script: FakeScript,
  runAgent: NonNullable<AgentLoopHooks['runAgent']>,
  overrides: {
    actorRoles?: string[];
    toolAllowList?: string[];
    rolesPolicy?: RolesPolicy;
  } = {},
): Promise<RunResult> {
  const { deps, store } = buildDeps({
    model: new FakeModelProvider(script),
    ...(overrides.toolAllowList !== undefined ? { toolAllowList: overrides.toolAllowList } : {}),
    ...(overrides.rolesPolicy !== undefined ? { rolesPolicy: overrides.rolesPolicy } : {}),
  });
  const actor = { id: 'u1', roles: overrides.actorRoles ?? ['ADMIN'] };
  const thread = await store.createThread({ actor, persona: 'default' });
  const sink = new InMemoryTokenStreamSink();
  const runId = 'run-1';
  const hooks: AgentLoopHooks = {
    runId,
    openSink: () => sink.open(runId),
    awaitApproval: async () => ({ approved: true }),
    step: (_name, fn) => fn(),
    runAgent,
  };
  const result = await runAgentLoop(
    deps,
    { threadId: thread.id, actor, userText: 'please ask billing' },
    hooks,
  );
  return { result, store };
}

describe('runAgentLoop — delegation (agent-kind tool call) authorization', () => {
  it('does NOT call runAgent when the policy denies the actor for the delegate spec', async () => {
    const runAgent = vi.fn(async () => ({ text: 'should never happen' }));
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? {
            text: 'delegating',
            // The model calls a delegate it was never offered — a non-ADMIN actor never sees
            // `ask_billing` in `definitionsFor`, but nothing stops the model from naming it anyway.
            toolCall: { name: 'ask_billing', input: { task: 'refund' } },
          }
        : { text: 'done' };

    // A member (non-ADMIN) actor; `ask_billing` has no `roles`, so DefaultRolesPolicy's ADMIN-only
    // fallback denies it.
    const { result, store } = await run(script, runAgent, { actorRoles: ['member'] });

    expect(runAgent).not.toHaveBeenCalled();
    expect(result.text).toBe('done');
    const rows = store.toolCallRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).not.toBe('auto_executed');
    expect(rows[0]?.status).toBe('failed');
  });

  it('still calls runAgent for a permitted actor with an allow-listed delegate (guards against over-tightening)', async () => {
    const runAgent = vi.fn(async (agentName: string, task: string) => ({
      text: `answer from ${agentName} re: ${task}`,
    }));
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? {
            text: 'delegating',
            toolCall: { name: 'ask_billing', input: { task: 'refund' } },
          }
        : { text: 'the billing agent answered' };

    const { result, store } = await run(script, runAgent, {
      actorRoles: ['ADMIN'],
      toolAllowList: ['ask_billing'],
    });

    expect(runAgent).toHaveBeenCalledExactlyOnceWith('billing-agent', 'refund');
    expect(result.text).toBe('the billing agent answered');
    const rows = store.toolCallRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ toolName: 'ask_billing', status: 'executed' });
  });

  it('does NOT call runAgent when the actor is permitted but the delegate is outside the agent allow-list', async () => {
    const runAgent = vi.fn(async () => ({ text: 'should never happen' }));
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? {
            text: 'delegating',
            toolCall: { name: 'ask_billing', input: { task: 'refund' } },
          }
        : { text: 'done' };

    // ADMIN passes the role check, but the agent's own allow-list only permits a different tool —
    // `ask_billing` was never in the set offered to the model this turn.
    const { result, store } = await run(script, runAgent, {
      actorRoles: ['ADMIN'],
      toolAllowList: ['some_other_tool'],
    });

    expect(runAgent).not.toHaveBeenCalled();
    expect(result.text).toBe('done');
    const rows = store.toolCallRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).not.toBe('auto_executed');
    expect(rows[0]?.status).toBe('failed');
  });

  it('does NOT call runAgent when the delegate input does not match the spec input schema', async () => {
    const runAgent = vi.fn(async () => ({ text: 'should never happen' }));
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? {
            text: 'delegating',
            // Permitted actor, allow-listed delegate — but the input is malformed. Without the
            // input gate the loop coerces it to a JSON blob and delegates it anyway.
            toolCall: { name: 'ask_billing', input: { task: { nested: 1 } } },
          }
        : { text: 'done' };

    const { result, store } = await run(script, runAgent, {
      actorRoles: ['ADMIN'],
      toolAllowList: ['ask_billing'],
    });

    expect(runAgent).not.toHaveBeenCalled();
    expect(result.text).toBe('done');
    const rows = store.toolCallRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).not.toBe('auto_executed');
    expect(rows[0]?.status).toBe('failed');
  });

  // The `spec === undefined` guard inside the delegation branch is unreachable defensive code:
  // `toolType = spec?.kind ?? 'read'` means an unresolved name never enters that branch at all.
  // What this case actually covers is the `read` path rejecting it via `ToolNotFoundError`.
  it('an unregistered tool name never reaches the delegation branch (it resolves as read and invoke throws)', async () => {
    const runAgent = vi.fn(async () => ({ text: 'should never happen' }));
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? {
            text: 'delegating',
            // Never registered at all — an unresolvable spec must not run the delegation path.
            toolCall: { name: 'ask_nonexistent', input: { task: 'refund' } },
          }
        : { text: 'done' };

    const { result } = await run(script, runAgent, { actorRoles: ['ADMIN'] });

    expect(runAgent).not.toHaveBeenCalled();
    expect(result.text).toBe('done');
  });

  it('does not persist a denied delegation as auto_executed (nothing recorded as auto_executed on denial)', async () => {
    const runAgent = vi.fn(async () => ({ text: 'should never happen' }));
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? {
            text: 'delegating',
            toolCall: { name: 'ask_billing', input: { task: 'refund' } },
          }
        : { text: 'done' };

    const { deps, store } = buildDeps({ model: new FakeModelProvider(script) });
    const recordToolCallSpy = vi.spyOn(store, 'recordToolCall');
    const actor = { id: 'u1', roles: ['member'] };
    const thread = await store.createThread({ actor, persona: 'default' });
    const sink = new InMemoryTokenStreamSink();
    const runId = 'run-1';
    const hooks: AgentLoopHooks = {
      runId,
      openSink: () => sink.open(runId),
      awaitApproval: async () => ({ approved: true }),
      step: (_name, fn) => fn(),
      runAgent,
    };

    await runAgentLoop(deps, { threadId: thread.id, actor, userText: 'please ask billing' }, hooks);

    expect(runAgent).not.toHaveBeenCalled();
    for (const call of recordToolCallSpy.mock.calls) {
      expect(call[0].status).not.toBe('auto_executed');
    }
  });
});
