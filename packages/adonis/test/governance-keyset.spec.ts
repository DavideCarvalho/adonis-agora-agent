import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentGovernanceQueries,
  type AgentStore,
  createAgentGovernanceIndexes,
  dropAgentGovernanceIndexes,
  governanceIndexStatements,
  LucidAgentStore,
  LucidGovernanceQueries,
} from '../src/index.js';
import type { CursorPage } from '../src/pagination.js';
import { InMemoryAgentStore, InMemoryGovernanceQueries } from '../src/testing/index.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

const T0 = Date.parse('2026-11-17T10:00:00.000Z');

/**
 * Nine threads, each with one message, one tool call and one run, recorded at only three distinct
 * instants (three rows per instant), so most rows tie on the order column and only the id keeps
 * pages apart.
 */
async function seed(store: AgentStore): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    for (let n = 0; n < 9; n++) {
      vi.setSystemTime(T0 + Math.floor(n / 3) * 1000);
      const actor = { id: n % 2 === 0 ? 'alice' : 'bob' };
      const thread = await store.createThread({ actor, persona: 'default', title: `t${n}` });
      const runId = `run-${n}`;
      await store.recordRunStart({
        runId,
        threadId: thread.id,
        actor,
        agentName: n % 3 === 0 ? 'triage' : 'default',
      });
      const message = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'x',
        runId,
      });
      await store.recordToolCall({
        toolCallId: `call-${n}`,
        messageId: message.id,
        toolName: 'search',
        toolType: 'read',
        input: {},
        status: 'auto_executed',
        runId,
      });
    }
  } finally {
    vi.useRealTimers();
  }
}

/** Every page of a forward-only read, following `nextCursor`. */
async function walk<T>(read: (after?: string) => Promise<CursorPage<T>>): Promise<T[][]> {
  const pages: T[][] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const page = await read(after);
    pages.push(page.items);
    expect(page.prevCursor).toBeNull();
    if (!page.hasNext) {
      expect(page.nextCursor).toBeNull();
      return pages;
    }
    after = page.nextCursor ?? undefined;
  }
  throw new Error('no last page');
}

function contract(name: string, make: () => Promise<AgentGovernanceQueries>): void {
  describe(`governance keyset paging — ${name}`, () => {
    it('walks the tool-call feed once, newest first, across ties', async () => {
      const gov = await make();
      const all = await gov.recentToolCalls(100);
      const pages = await walk((after) =>
        gov.toolCallsPage!({ first: 2, ...(after ? { after } : {}) }),
      );
      expect(pages.map((page) => page.length)).toEqual([2, 2, 2, 2, 1]);
      const ids = pages.flat().map((row) => row.toolCallId);
      expect(new Set(ids).size).toBe(9);
      // Same order as the capped read, the newest instant first.
      expect(ids).toEqual(all.map((row) => row.toolCallId));
      expect(ids.slice(0, 3).sort()).toEqual(['call-6', 'call-7', 'call-8']);
    });

    it('walks the thread feed once, most recently active first', async () => {
      const gov = await make();
      const all = await gov.recentThreads(100);
      const pages = await walk((after) =>
        gov.threadsPage!({ first: 4, ...(after ? { after } : {}) }),
      );
      const ids = pages.flat().map((row) => row.threadId);
      expect(new Set(ids).size).toBe(9);
      expect(ids).toEqual(all.map((row) => row.threadId));
    });

    it('pages runs by keyset, filters included', async () => {
      const gov = await make();
      const pages = await walk((after) => gov.listRuns({ first: 2, ...(after ? { after } : {}) }));
      const ids = pages.flat().map((row) => row.runId);
      expect(ids).toEqual((await gov.listRuns({ first: 100 })).items.map((row) => row.runId));
      expect(new Set(ids).size).toBe(9);

      const triage = await walk((after) =>
        gov.listRuns({ agent: 'triage', first: 1, ...(after ? { after } : {}) }),
      );
      expect(triage.flat().map((row) => row.runId)).toEqual(['run-6', 'run-3', 'run-0']);
    });

    it('still honours the offset cursor older versions handed out', async () => {
      const gov = await make();
      const all = (await gov.listRuns({ first: 100 })).items.map((row) => row.runId);
      const legacy = await gov.listRuns({ first: 3, after: '3' });
      expect(legacy.items.map((row) => row.runId)).toEqual(all.slice(3, 6));
      // …and the next cursor it returns is a keyset one that continues right after.
      const next = await gov.listRuns({ first: 3, after: legacy.nextCursor ?? '' });
      expect(next.items.map((row) => row.runId)).toEqual(all.slice(6, 9));
    });
  });
}

contract('in-memory', async () => {
  const store = new InMemoryAgentStore();
  await seed(store);
  return new InMemoryGovernanceQueries(store);
});

describe('Lucid', () => {
  let db: Database;
  beforeEach(async () => {
    db = await makeStoreDb();
  });
  afterEach(async () => {
    await db?.manager.closeAll();
  });

  contract('lucid', async () => {
    await seed(new LucidAgentStore(asStoreDb(db)));
    return new LucidGovernanceQueries(asStoreDb(db));
  });

  it('creates the opt-in governance list indexes once, and drops them', async () => {
    const created = await createAgentGovernanceIndexes(asStoreDb(db));
    expect(created).toHaveLength(governanceIndexStatements().length);
    // An install that already has them: nothing to do, no error.
    expect(await createAgentGovernanceIndexes(asStoreDb(db))).toEqual([]);
    // The reads still answer with the indexes in place.
    await seed(new LucidAgentStore(asStoreDb(db)));
    const gov = new LucidGovernanceQueries(asStoreDb(db));
    expect((await gov.toolCallsPage({ first: 5 })).items).toHaveLength(5);
    await dropAgentGovernanceIndexes(asStoreDb(db));
    expect(await createAgentGovernanceIndexes(asStoreDb(db))).toHaveLength(
      governanceIndexStatements().length,
    );
  });
});
