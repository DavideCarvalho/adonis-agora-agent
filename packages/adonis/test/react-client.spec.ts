// The React layer an Adonis app imports (`@adonis-agora/agent/react`) against the routes this
// package mounts, over real HTTP: the REAL `@dudousxd/nestjs-agent-react` client, transport and
// `useAgentChat` — nothing on either side is stubbed, so a drift between the wire this package
// writes and the wire that client reads fails here rather than in an app.

import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  type AgentConfig,
  defineTool,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  staticSkillProvider,
} from '../src/index.js';
import {
  type AgentClient,
  AgentHttpError,
  AgentProvider,
  createAgentClient,
  csrfHeaders,
  useAgentChat,
  useThreads,
} from '../src/react/index.js';
import { InMemoryAgentStore } from '../src/testing/index.js';
import { type BootedApp, bootAgentApp } from './helpers/boot-agent-app.js';
import { act, pageDocument as document, renderHook, waitFor } from './helpers/dom.js';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Answers `re: <message>`; a message can be held mid-turn. `refund …` asks for the action tool. */
class ScriptedModel implements ModelProvider {
  private readonly holds = new Map<string, Deferred>();
  private readonly entered = new Map<string, Deferred>();
  private readonly refunded = new Set<string>();

  hold(message: string): void {
    this.holds.set(message, deferred());
  }

  release(message: string): void {
    this.holds.get(message)?.resolve();
  }

  reached(message: string): Promise<void> {
    return this.enteredFor(message).promise;
  }

  private enteredFor(message: string): Deferred {
    let entry = this.entered.get(message);
    if (entry === undefined) {
      entry = deferred();
      this.entered.set(message, entry);
    }
    return entry;
  }

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const last = [...args.messages]
      .reverse()
      .find((entry) => entry.role === 'user' && entry.content);
    const message = last?.content ?? '';
    const usage = { inputTokens: 1, outputTokens: 1 };
    // The loop feeds a tool's result back on a later turn of the same run: ask once, then answer.
    const asked = this.refunded.has(message);
    if (message.startsWith('refund') && !asked) {
      this.refunded.add(message);
      return {
        text: '',
        toolCalls: [{ id: 'call-refund', name: 'refund', input: { id: 7 } }],
        usage,
      };
    }
    this.enteredFor(message).resolve();
    await this.holds.get(message)?.promise;
    const text = asked ? 'Refunded.' : `re: ${message}`;
    await args.sink.write({ t: 'text', v: text });
    return { text, toolCalls: [], usage };
  }
}

const refund = defineTool(
  {
    name: 'refund',
    kind: 'action',
    description: 'refund an order',
    input: z.object({ id: z.number() }),
    roles: ['ADMIN'],
  },
  () => ({ refunded: true }),
);

function setCookie(value: string): void {
  document.cookie = value;
}

/** Every request the React client made, as the server would see it. */
interface Seen {
  method: string;
  path: string;
  headers: Headers;
}

let booted: BootedApp | undefined;
let seen: Seen[] = [];

// A stream lands outside any `act()`; React's reminder about that is noise here, not a finding.
const consoleError = console.error;
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (!String(args[0]).includes('not wrapped in act')) consoleError(...args);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await booted?.close();
  booted = undefined;
  seen = [];
  setCookie('XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT');
});

async function boot(extra: Partial<AgentConfig> = {}) {
  const model = new ScriptedModel();
  const store = new InMemoryAgentStore();
  booted = await bootAgentApp({
    model,
    store: 'memory',
    stores: { memory: async () => store },
    tools: [refund],
    ...extra,
  });
  const url = booted.url;
  const recording: typeof fetch = (input, init) => {
    const target = new URL(String(input));
    seen.push({
      method: init?.method ?? 'GET',
      path: target.pathname + target.search,
      headers: new Headers(init?.headers),
    });
    return fetch(input, init);
  };
  const connection = { baseUrl: url, headers: { 'x-actor-id': 'u1' }, fetch: recording };
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(AgentProvider, connection, children);
  return { model, url, connection, wrapper, client: createAgentClient(connection) };
}

const textOf = (message: { parts: Array<{ type: string; text?: string }> }) =>
  message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');

