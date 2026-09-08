import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

      const deploy = stats.find((s) => s.toolName === 'deploy');
      expect(deploy?.calls).toBe(2);
      expect(deploy?.rejected).toBe(1);
      expect(deploy?.avgDurationMs).toBeNull(); // no execution_ms recorded
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
