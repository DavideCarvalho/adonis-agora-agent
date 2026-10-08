// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ActionProposal } from '../../../src/index.js';
import { useActionProposals } from '../../../src/react/core/approvals/use-action-proposals.js';
import type { AgentBackend } from '../../../src/react/core/backend.js';
import { AgentClient } from '../../../src/react/core/client.js';

const pending = {
  id: 'p',
  threadId: 't',
  originToolCallId: 'c',
  decision: 'pending',
  execution: null,
} as ActionProposal;
afterEach(() => vi.useRealTimers());

function httpError(status: number, message = `Agent request failed → ${status}`) {
  return Object.assign(new Error(message), { status });
}

it.each([404, 405, 501])(
  'treats a %i from the proposals route as unsupported: no more reads, no polling, no error',
  async (status) => {
    vi.useFakeTimers();
    const list = vi.fn(async () => {
      throw httpError(status);
    });
    const backend = { listActionProposals: list } as unknown as AgentBackend;
    const { result, rerender } = renderHook(
      ({ key }) => useActionProposals(backend, 't', vi.fn(), key, 100),
      { initialProps: { key: 'ready:open' } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(result.current.unsupported).toBe(true);
    expect(result.current.error).toBeNull();
    // Nothing asks again: not time, not the stream's status, not focus, not a manual refresh.
    rerender({ key: 'streaming:open' });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      await result.current.refresh();
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(list).toHaveBeenCalledTimes(1);
    // Another chat over the same backend (session) does not ask either.
    const other = renderHook(() => useActionProposals(backend, 'u', vi.fn(), 'ready', 100));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(other.result.current.unsupported).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
  },
);

it("keeps reading a thread the route does not know yet (it is not 'unsupported')", async () => {
  const list = vi.fn(async () => {
    throw httpError(404, 'Unknown thread');
  });
  const backend = { listActionProposals: list } as unknown as AgentBackend;
  const { result } = renderHook(() => useActionProposals(backend, 't', vi.fn(), 'ready', 100));
  await waitFor(() => expect(result.current.error?.message).toBe('Unknown thread'));
  expect(result.current.unsupported).toBe(false);
  await act(async () => {
    await result.current.refresh();
  });
  expect(list).toHaveBeenCalledTimes(2);
});

it('backs off while transient errors interrupt polling, and resumes the pace on success', async () => {
  vi.useFakeTimers();
  let failing = false;
  const list = vi.fn(async () => {
    if (failing) throw httpError(503);
    return [pending];
  });
  const backend = { listActionProposals: list } as unknown as AgentBackend;
  const { result } = renderHook(() => useActionProposals(backend, 't', vi.fn(), 'ready', 100));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(list).toHaveBeenCalledTimes(1);
  failing = true;
  // Poll at 100 ms fails; the next waits 200, then 400, then 800.
  const callsAt = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    return list.mock.calls.length;
  };
  expect(await callsAt(100)).toBe(2);
  expect(await callsAt(199)).toBe(2);
  expect(await callsAt(1)).toBe(3);
  expect(await callsAt(399)).toBe(3);
  expect(await callsAt(1)).toBe(4);
  expect(result.current.error).not.toBeNull();
  expect(result.current.unsupported).toBe(false);
  failing = false;
  expect(await callsAt(800)).toBe(5);
  expect(result.current.error).toBeNull();
  expect(await callsAt(100)).toBe(6);
});

it("stops after the real client's first 404 from a server that mounts no proposals route", async () => {
  vi.useFakeTimers();
  const onHttpError = vi.fn();
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          message: 'Cannot GET /agent/threads/t/action-proposals',
          error: 'Not Found',
          statusCode: 404,
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
  );
  const client = new AgentClient({ fetch, onHttpError });
  const { result, rerender } = renderHook(
    ({ key }) => useActionProposals(client, 't', vi.fn(), key, 1000),
    { initialProps: { key: 'ready:open' } },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  for (const key of ['submitted:open', 'streaming:open', 'ready:open']) {
    rerender({ key });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(1000);
    });
  }
  expect(result.current.unsupported).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  // Told once — a listener that logs logs once.
  expect(onHttpError).toHaveBeenCalledTimes(1);
});