describe('the connection an Adonis app gets by default', () => {
  it('reads the shield token off the page on every request', async () => {
    setCookie('XSRF-TOKEN=tok%3D1');
    expect(csrfHeaders()).toEqual({ 'X-XSRF-TOKEN': 'tok=1' });
    const { client } = await boot();
    await client.listThreads();
    setCookie('XSRF-TOKEN=rotated');
    await client.listThreads();
    expect(seen.map((request) => request.headers.get('x-xsrf-token'))).toEqual([
      'tok=1',
      'rotated',
    ]);
  });

  it('falls back to the csrf-token meta tag, and sends nothing when the page has neither', async () => {
    expect(csrfHeaders()).toEqual({});
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'csrf-token');
    meta.setAttribute('content', 'from-meta');
    document.head.appendChild(meta);
    try {
      expect(csrfHeaders()).toEqual({ 'X-CSRF-TOKEN': 'from-meta' });
    } finally {
      meta.remove();
    }
  });

  it("lets the app's own getHeaders win over the token", async () => {
    setCookie('XSRF-TOKEN=page');
    const { connection } = await boot();
    const client = createAgentClient({
      ...connection,
      getHeaders: () => ({ 'X-XSRF-TOKEN': 'mine', authorization: 'Bearer t' }),
    });
    await client.listThreads();
    expect(seen[0]?.headers.get('x-xsrf-token')).toBe('mine');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer t');
  });
});

