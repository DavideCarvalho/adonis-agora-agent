// @vitest-environment jsdom
import { render, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend } from '../../src/react/core/backend.js';
import { useAgents } from '../../src/react/core/catalog/use-agents.js';
import { useModels } from '../../src/react/core/catalog/use-models.js';
import { AgentClient } from '../../src/react/core/client.js';
import { useAmbientRenderUi } from '../../src/react/core/components/ambient-ui.js';
import { useMessageFeedback } from '../../src/react/core/feedback/use-message-feedback.js';
import { useGenuiProvider } from '../../src/react/core/genui/generative-ui.js';
import { useToolCatalog } from '../../src/react/core/presentation/use-tool-catalog.js';
import { AgentProvider, useAgentBackend } from '../../src/react/core/provider.js';
import { useQuota } from '../../src/react/core/quota/use-quota.js';
import { useThreads } from '../../src/react/core/threads/use-threads.js';
import { useAgentChat } from '../../src/react/core/use-agent-chat.js';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeBackend(): AgentBackend {
  return {
    openChatStream: vi.fn(),
    resumeChatStream: async () => null,
    cancelStream: async () => ({}),
    listThreads: vi.fn(async () => [
      { id: 't1', title: 'One', createdAt: '', updatedAt: '' } as never,
    ]),
    getThread: vi.fn(),
    updateThread: vi.fn(),
    deleteThread: vi.fn(),
    listModels: vi.fn(async () => ({ default: 'fast', providers: [] })),
    listAgents: vi.fn(async () => [{ name: 'default', description: '', isDefault: true as const }]),
    getQuota: vi.fn(async () => ({ windows: [] })),
    listTools: vi.fn(async () => []),
  };
}

describe('AgentProvider', () => {
  it('builds one AgentClient from the connection props and hands it to every hook', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json([]));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AgentProvider
        baseUrl="https://api.example.com/"
        path="/api/agent/"
        credentials="include"
        getHeaders={() => ({ 'x-csrf': 'tok' })}
        fetch={fetchMock as unknown as typeof fetch}
      >
        {children}
      </AgentProvider>
    );
    const { result } = renderHook(
      () => ({ chat: useAgentChat(), threads: useThreads(), backend: useAgentBackend() }),
      { wrapper },
    );
    expect(result.current.backend).toBeInstanceOf(AgentClient);
    expect(result.current.chat.backend).toBe(result.current.backend);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/threads'))).toBe(true),
    );
    const [url, init] = fetchMock.mock.calls.find(([candidate]) =>
      String(candidate).endsWith('/threads'),
    ) as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/agent/threads');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['x-csrf']).toBe('tok');
  });

  it('passes a custom backend through, and every hook falls back to it', async () => {
    const backend = fakeBackend();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AgentProvider backend={backend}>{children}</AgentProvider>
    );
    const { result } = renderHook(
      () => ({
        chat: useAgentChat(),
        threads: useThreads(),
        models: useModels(),
        agents: useAgents(),
        quota: useQuota(),
        tools: useToolCatalog(),
        feedback: useMessageFeedback(),
      }),
      { wrapper },
    );
    expect(result.current.chat.backend).toBe(backend);
    await waitFor(() => expect(result.current.threads.threads).toHaveLength(1));
    await waitFor(() => expect(result.current.models.defaultModel).toBe('fast'));
    await waitFor(() => expect(result.current.agents.defaultAgent).toBe('default'));
    expect(backend.getQuota).toHaveBeenCalled();
    expect(backend.listTools).toHaveBeenCalled();
  });

  it('an explicit backend on a hook wins over the context', async () => {
    const context = fakeBackend();
    const own = fakeBackend();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AgentProvider backend={context}>{children}</AgentProvider>
    );
    renderHook(() => useThreads({ backend: own }), { wrapper });
    await waitFor(() => expect(own.listThreads).toHaveBeenCalled());
    expect(context.listThreads).not.toHaveBeenCalled();
  });

  it('attachments.upload replaces how the built-in client uploads', async () => {
    const upload = vi.fn(async () => ({
      mediaId: 'm1',
      url: 'u',
      contentType: 'image/png',
      name: 'a.png',
    }));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AgentProvider path="x" attachments={{ upload }}>
        {children}
      </AgentProvider>
    );
    const { result } = renderHook(() => useAgentBackend(), { wrapper });
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    await result.current.uploadAttachment?.(file);
    expect(upload).toHaveBeenCalledTimes(1);
    const connection = (upload.mock.calls[0] as unknown[])[2] as { baseUrl: string; path: string };
    expect(connection.path).toBe('/x');
    expect(connection.baseUrl).toBe('');
  });

  it('genui sets the generative UI provider up in the same element', () => {
    const registry = { Card: () => null };
    let seen: unknown = null;
    let ambient: unknown = null;
    function Probe() {
      seen = useGenuiProvider();
      ambient = useAmbientRenderUi();
      return null;
    }
    render(
      <AgentProvider genui={{ registry }}>
        <Probe />
      </AgentProvider>,
    );
    expect((seen as { registry: unknown }).registry).toBe(registry);
    expect(typeof ambient).toBe('function');
  });
});

describe('without a provider', () => {
  it('every hook shares one same-origin client on `/agent`', async () => {
    const fetchMock = vi.fn(async () => json([]));
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { result } = renderHook(() => ({
        chat: useAgentChat(),
        backend: useAgentBackend(),
        threads: useThreads(),
      }));
      expect(result.current.chat.backend).toBe(result.current.backend);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const urls = fetchMock.mock.calls.map((call) => (call as unknown as [string])[0]);
      await waitFor(() => expect(urls).toContain('/agent/threads'));
      expect(urls.every((url) => url.startsWith('/agent/'))).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});
