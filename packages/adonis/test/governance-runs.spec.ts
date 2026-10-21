import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentGovernanceQueries,
  type AgentStore,
  LucidAgentStore,
  LucidGovernanceQueries,
} from '../src/index.js';
import { InMemoryAgentStore, InMemoryGovernanceQueries } from '../src/testing/index.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

const alice = { id: 'alice' };
const bob = { id: 'bob' };

/**
 * Record four runs directly against an {@link AgentStore} — exactly as the loop + runners would — so
 * the SAME fixture drives both the in-memory and Lucid governance twins:
 *  - run-1  alice/'default'  completed, 1 message pair + 1 usage + 1 executed `search` tool call
 *  - run-2  alice/'default'  failed
 *  - run-3  bob              running, with a `deploy` tool call awaiting approval
 *  - run-4  bob              completed, with a failed `search` + a rejected `deploy` tool call
 */
async function seed(store: AgentStore): Promise<void> {
  const threadA = await store.createThread({ actor: alice, persona: 'default', title: 'A' });
  const threadB = await store.createThread({ actor: bob, persona: 'default', title: 'B' });

  // run-1 — completed
  await store.recordRunStart({
    runId: 'run-1',
    threadId: threadA.id,
    actor: alice,
    agentName: 'default',
  });
  await store.appendMessage({ threadId: threadA.id, role: 'user', content: 'hi', runId: 'run-1' });
  const m1 = await store.appendMessage({
    threadId: threadA.id,
    role: 'assistant',
    content: 'there',
    runId: 'run-1',
  });
  await store.recordUsage({
    threadId: threadA.id,
    actorRef: 'alice',
    runId: 'run-1',
    modelId: 'gpt-x',
    purpose: 'chat',
    usage: { inputTokens: 100, outputTokens: 50 },
  });
  await store.recordToolCall({
    toolCallId: 'tc-a',
    messageId: m1.id,
    toolName: 'search',
    toolType: 'read',
    input: { q: 'x' },
    status: 'auto_executed',
    runId: 'run-1',
  });
  await store.updateToolCall({ toolCallId: 'tc-a', status: 'executed', executionMs: 20 });
  await store.recordRunEnd({
    runId: 'run-1',
    status: 'completed',
    finishedAt: Date.now() + 25,
    stepCount: 1,
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 1.5,
  });

  // run-2 — failed
  await store.recordRunStart({
    runId: 'run-2',
    threadId: threadA.id,
    actor: alice,
    agentName: 'default',
  });
  await store.recordRunEnd({
    runId: 'run-2',
    status: 'failed',
    finishedAt: Date.now() + 10,
    error: 'boom',
  });

  // run-3 — running, one pending approval
  await store.recordRunStart({ runId: 'run-3', threadId: threadB.id, actor: bob });
  const m3 = await store.appendMessage({
    threadId: threadB.id,
    role: 'assistant',
    content: 'let me act',
    runId: 'run-3',
  });
  await store.recordToolCall({
    toolCallId: 'tc-b',
    messageId: m3.id,
    toolName: 'deploy',
    toolType: 'action',
    input: { env: 'prod' },
    status: 'pending_approval',
    runId: 'run-3',
  });

  // run-4 — completed, a failed read + a rejected action
  await store.recordRunStart({ runId: 'run-4', threadId: threadB.id, actor: bob });
  const m4 = await store.appendMessage({
    threadId: threadB.id,
    role: 'assistant',
    content: 'oops',
    runId: 'run-4',
  });
  await store.recordToolCall({
    toolCallId: 'tc-c',
    messageId: m4.id,
    toolName: 'search',
    toolType: 'read',
    input: {},
    status: 'auto_executed',
    runId: 'run-4',
  });
  await store.updateToolCall({
    toolCallId: 'tc-c',
    status: 'failed',
    error: 'nope',
    executionMs: 5,
  });
  await store.recordToolCall({
    toolCallId: 'tc-d',
    messageId: m4.id,
    toolName: 'deploy',
    toolType: 'action',
    input: {},
    status: 'pending_approval',
    runId: 'run-4',
  });
  await store.updateToolCall({ toolCallId: 'tc-d', status: 'rejected' });
  await store.recordRunEnd({ runId: 'run-4', status: 'completed', finishedAt: Date.now() + 15 });
}