describe('<AgentProvider> + useAgentChat() against the Adonis routes', () => {
  it('streams a turn, adopts the thread it created, and reloads it from history', async () => {
    setCookie('XSRF-TOKEN=tok');
    const { wrapper } = await boot();
    const created: string[] = [];
    const { result } = renderHook(
      () => useAgentChat({ onThreadCreated: (id) => created.push(id) }),
      { wrapper },
    );
    await act(async () => {
      await result.current.sendMessage({ text: 'hello' });
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.messages.map((message) => [message.role, textOf(message)])).toEqual([
      ['user', 'hello'],
      ['assistant', 're: hello'],
    ]);
    expect(created).toHaveLength(1);
    expect(result.current.getThreadId()).toBe(created[0]);
    const chat = seen.find((request) => request.path === '/agent/chat');
    expect(chat?.method).toBe('POST');
    expect(chat?.headers.get('x-xsrf-token')).toBe('tok');

    // A reload: a fresh hook on that thread reads the same transcript back from the server.
    const reloaded = renderHook(() => useAgentChat({ threadId: created[0] as string }), {
      wrapper,
    });
    await waitFor(() => expect(reloaded.result.current.messages).toHaveLength(2));
    expect(reloaded.result.current.messages.map(textOf)).toEqual(['hello', 're: hello']);

    const threads = renderHook(() => useThreads(), { wrapper });
    await waitFor(() => expect(threads.result.current.threads).toHaveLength(1));
    expect(threads.result.current.threads[0]?.id).toBe(created[0]);
  });

  it('queues a message sent while a turn is running, then runs it', async () => {
    const { model, wrapper } = await boot();
    model.hold('first');
    const { result } = renderHook(() => useAgentChat(), { wrapper });
    act(() => {
      void result.current.sendMessage({ text: 'first' });
    });
    await model.reached('first');
    await waitFor(() => expect(result.current.runId).not.toBeNull());

    // The thread is busy: the send is NOT refused — it shows as a waiting bubble.
    await act(async () => {
      await result.current.sendMessage({ text: 'second' });
    });
    await waitFor(() => expect(result.current.queue.items).toHaveLength(1));
    expect(result.current.queue.isSupported).toBe(true);
    expect(result.current.queue.items[0]).toMatchObject({ text: 'second', state: 'queued' });
    expect(result.current.messages.filter((message) => message.role === 'user')).toHaveLength(1);

    model.release('first');
    await waitFor(() =>
      expect(result.current.messages.map(textOf)).toEqual([
        'first',
        're: first',
        'second',
        're: second',
      ]),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.queue.items).toEqual([]);
  });

  it('runs a waiting message now — chat.queue.interrupt(id)', async () => {
    const { model, wrapper } = await boot();
    model.hold('slow');
    const { result } = renderHook(() => useAgentChat(), { wrapper });
    act(() => {
      void result.current.sendMessage({ text: 'slow' });
    });
    await model.reached('slow');
    await waitFor(() => expect(result.current.runId).not.toBeNull());
    await act(async () => {
      await result.current.sendMessage({ text: 'later' });
      await result.current.sendMessage({ text: 'urgent' });
    });
    await waitFor(() => expect(result.current.queue.items).toHaveLength(2));
    const urgent = result.current.queue.items.find((item) => item.text === 'urgent');

    await act(async () => {
      await result.current.queue.interrupt(urgent?.id as string);
    });
    model.release('slow');
    // The running turn was cancelled for it, it ran, and the queue went on to what was waiting.
    await waitFor(() => {
      const texts = result.current.messages.map(textOf);
      expect(texts).toContain('re: urgent');
      expect(texts).toContain('re: later');
    });
    const texts = result.current.messages.map(textOf);
    expect(texts.indexOf('urgent')).toBeLessThan(texts.indexOf('later'));
    expect(result.current.queue.error).toBeNull();
    expect(seen.some((request) => /^\/agent\/queue\/[^/]+\/interrupt$/.test(request.path))).toBe(
      true,
    );
  });

  it('parks an action on an approval and runs it once approved', async () => {
    const { wrapper } = await boot();
    const { result } = renderHook(() => useAgentChat(), { wrapper });
    act(() => {
      void result.current.sendMessage({ text: 'refund 7' });
    });
    const pending = () =>
      result.current.transcript.items
        .flatMap((item) => item.blocks)
        .flatMap((block) => (block.kind === 'tools' ? block.calls : []))
        .find((call) => call.isAwaitingApproval);
    await waitFor(() => expect(pending()).toBeDefined());
    await act(async () => {
      await result.current.approve({ toolCallId: pending()?.toolCallId as string });
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(textOf(result.current.messages.at(-1) as never)).toBe('Refunded.');
  });

  it('edits and resends: truncateFrom drops the message and what followed it', async () => {
    const { wrapper, client } = await boot();
    const { result } = renderHook(() => useAgentChat(), { wrapper });
    await act(async () => {
      await result.current.sendMessage({ text: 'one' });
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.sendMessage({ text: 'two' });
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const threadId = result.current.getThreadId() as string;
    // A reloaded chat, so the messages on screen carry the ids they are stored under.
    const reloaded = renderHook(() => useAgentChat({ threadId }), { wrapper });
    await waitFor(() => expect(reloaded.result.current.messages).toHaveLength(4));
    const second = reloaded.result.current.messages[2];
    await act(async () => {
      await reloaded.result.current.truncateFrom({ messageId: second?.id as string });
    });
    const stored = await client.getThread(threadId);
    expect(stored.messages.map((message) => message.content)).toEqual(['one', 're: one']);
  });
});

describe('the rest of the REST surface the React client calls', () => {
  it('keeps a transient thread out of the list until it is promoted', async () => {
    const { client } = await boot();
    const opened = await client.openChatStream({ body: { message: 'scratch', transient: true } });
    await new Response(opened.body).text();
    const threadId = opened.threadId as string;
    expect(await client.listThreads()).toEqual([]);
    expect(await client.promoteThread(threadId)).toEqual({ ok: true });
    expect((await client.listThreads()).map((thread) => thread.id)).toEqual([threadId]);
  });

  it('lists the skills this caller can invoke, and an empty list when none are configured', async () => {
    const bare = await boot();
    expect(await bare.client.listSkills()).toEqual([]);
    await booted?.close();
    const withSkills = await boot({
      skills: {
        provider: staticSkillProvider([
          { name: 'triage', description: 'Sort an inbox', scope: 'global', body: '…' },
        ]),
      },
    });
    expect(await withSkills.client.listSkills('thr-1')).toEqual([
      { name: 'triage', description: 'Sort an inbox', scope: 'global' },
    ]);
  });

  it('answers the catalog, config and quota routes in the shapes the hooks read', async () => {
    const { client } = await boot();
    const config = await client.getConfig();
    expect(config.attachments).toMatchObject({ enabled: false, upload: null });
    expect(config.quota).toEqual({ enforced: false });
    expect(Array.isArray((await client.getQuota()).windows)).toBe(true);
    expect((await client.listTools()).map((tool) => tool.name)).toContain('refund');
    expect((await client.listAgents()).length).toBeGreaterThan(0);
    expect(await client.listModels()).toMatchObject({ providers: [] });
  });

  it('resumes a run from a cursor, and reads an unknown one as nothing to resume', async () => {
    const { model, client } = await boot();
    model.hold('long');
    const opened = await client.openChatStream({ body: { message: 'long' } });
    await model.reached('long');
    const runId = opened.runId as string;
    const resumed = await (client as AgentClient).resumeChatStream({ runId, after: 1 });
    expect(resumed).not.toBeNull();
    model.release('long');
    const [full, tail] = await Promise.all([
      new Response(opened.body).text(),
      new Response(resumed?.body).text(),
    ]);
    const ids = (body: string) =>
      [...body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    expect(ids(full)[0]).toBe(1);
    expect(ids(tail)).toEqual(ids(full).filter((id) => id > 1));
    expect(await client.resumeChatStream({ runId: 'never-ran' })).toBeNull();
  });

  it('refuses in words the client surfaces', async () => {
    const { client } = await boot();
    const failure = await client.interruptQueuedMessage('nope').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentHttpError);
    expect(failure).toMatchObject({ status: 404, message: 'queued message nope not found' });
  });
});
