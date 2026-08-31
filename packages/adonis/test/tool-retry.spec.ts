import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  invokeWithTransientRetry,
  isTransientToolError,
  runAgentLoop,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';

/** A structural MySQL-deadlock-shaped error the default classifier recognizes. */
function deadlockError(): Error & { code: string } {
  return Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' });
}

describe('isTransientToolError', () => {
  it('recognizes MySQL / Postgres / SQLite lock-contention shapes', () => {
    expect(isTransientToolError({ code: 1213, message: 'x' })).toBe(true);
    expect(isTransientToolError({ errno: 1205 })).toBe(true);
    expect(isTransientToolError({ code: 'ER_LOCK_WAIT_TIMEOUT' })).toBe(true);
    expect(isTransientToolError({ code: '40001' })).toBe(true);
    expect(isTransientToolError({ sqlState: '40P01' })).toBe(true);
    expect(isTransientToolError({ code: 'SQLITE_BUSY' })).toBe(true);
  });

  it('recognizes a matching message with no structured code', () => {
    expect(isTransientToolError(new Error('Deadlock found when trying to get lock'))).toBe(true);
    expect(isTransientToolError(new Error('Lock wait timeout exceeded'))).toBe(true);
  });

  it('is false for a plain business error, and for non-object/null', () => {
    expect(isTransientToolError(new Error('city not found'))).toBe(false);
    expect(isTransientToolError('boom')).toBe(false);
    expect(isTransientToolError(null)).toBe(false);
  });

  it('walks one level of `cause` without looping on a self-reference', () => {
    expect(isTransientToolError(new Error('wrap', { cause: { code: 'ER_LOCK_DEADLOCK' } }))).toBe(
      true,
    );
    const selfCause: { message: string; cause?: unknown } = { message: 'oops' };
    selfCause.cause = selfCause;
    expect(isTransientToolError(selfCause)).toBe(false);
  });
});

describe('invokeWithTransientRetry', () => {
  it('transient error then success → one retry, result returned', async () => {
    let calls = 0;
    const onRetry = vi.fn();
    const result = await invokeWithTransientRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw deadlockError();
        return 'ok';
      },
      { attempts: 2, backoffMs: 0 },
      { onRetry },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });

  it('non-transient error → immediate rethrow, no retry', async () => {
    let calls = 0;
    await expect(
      invokeWithTransientRetry(
        async () => {
          calls += 1;
          throw new Error('permission denied');
        },
        { attempts: 5, backoffMs: 0 },
      ),
    ).rejects.toThrow('permission denied');
    expect(calls).toBe(1);
  });

  it('respects max attempts — a persistently transient error eventually surfaces', async () => {
    let calls = 0;
    await expect(
      invokeWithTransientRetry(
        async () => {
          calls += 1;
          throw deadlockError();
        },
        { attempts: 3, backoffMs: 0 },
      ),
    ).rejects.toThrow('deadlock');
    expect(calls).toBe(3);
  });

  it('`false` disables retry entirely — the first transient error surfaces', async () => {
    let calls = 0;
    await expect(
      invokeWithTransientRetry(async () => {
        calls += 1;
        throw deadlockError();
      }, false),
    ).rejects.toThrow('deadlock');
    expect(calls).toBe(1);
  });

  it('never swallows a recognized control-flow signal', async () => {
    let calls = 0;
    const suspend = Object.assign(new Error('suspended'), { name: 'WorkflowSuspended' });
    await expect(
      invokeWithTransientRetry(
        async () => {
          calls += 1;
          throw suspend;
        },
        { attempts: 5, backoffMs: 0, classify: () => true },
        { isControlFlowError: (e) => (e as { name?: string }).name === 'WorkflowSuspended' },
      ),
    ).rejects.toThrow('suspended');
    expect(calls).toBe(1);
  });
});

// ── Loop-level: retry composes with hooks.step and stays replay-safe ──────────

