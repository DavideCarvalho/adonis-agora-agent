import { afterEach, describe, expect, it } from 'vitest';
import type {
  ActorSpendRow,
  AgentGovernanceQueries,
  CursorPageResponse,
  ListRunsFilter,
  ListRunsResult,
  ModelSpendRow,
  PendingApprovalRow,
  PendingApprovalsFilter,
  PerToolStatRow,
  RunDetail,
  RunReliability,
  ThreadActivityRow,
  ToolCallActivityRow,
  UsageTrendPoint,
} from '../src/index.js';
import { AgentService } from '../src/index.js';
import {
  applyListFilter,
  assertFixedSort,
  InvalidColumnFilterError,
  parseListWindow,
  RunsFilter,
  windowFetchSize,
  windowPage,
} from '../src/list-api.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import type { InMemoryAgentStore } from '../src/testing/in-memory-store.js';
import { type BootedApp, bootAgentApp } from './helpers/boot-agent-app.js';

const SIZES = { defaultSize: 3, maxSize: 10 };
const ROWS = Array.from({ length: 7 }, (_, index) => index);

/** Read one page of `ROWS` the way a windowed route does. */
function readPage(qs: Record<string, unknown>) {
  const window = parseListWindow(qs, SIZES);
  return windowPage(ROWS.slice(0, windowFetchSize(window)), window);
}

describe('window paging', () => {
  it('walks forward to the end and back to the start with opaque cursors', () => {
    const first = readPage({});
    expect(first.data).toEqual([0, 1, 2]);
    expect(first.meta).toMatchObject({ hasNext: true, hasPrev: false, prevCursor: null });

    const second = readPage({ after: first.meta.nextCursor });
    expect(second.data).toEqual([3, 4, 5]);
    expect(second.meta).toMatchObject({ hasNext: true, hasPrev: true });

    const last = readPage({ after: second.meta.nextCursor });
    expect(last.data).toEqual([6]);
    expect(last.meta).toMatchObject({ hasNext: false, nextCursor: null, hasPrev: true });

    const back = readPage({ before: last.meta.prevCursor });
    expect(back.data).toEqual([3, 4, 5]);
    const start = readPage({ before: back.meta.prevCursor });
    expect(start.data).toEqual([0, 1, 2]);
    expect(start.meta).toMatchObject({ hasPrev: false, prevCursor: null });
  });

  it('takes first/last as the page size, capped', () => {
    expect(readPage({ first: '2' }).data).toEqual([0, 1]);
    expect(readPage({ first: '500' }).data).toEqual(ROWS);
  });

  it('refuses a cursor it did not mint', () => {
    expect(() => parseListWindow({ after: 'not-a-cursor' }, SIZES)).toThrow(
      InvalidColumnFilterError,
    );
  });
});

describe('fixed sort', () => {
  it('accepts no sort or the one order, and refuses anything else', () => {
    expect(() => assertFixedSort(undefined, '-createdAt')).not.toThrow();
    expect(() => assertFixedSort('-createdAt', '-createdAt')).not.toThrow();
    expect(() => assertFixedSort('createdAt', '-createdAt')).toThrow(InvalidColumnFilterError);
    expect(() => assertFixedSort('name', '-createdAt')).toThrow(InvalidColumnFilterError);
    expect(() => assertFixedSort('-createdAt,name', '-createdAt')).toThrow(
      InvalidColumnFilterError,
    );
  });
});

describe('RunsFilter', () => {
  const filter = (qs: Record<string, unknown>) => applyListFilter({}, RunsFilter, qs);

  it('dispatches each field to the read-model filter', async () => {
    expect(
      await filter({
        filter: {
          actor: 'u:1',
          agent: 'support',
          status: 'failed',
          startedAt: { between: '2026-11-01,2026-11-13' },
        },
      }),
    ).toEqual({
      actor: 'u:1',
      agent: 'support',
      status: 'failed',
      from: '2026-11-01',
      to: '2026-11-13',
    });
    expect(await filter({ filter: { startedAt: { gte: '2026-11-01' } } })).toEqual({
      from: '2026-11-01',
    });
  });

  it('refuses unknown fields, operators and values', async () => {
    await expect(filter({ filter: { model: 'x' } })).rejects.toThrow(InvalidColumnFilterError);
    await expect(filter({ filter: { status: { contains: 'fail' } } })).rejects.toThrow(
      InvalidColumnFilterError,
    );
    await expect(filter({ filter: { status: 'exploded' } })).rejects.toThrow(
      InvalidColumnFilterError,
    );
    await expect(filter({ filter: { startedAt: { gte: 'yesterday' } } })).rejects.toThrow(
      InvalidColumnFilterError,
    );
  });
});