/** The contract every {@link AgentGovernanceQueries} run read-model must satisfy, run against both twins. */
function runContract(name: string, make: () => Promise<AgentGovernanceQueries>): void {
  describe(`run read-model — ${name}`, () => {
    it('listRuns returns all runs newest-first, no cursor', async () => {
      const gov = await make();
      const page = await gov.listRuns();
      expect(page.items.map((r) => r.runId)).toEqual(['run-4', 'run-3', 'run-2', 'run-1']);
      expect(page.nextCursor).toBeNull();
      expect(page.hasNext).toBe(false);
      // Forward-only read-model: the backward half of the `CursorPage` is constant.
      expect(page.prevCursor).toBeNull();
      expect(page.hasPrev).toBe(false);
      // run-1's rollup survived the round-trip
      const run1 = page.items.find((r) => r.runId === 'run-1');
      expect(run1?.status).toBe('completed');
      expect(run1?.stepCount).toBe(1);
      expect(run1?.inputTokens).toBe(100);
      expect(run1?.outputTokens).toBe(50);
      expect(run1?.costUsd).toBeCloseTo(1.5, 6);
      expect(run1?.agentName).toBe('default');
      expect(run1?.durationMs).not.toBeNull();
    });

    it('listRuns filters by actor / status / agent', async () => {
      const gov = await make();
      expect((await gov.listRuns({ actor: 'alice' })).items.map((r) => r.runId)).toEqual([
        'run-2',
        'run-1',
      ]);
      expect((await gov.listRuns({ status: 'failed' })).items.map((r) => r.runId)).toEqual([
        'run-2',
      ]);
      expect((await gov.listRuns({ status: 'running' })).items.map((r) => r.runId)).toEqual([
        'run-3',
      ]);
      expect((await gov.listRuns({ agent: 'default' })).items.map((r) => r.runId)).toEqual([
        'run-2',
        'run-1',
      ]);
    });

    it('listRuns paginates with an opaque cursor', async () => {
      const gov = await make();
      const first = await gov.listRuns({ first: 2 });
      expect(first.items.map((r) => r.runId)).toEqual(['run-4', 'run-3']);
      expect(first.nextCursor).not.toBeNull();
      expect(first.hasNext).toBe(true);
      // Even mid-list, the forward-only page never claims a backward one.
      expect(first.prevCursor).toBeNull();
      expect(first.hasPrev).toBe(false);

      // Non-null asserted: the line above already asserts `first.nextCursor` is not null.
      const second = await gov.listRuns({ first: 2, after: first.nextCursor! });
      expect(second.items.map((r) => r.runId)).toEqual(['run-2', 'run-1']);
      expect(second.nextCursor).toBeNull();
      expect(second.hasNext).toBe(false);
      expect(second.hasPrev).toBe(false);
    });

    it('runDetail assembles the run, its messages, tool calls, approvals and usage', async () => {
      const gov = await make();
      const detail = await gov.runDetail('run-1');
      expect(detail?.run.runId).toBe('run-1');
      expect(detail?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(detail?.toolCalls.map((c) => c.toolName)).toEqual(['search']);
      expect(detail?.toolCalls[0]?.status).toBe('executed');
      expect(detail?.toolCalls[0]?.executionMs).toBe(20);
      expect(detail?.approvals).toEqual([]);
      expect(detail?.usage.map((u) => u.modelId)).toEqual(['gpt-x']);

      // a running run exposes its pending approval in `approvals`
      const running = await gov.runDetail('run-3');
      expect(running?.approvals.map((c) => c.toolCallId)).toEqual(['tc-b']);

      expect(await gov.runDetail('nope')).toBeNull();
    });

    it('pendingApprovals returns only the awaiting call, filterable by actor', async () => {
      const gov = await make();
      const pending = await gov.pendingApprovals();
      expect(pending.map((p) => p.toolCallId)).toEqual(['tc-b']);
      expect(pending[0]?.toolName).toBe('deploy');
      expect(pending[0]?.actorRef).toBe('bob');
      expect(pending[0]?.runId).toBe('run-3');

      expect(await gov.pendingApprovals({ actor: 'alice' })).toEqual([]);
      expect((await gov.pendingApprovals({ actor: 'bob' })).map((p) => p.toolCallId)).toEqual([
        'tc-b',
      ]);
    });

    it('perToolStats rolls up calls / failures / rejections / avg duration per tool', async () => {
      const gov = await make();
      const stats = await gov.perToolStats();
      // both tools have 2 calls → tiebreak by name asc
      expect(stats.map((s) => s.toolName)).toEqual(['deploy', 'search']);

      const search = stats.find((s) => s.toolName === 'search');
      expect(search?.calls).toBe(2);
      expect(search?.failed).toBe(1);
      expect(search?.rejected).toBe(0);
      expect(search?.avgDurationMs).toBeCloseTo(12.5, 6); // (20 + 5) / 2
      // Nearest-rank over [5, 20]: index floor(p · 2) → 20 for both.
      expect(search?.p50ExecutionMs).toBe(20);
      expect(search?.p95ExecutionMs).toBe(20);

      const deploy = stats.find((s) => s.toolName === 'deploy');
      expect(deploy?.calls).toBe(2);
      expect(deploy?.rejected).toBe(1);
      expect(deploy?.avgDurationMs).toBeNull(); // no execution_ms recorded
      expect(deploy?.p50ExecutionMs).toBeNull();
      expect(deploy?.p95ExecutionMs).toBeNull();
    });

    it('runReliability aggregates success / failure / cancel rates', async () => {
      const gov = await make();
      const reliability = await gov.runReliability();
      expect(reliability.runs).toBe(4);
      expect(reliability.completed).toBe(2);
      expect(reliability.failed).toBe(1);
      expect(reliability.cancelled).toBe(0);
      expect(reliability.running).toBe(1);
      expect(reliability.successRate).toBeCloseTo(0.5, 6);
      expect(reliability.failureRate).toBeCloseTo(0.25, 6);
      expect(reliability.cancelRate).toBe(0);
      expect(reliability.avgDurationMs).not.toBeNull();
    });
  });
}

const T0 = Date.parse('2026-03-07T10:00:00.000Z');

/**
 * Runs for the latency / failure-code rollup, on a frozen clock so every duration is exact:
 *  - ten completed person-started turns, durations 1s…10s and TTFTs 100ms…1000ms (the 10s one
 *    streamed no text, so it has no TTFT)
 *  - a completed delegation child (60s, TTFT 30s) — must not move either distribution
 *  - three failed runs: two `run_failed` (one of them a child), one with no code (from before codes)
 *  - one `quota_exceeded`, one cancelled, one still running
 */
async function seedLatency(store: AgentStore): Promise<void> {
  vi.useFakeTimers({ now: T0, toFake: ['Date'] });
  try {
    const thread = await store.createThread({ actor: alice, persona: 'default', title: 'L' });
    const run = async (
      runId: string,
      end: Omit<Parameters<AgentStore['recordRunEnd']>[0], 'runId'> | null,
      parentRunId?: string,
    ) => {
      await store.recordRunStart({
        runId,
        threadId: thread.id,
        actor: alice,
        ...(parentRunId !== undefined ? { parentRunId } : {}),
      });
      if (end !== null) await store.recordRunEnd({ runId, ...end });
    };
    for (let i = 1; i <= 10; i += 1) {
      await run(`turn-${i}`, {
        status: 'completed',
        finishedAt: T0 + i * 1000,
        ...(i < 10 ? { ttftMs: i * 100 } : {}),
        modelId: 'gpt-x',
      });
    }
    await run('child', { status: 'completed', finishedAt: T0 + 60_000, ttftMs: 30_000 }, 'turn-1');
    await run('fail-1', { status: 'failed', error: 'boom', errorCode: 'run_failed' });
    await run('fail-2', { status: 'failed', error: 'boom', errorCode: 'run_failed' }, 'turn-2');
    await run('fail-3', { status: 'failed', error: 'old' });
    await run('fail-4', { status: 'failed', error: 'spent', errorCode: 'quota_exceeded' });
    await run('stop', { status: 'cancelled' });
    await run('live', null);
  } finally {
    vi.useRealTimers();
  }
}

/** Turn latency, failures by code and the run's new columns, against both twins. */
function latencyContract(name: string, make: () => Promise<AgentGovernanceQueries>): void {
  describe(`run latency read-model — ${name}`, () => {
    it('runReliability reports TTFT and turn-duration percentiles over completed person turns', async () => {
      const gov = await make();
      const { latency } = await gov.runReliability();
      // Nine TTFT samples 100…900 → p50 = sorted[4], p95 = sorted[8]; the child's 30s is not one.
      expect(latency?.ttft).toEqual({ samples: 9, p50Ms: 500, p95Ms: 900 });
      // Ten durations 1s…10s → p50 = sorted[5], p95 = sorted[9]; the child's 60s is not one.
      expect(latency?.duration).toEqual({ samples: 10, p50Ms: 6000, p95Ms: 10_000 });
    });

    it('runReliability counts every failed run by code, null code → unknown', async () => {
      const gov = await make();
      const reliability = await gov.runReliability();
      expect(reliability.failed).toBe(4);
      expect(reliability.failuresByCode).toEqual([
        { code: 'run_failed', count: 2 },
        { code: 'quota_exceeded', count: 1 },
        { code: 'unknown', count: 1 },
      ]);
    });

    it('an empty range yields no samples and no codes', async () => {
      const gov = await make();
      const reliability = await gov.runReliability({ from: '2030-01-01' });
      expect(reliability.latency).toEqual({
        ttft: { samples: 0, p50Ms: null, p95Ms: null },
        duration: { samples: 0, p50Ms: null, p95Ms: null },
      });
      expect(reliability.failuresByCode).toEqual([]);
    });

    it('recordRunEnd persists ttftMs, errorCode and modelId onto the run row', async () => {
      const gov = await make();
      expect((await gov.runDetail('turn-3'))?.run).toMatchObject({
        status: 'completed',
        ttftMs: 300,
        errorCode: null,
        modelId: 'gpt-x',
      });
      expect((await gov.runDetail('fail-4'))?.run).toMatchObject({
        status: 'failed',
        error: 'spent',
        errorCode: 'quota_exceeded',
        ttftMs: null,
        modelId: null,
      });
      const page = await gov.listRuns({ status: 'failed' });
      expect(page.items.map((row) => row.errorCode).sort()).toEqual([
        null,
        'quota_exceeded',
        'run_failed',
        'run_failed',
      ]);
    });
  });
}

latencyContract('in-memory', async () => {
  const store = new InMemoryAgentStore();
  await seedLatency(store);
  return new InMemoryGovernanceQueries(store);
});

describe('run latency read-model — Lucid (SQLite)', () => {
  let db: Database;
  beforeEach(async () => {
    db = await makeStoreDb();
  });
  afterEach(async () => {
    await db?.manager.closeAll();
  });

  latencyContract('lucid', async () => {
    const store = new LucidAgentStore(asStoreDb(db));
    await seedLatency(store);
    return new LucidGovernanceQueries(asStoreDb(db));
  });
});

runContract('in-memory', async () => {
  const store = new InMemoryAgentStore();
  await seed(store);
  return new InMemoryGovernanceQueries(store);
});

describe('run read-model — Lucid (SQLite)', () => {
  let db: Database;
  beforeEach(async () => {
    db = await makeStoreDb();
  });
  afterEach(async () => {
    await db?.manager.closeAll();
  });

  runContract('lucid', async () => {
    const store = new LucidAgentStore(asStoreDb(db));
    await seed(store);
    return new LucidGovernanceQueries(asStoreDb(db));
  });
});