/** Registry with a flaky read tool whose behavior the enclosing test controls. */
function flakyRegistry(handler: () => Promise<unknown>): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(
    {
      name: 'flaky',
      kind: 'read',
      description: 'a read tool that may fail transiently',
      inputSchema: z.object({}),
    },
    { execute: handler },
  );
  return reg;
}

const twoTurnScript: FakeScript = (_args, turnIndex) =>
  turnIndex === 0 ? { text: 'calling', toolCall: { name: 'flaky', input: {} } } : { text: 'done' };

async function runLoop(
  registry: ToolRegistry,
  step: AgentLoopHooks['step'],
  store = new InMemoryAgentStore(),
): Promise<{ text: string; store: InMemoryAgentStore }> {
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({
    actor: { id: 'u1', roles: ['ADMIN'] },
    persona: 'default',
  });
  const runId = 'run-1';
  const deps: AgentLoopDeps = {
    model: new FakeModelProvider(twoTurnScript),
    store,
    registry,
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'test',
    toolTransientRetry: { attempts: 3, backoffMs: 0 },
  };
  const hooks: AgentLoopHooks = {
    runId,
    openSink: () => sink.open(runId),
    awaitApproval: async () => ({ approved: true }),
    step,
  };
  const result = await runAgentLoop(
    deps,
    { threadId: thread.id, actor: { id: 'u1', roles: ['ADMIN'] }, userText: 'hi' },
    hooks,
  );
  return { text: result.text, store };
}

describe('runAgentLoop tool transient retry', () => {
  const passthroughStep: AgentLoopHooks['step'] = (_name, fn) => fn();

  it('retries a transient tool failure in place, then records one executed tool call', async () => {
    let attempts = 0;
    let sideEffects = 0;
    const { store } = await runLoop(
      flakyRegistry(async () => {
        attempts += 1;
        if (attempts === 1) throw deadlockError();
        sideEffects += 1;
        return { ok: true };
      }),
      passthroughStep,
    );
    expect(attempts).toBe(2);
    expect(sideEffects).toBe(1);
    const rows = store.toolCallRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ toolName: 'flaky', status: 'executed' });
    expect(rows[0]?.output).toEqual({ ok: true });
  });

  it('does not retry a permanent tool failure — it is recorded as failed once', async () => {
    let attempts = 0;
    const { store } = await runLoop(
      flakyRegistry(async () => {
        attempts += 1;
        throw new Error('permanent boom');
      }),
      passthroughStep,
    );
    expect(attempts).toBe(1);
    const rows = store.toolCallRows();
    expect(rows[0]).toMatchObject({ toolName: 'flaky', status: 'failed' });
  });

  it('is replay-safe: a memoized step re-run never re-invokes the tool (side effects run once)', async () => {
    let attempts = 0;
    let sideEffects = 0;
    const registry = flakyRegistry(async () => {
      attempts += 1;
      if (attempts === 1) throw deadlockError();
      sideEffects += 1;
      return { ok: true };
    });

    // A memoizing step models durable `ctx.localStep`: the FIRST execution runs `fn` (retries and
    // all) and caches ONLY the successful result; a replay returns the cached promise without
    // re-running the body.
    const cache = new Map<string, Promise<unknown>>();
    const memoStep: AgentLoopHooks['step'] = (name, fn) => {
      if (!cache.has(name)) cache.set(name, fn());
      return cache.get(name) as ReturnType<typeof fn>;
    };

    // First execution: the transient throw is retried inside the `tool:*` step (2 invocations).
    await runLoop(registry, memoStep);
    expect(attempts).toBe(2);
    expect(sideEffects).toBe(1);

    // Replay: same step cache, fresh store/sink — every step (incl. the tool) returns memoized, so
    // the handler is never called again and the single side effect is not repeated.
    const replay = await runLoop(registry, memoStep, new InMemoryAgentStore());
    expect(replay.text).toBe('done');
    expect(attempts).toBe(2);
    expect(sideEffects).toBe(1);
  });
});