// ── Over HTTP ──────────────────────────────────────────────────────────────────────────────────

class RecordingGovernance implements AgentGovernanceQueries {
  runFilters: ListRunsFilter[] = [];
  approvalFilters: PendingApprovalsFilter[] = [];

  async spendByModel(): Promise<ModelSpendRow[]> {
    return [];
  }
  async spendByActor(): Promise<ActorSpendRow[]> {
    return [];
  }
  async usageTrend(): Promise<UsageTrendPoint[]> {
    return [];
  }
  async recentToolCalls(limit: number): Promise<ToolCallActivityRow[]> {
    return Array.from({ length: 5 }, (_, index) => ({
      toolCallId: `call-${index}`,
      toolName: 'search',
      toolType: 'function',
      status: 'completed',
      threadId: 't1',
      createdAt: new Date(Date.UTC(2026, 10, 13, 12, 0, 59 - index)).toISOString(),
    })).slice(0, limit);
  }
  async recentThreads(): Promise<ThreadActivityRow[]> {
    return [];
  }
  async listRuns(filter: ListRunsFilter = {}): Promise<ListRunsResult> {
    this.runFilters.push(filter);
    return {
      items: [],
      nextCursor: filter.after === undefined ? 'store-cursor' : null,
      prevCursor: null,
      hasNext: filter.after === undefined,
      hasPrev: false,
    };
  }
  async runDetail(): Promise<RunDetail | null> {
    return null;
  }
  async pendingApprovals(filter: PendingApprovalsFilter = {}): Promise<PendingApprovalRow[]> {
    this.approvalFilters.push(filter);
    return [];
  }
  async perToolStats(): Promise<PerToolStatRow[]> {
    return [];
  }
  async runReliability(): Promise<RunReliability> {
    return {
      runs: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      running: 0,
      successRate: 0,
      failureRate: 0,
      cancelRate: 0,
      avgDurationMs: null,
    };
  }
}

let booted: BootedApp | null = null;
afterEach(async () => {
  await booted?.close();
  booted = null;
});

async function boot(governance = new RecordingGovernance()) {
  booted = await bootAgentApp({
    model: new FakeModelProvider(() => ({ text: 'ok' })),
    governanceQueries: governance,
  });
  return { url: booted.url, governance };
}

const as = (id = 'admin-1') => ({ headers: { 'x-actor-id': id } });

async function get<T>(url: string, actor?: string): Promise<{ status: number; body: T }> {
  const response = await fetch(url, as(actor));
  return { status: response.status, body: (await response.json()) as T };
}

describe('GET /agent/governance/runs', () => {
  it('hands filter[...] to the read-model and answers { data, meta }', async () => {
    const { url, governance } = await boot();
    const qs = new URLSearchParams({
      'filter[actor]': 'u:1',
      'filter[status]': 'failed',
      'filter[startedAt][gte]': '2026-11-01',
      first: '20',
    });
    const first = await get<CursorPageResponse<unknown>>(`${url}/agent/governance/runs?${qs}`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      data: [],
      meta: { nextCursor: 'store-cursor', prevCursor: null, hasNext: true, hasPrev: false },
    });
    expect(governance.runFilters[0]).toEqual({
      actor: 'u:1',
      status: 'failed',
      from: '2026-11-01',
      first: 20,
    });

    const next = await get<CursorPageResponse<unknown>>(
      `${url}/agent/governance/runs?after=store-cursor`,
    );
    expect(next.body.meta.nextCursor).toBeNull();
    expect(governance.runFilters[1]).toEqual({ after: 'store-cursor', first: 50 });
  });

  it('answers 400 for an unknown filter field, an unknown sort, the reverse order and before', async () => {
    const { url, governance } = await boot();
    for (const query of [
      'filter[model]=x',
      'sort=costUsd',
      'sort=startedAt',
      'before=abc',
      'filter[status]=exploded',
    ]) {
      const response = await get<{ message: string }>(`${url}/agent/governance/runs?${query}`);
      expect(response.status, query).toBe(400);
      expect(response.body.message, query).toEqual(expect.any(String));
    }
    expect(governance.runFilters).toEqual([]);
  });
});

