import { describe, expect, it, vi } from 'vitest';
import { AgentApiError, AgentClient } from './agent-client.js';
import type { ModelSpendRow } from './types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AgentClient', () => {
  it('hits the governance spend/model route with from/to and same-origin credentials', async () => {
    const rows: ModelSpendRow[] = [
      { modelId: 'gpt-4o', requests: 1, inputTokens: 10, outputTokens: 5, costUsd: 0.5 },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(rows));
    const client = new AgentClient({ baseUrl: '/agent', fetch: fetchMock });

    const result = await client.spendByModel({ fromDay: '2026-03-01', toDay: '2026-03-07' });

    expect(result).toEqual(rows);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/agent/governance/spend/model?from=2026-03-01&to=2026-03-07');
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin' });
  });

  it('maps each read to its real route', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse([])));
    const client = new AgentClient({ baseUrl: '/agent', fetch: fetchMock, limit: 10 });
    const range = { fromDay: '2026-03-01', toDay: '2026-03-01' };

    await client.spendByActor(range);
    await client.usageTrend(range);
    await client.recentToolCalls();
    await client.recentThreads();
    fetchMock.mockResolvedValueOnce(jsonResponse({ usedTokens: 0 }));
    await client.quotaToday();

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      '/agent/governance/spend/actor?from=2026-03-01&to=2026-03-01',
      '/agent/governance/usage/trend?from=2026-03-01&to=2026-03-01',
      '/agent/governance/tool-calls/recent?limit=10',
      '/agent/governance/threads/recent?limit=10',
      '/agent/quota/today',
    ]);
  });

  it('maps the run-lifecycle reads to their real routes with filters + cursor + limit', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse([])));
    const client = new AgentClient({ baseUrl: '/agent', fetch: fetchMock, limit: 25 });

    fetchMock.mockResolvedValueOnce(jsonResponse({ runs: [], nextCursor: null }));
    await client.listRuns({ status: 'failed', agent: 'support', actor: 'user:alice' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ runs: [], nextCursor: null }));
    await client.listRuns({ cursor: 'c2', limit: 10 });
    fetchMock.mockResolvedValueOnce(jsonResponse(null));
    await client.runDetail('run/1 with space');
    await client.pendingApprovals({ actor: 'user:bob' });
    await client.perToolStats({ from: '2026-03-01', to: '2026-03-07' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ runs: 0 }));
    await client.runReliability({ from: '2026-03-01' });

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      '/agent/governance/runs?limit=25&actor=user%3Aalice&agent=support&status=failed',
      '/agent/governance/runs?limit=10&cursor=c2',
      '/agent/governance/runs/run%2F1%20with%20space',
      '/agent/governance/approvals/pending?limit=25&actor=user%3Abob',
      '/agent/governance/tools/stats?from=2026-03-01&to=2026-03-07',
      '/agent/governance/reliability?from=2026-03-01',
    ]);
  });

  it('posts approve/reject to the EXISTING tool-call routes with the runId/toolCallId body', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
    const client = new AgentClient({ baseUrl: '/agent', fetch: fetchMock });

    await client.approveToolCall('run-1', 'call-9');
    await client.rejectToolCall('run-1', 'call-9', 'not allowed');

    const [approveUrl, approveInit] = fetchMock.mock.calls[0]!;
    expect(approveUrl).toBe('/agent/tool-call/approve');
    expect(approveInit).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(JSON.parse((approveInit as RequestInit).body as string)).toEqual({
      runId: 'run-1',
      toolCallId: 'call-9',
    });

    const [rejectUrl, rejectInit] = fetchMock.mock.calls[1]!;
    expect(rejectUrl).toBe('/agent/tool-call/reject');
    expect(JSON.parse((rejectInit as RequestInit).body as string)).toEqual({
      runId: 'run-1',
      toolCallId: 'call-9',
      reason: 'not allowed',
    });
  });

  it('maps thread detail + pricing reads and the pricing upsert to their real routes', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(null)));
    const client = new AgentClient({ baseUrl: '/agent', fetch: fetchMock });

    await client.threadDetail('th/1 with space');
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await client.pricing();
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await client.upsertPrice({ modelId: 'gpt-4o', inputPricePer1m: 3, outputPricePer1m: 15 });

    const calls = fetchMock.mock.calls;
    expect(calls[0]![0]).toBe('/agent/governance/threads/th%2F1%20with%20space');
    expect(calls[1]![0]).toBe('/agent/governance/pricing');
    expect(calls[2]![0]).toBe('/agent/governance/pricing');
    expect(calls[2]![1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse((calls[2]![1] as RequestInit).body as string)).toEqual({
      modelId: 'gpt-4o',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
    });
  });

  it('throws AgentApiError carrying the status on a non-2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 401));
    const client = new AgentClient({ baseUrl: '/agent', fetch: fetchMock });

    await expect(
      client.spendByModel({ fromDay: '2026-03-01', toDay: '2026-03-01' }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      client.spendByModel({ fromDay: '2026-03-01', toDay: '2026-03-01' }),
    ).rejects.toBeInstanceOf(AgentApiError);
  });
});
