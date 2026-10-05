// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentClient } from '../../src/react/core/client.js';
import { useAgentChat } from '../../src/react/core/use-agent-chat.js';

function jsonResponse(status = 200): Response {
  return new Response('{"ok":true}', {
    status,
    statusText: status === 200 ? 'OK' : 'Forbidden',
  });
}

describe('useAgentChat — settling a question set', () => {
  it('answers and skips by tool-call id, the way approve and reject do', async () => {
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse();
    });

    const { result } = renderHook(() =>
      useAgentChat({ threadId: 'thr-1', backend: new AgentClient({ fetch: fetchMock }) }),
    );
    const settles = () => calls.filter((call) => call.url.includes('/tool-call/'));

    await act(async () => {
      await result.current.answer({ toolCallId: 'intake-run-1', answers: { scope: ['file'] } });
      await result.current.answer({ toolCallId: 'intake-run-2' });
      await result.current.skip({ toolCallId: 'intake-run-3' });
    });

    expect(settles().map((call) => call.url)).toEqual([
      '/agent/tool-call/answer',
      '/agent/tool-call/answer',
      '/agent/tool-call/skip',
    ]);
    expect(JSON.parse(String(settles()[0]?.init?.body))).toEqual({
      toolCallId: 'intake-run-1',
      answers: { scope: ['file'] },
    });
    expect(JSON.parse(String(settles()[1]?.init?.body))).toEqual({ toolCallId: 'intake-run-2' });
    expect(JSON.parse(String(settles()[2]?.init?.body))).toEqual({ toolCallId: 'intake-run-3' });
  });

  it('names the surface an answer or a skip came through, like approve does', async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes('/tool-call/')) bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse();
    });
    const { result } = renderHook(() =>
      useAgentChat({ threadId: 'thr-1', backend: new AgentClient({ fetch: fetchMock }) }),
    );

    await act(async () => {
      await result.current.answer({ toolCallId: 'q1', answers: { a: ['x'] }, via: 'voice' });
      await result.current.skip({ toolCallId: 'q2', via: 'voice' });
    });

    expect(bodies).toEqual([
      { toolCallId: 'q1', answers: { a: ['x'] }, via: 'voice' },
      { toolCallId: 'q2', via: 'voice' },
    ]);
  });

  it('lets a refusal reach the caller rather than resolving as if it worked', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(403));
    const { result } = renderHook(() =>
      useAgentChat({ threadId: 'thr-1', backend: new AgentClient({ fetch: fetchMock }) }),
    );

    await expect(result.current.answer({ toolCallId: 'not-mine' })).rejects.toMatchObject({
      status: 403,
    });
  });
});