describe('GET /agent/governance/tool-calls/recent', () => {
  it('walks the feed forward and back', async () => {
    const { url } = await boot();
    const base = `${url}/agent/governance/tool-calls/recent`;
    type Page = CursorPageResponse<ToolCallActivityRow>;
    const ids = (page: Page) => page.data.map((row) => row.toolCallId);

    const first = (await get<Page>(`${base}?first=2`)).body;
    expect(ids(first)).toEqual(['call-0', 'call-1']);
    const second = (
      await get<Page>(`${base}?first=2&after=${encodeURIComponent(first.meta.nextCursor ?? '')}`)
    ).body;
    expect(ids(second)).toEqual(['call-2', 'call-3']);
    const third = (
      await get<Page>(`${base}?first=2&after=${encodeURIComponent(second.meta.nextCursor ?? '')}`)
    ).body;
    expect(ids(third)).toEqual(['call-4']);
    expect(third.meta.hasNext).toBe(false);
    const back = (
      await get<Page>(`${base}?last=2&before=${encodeURIComponent(third.meta.prevCursor ?? '')}`)
    ).body;
    expect(ids(back)).toEqual(['call-2', 'call-3']);
  });

  it('answers 400 for any filter, another sort or a forged cursor', async () => {
    const { url } = await boot();
    const base = `${url}/agent/governance/tool-calls/recent`;
    for (const query of ['filter[toolName]=search', 'sort=createdAt', 'after=forged']) {
      expect((await get(`${base}?${query}`)).status, query).toBe(400);
    }
  });
});

describe('GET /agent/governance/approvals/pending', () => {
  it('filters by actor and refuses other fields', async () => {
    const { url, governance } = await boot();
    const base = `${url}/agent/governance/approvals/pending`;
    const page = await get<CursorPageResponse<unknown>>(`${base}?filter[actor]=u:9&first=10`);
    expect(page.status).toBe(200);
    expect(page.body.data).toEqual([]);
    expect(governance.approvalFilters[0]).toEqual({ actor: 'u:9', limit: 11 });
    expect((await get(`${base}?filter[toolName]=refund`)).status).toBe(400);
  });
});

describe('GET /agent/threads', () => {
  it('pages the caller’s threads, newest first', async () => {
    const { url } = await boot();
    const service = await booted?.app.container.make(AgentService);
    const store = (service as unknown as { store: InMemoryAgentStore }).store;
    for (const title of ['a', 'b', 'c']) {
      await store.createThread({ actor: { id: 'u1' }, persona: 'default', title });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    type Page = CursorPageResponse<{ title: string }>;
    const first = (await get<Page>(`${url}/agent/threads?first=2`, 'u1')).body;
    expect(first.data.map((thread) => thread.title)).toEqual(['c', 'b']);
    expect(first.meta.hasNext).toBe(true);
    const rest = (
      await get<Page>(
        `${url}/agent/threads?first=2&after=${encodeURIComponent(first.meta.nextCursor ?? '')}`,
        'u1',
      )
    ).body;
    expect(rest.data.map((thread) => thread.title)).toEqual(['a']);
    expect(rest.meta).toMatchObject({ hasNext: false, hasPrev: true });
    expect((await get(`${url}/agent/threads?filter[title]=a`, 'u1')).status).toBe(400);
    expect((await get(`${url}/agent/threads?sort=title`, 'u1')).status).toBe(400);
  });
});
