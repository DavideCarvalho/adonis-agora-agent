// Sending while a turn is still running queues the message on the thread, server-side, and the next
// queued message starts as soon as the running turn settles — like typing ahead in a chat app.
// A port of `@dudousxd/nestjs-agent`'s `chat-queue.e2e.spec.ts` (inline runner, real HTTP).
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentService,
  ChatQueueError,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  type QuotaProvider,
  type QuotaReport,
} from '../src/index.js';
import { InMemoryAgentStore } from '../src/testing/index.js';
import { type BootedApp, bootAgentApp } from './helpers/boot-agent-app.js';

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

/** Answers `re: <message>`; a message can be held mid-turn, or made to fail. */
class ScriptedModel implements ModelProvider {
  readonly seen: string[] = [];
  readonly failing = new Set<string>();
  private readonly holds = new Map<string, Deferred>();
  private readonly entered = new Map<string, Deferred>();

  hold(message: string): void {
    this.holds.set(message, deferred());
  }

  release(message: string): void {
    this.holds.get(message)?.resolve();
  }

  /** Resolves once a turn answering `message` has reached the model. */
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
    const last = [...args.messages].reverse().find((message) => message.role === 'user');
    const message = last?.content ?? '';
    this.seen.push(message);
    this.enteredFor(message).resolve();
    await this.holds.get(message)?.promise;
    if (this.failing.has(message)) {
      throw new Error(`model failed on ${message}`);
    }
    const text = `re: ${message}`;
    await args.sink.write({ t: 'text', v: text });
    return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

class SwitchableQuota implements QuotaProvider {
  blocked = false;
  async report(): Promise<QuotaReport> {
    return {
      windows: [{ period: 'day', usedTokens: 0, usedUsd: 0 }],
      ...(this.blocked
        ? { blocked: { period: 'day' as const, reason: 'Daily budget spent' } }
        : {}),
    };
  }
}

let booted: BootedApp | undefined;

async function boot(options: { quota?: QuotaProvider } = {}) {
  const model = new ScriptedModel();
  const store = new InMemoryAgentStore();
  booted = await bootAgentApp({
    model,
    store: 'memory',
    stores: { memory: async () => store },
    ...(options.quota !== undefined ? { quota: options.quota } : {}),
  });
  const thread = await store.createThread({ actor: { id: 'u1' }, persona: 'default' });
  return {
    model,
    store,
    threadId: thread.id,
    url: booted.url,
    service: await booted.app.container.make(AgentService),
  };
}

afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

const headersOf = (actor: string) => ({ 'content-type': 'application/json', 'x-actor-id': actor });

function send(url: string, body: Record<string, unknown>, actor = 'u1'): Promise<Response> {
  return fetch(`${url}/agent/chat`, {
    method: 'POST',
    headers: headersOf(actor),
    body: JSON.stringify(body),
  });
}

function call(url: string, method: string, path: string, body?: unknown, actor = 'u1') {
  return fetch(`${url}/agent/${path}`, {
    method,
    headers: headersOf(actor),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

type Json = Record<string, any>;
const json = async (response: Response | Promise<Response>) =>
  (await (await response).json()) as Json;

/** Every `data:` event of an SSE body, parsed, plus the named terminal. */
function eventsOf(text: string): { events: Json[]; terminal?: string } {
  const events: Json[] = [];
  let terminal: string | undefined;
  for (const block of text.split('\n\n')) {
    let name: string | undefined;
    let data: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) name = line.slice(7);
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (name === 'done' || name === 'error') terminal = name;
    else if (name === undefined && data !== undefined) events.push(JSON.parse(data));
  }
  return terminal !== undefined ? { events, terminal } : { events };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The thread's transcript as `role: content` lines, once no turn is running on it. */
async function settledTranscript(store: InMemoryAgentStore, threadId: string, count: number) {
  const thread = await until(
    () => store.getThread(threadId),
    (value) =>
      value !== null &&
      (value.activeRunId ?? null) === null &&
      value.messages.filter((message) => message.role === 'assistant').length >= count,
  );
  return thread?.messages.map((message) => `${message.role}: ${message.content}`) ?? [];
}

describe('chat message queue', () => {
  it('queues a send made while a turn runs, and starts it when that turn completes', async () => {
    const { model, store, threadId, url } = await boot();
    model.hold('first');
    const first = send(url, { threadId, message: 'first' }).then((res) => res.text());
    await model.reached('first');

    const queuedResponse = await send(url, { threadId, message: 'second' });
    expect(queuedResponse.status).toBe(202);
    const queued = await json(queuedResponse);
    expect(queued).toMatchObject({
      queued: true,
      threadId,
      position: 0,
      queue: { items: [{ content: 'second' }], paused: null },
    });
    const messageId = queued.messageId as string;

    expect(await json(call(url, 'GET', `threads/${threadId}/queue`))).toMatchObject({
      items: [{ id: messageId, content: 'second' }],
    });

    model.release('first');
    const { events, terminal } = eventsOf(await first);
    expect(terminal).toBe('done');
    const queueFrames = events.filter((event) => event.kind === 'queue');
    // Announced when it was queued, then handed the thread just before the stream ended.
    expect(queueFrames[0]).toMatchObject({ queue: { items: [{ id: messageId }] } });
    expect(queueFrames.at(-1)).toEqual({
      kind: 'queue',
      queue: { items: [], paused: null },
      started: { messageId, runId: messageId },
    });
    expect(events.at(-1)).toBe(queueFrames.at(-1));

    expect(await settledTranscript(store, threadId, 2)).toEqual([
      'user: first',
      'assistant: re: first',
      'user: second',
      'assistant: re: second',
    ]);
    expect(await json(call(url, 'GET', `threads/${threadId}`))).toMatchObject({
      activeRunId: null,
      queue: { items: [], paused: null },
    });
  });

  it('drains several queued messages in order, one turn at a time', async () => {
    const { model, store, threadId, url } = await boot();
    model.hold('first');
    const first = send(url, { threadId, message: 'first' }).then((res) => res.text());
    await model.reached('first');
    expect((await json(send(url, { threadId, message: 'a' }))).position).toBe(0);
    expect((await json(send(url, { threadId, message: 'b' }))).position).toBe(1);

    model.release('first');
    await first;
    expect(await settledTranscript(store, threadId, 3)).toEqual([
      'user: first',
      'assistant: re: first',
      'user: a',
      'assistant: re: a',
      'user: b',
      'assistant: re: b',
    ]);
  });

  it('starts at once when nothing is running', async () => {
    const { threadId, url, store } = await boot();
    const res = await send(url, { threadId, message: 'hi', mode: 'queue' });
    // Queue mode always answers 202; with an idle thread it has already started.
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body.runId).toBe(body.messageId);
    await settledTranscript(store, threadId, 1);

    const auto = await send(url, { threadId, message: 'again' });
    expect(auto.status).toBe(200);
    expect(auto.headers.get('content-type')).toContain('text/event-stream');
    await auto.text();
  });

  it('pauses behind a failed turn, keeping the queue, and resumes on request', async () => {
    const { model, store, threadId, url } = await boot();
    model.hold('first');
    model.failing.add('first');
    const first = send(url, { threadId, message: 'first' }).then((res) => res.text());
    await model.reached('first');
    await send(url, { threadId, message: 'second' });

    model.release('first');
    const { events, terminal } = eventsOf(await first);
    expect(terminal).toBe('error');
    expect(events.at(-1)).toMatchObject({
      kind: 'queue',
      queue: { items: [{ content: 'second' }], paused: { reason: 'run_failed' } },
    });
    expect(events.at(-1)?.started).toBeUndefined();

    const paused = await json(call(url, 'GET', `threads/${threadId}/queue`));
    expect(paused.paused).toMatchObject({ reason: 'run_failed', message: 'model failed on first' });
    expect(model.seen).not.toContain('second');

    const resumedResponse = await call(url, 'POST', `threads/${threadId}/queue/resume`);
    expect(resumedResponse.status).toBe(200);
    const resumed = await json(resumedResponse);
    expect(resumed).toMatchObject({ items: [], paused: null });
    expect(typeof resumed.runId).toBe('string');
    const transcript = await settledTranscript(store, threadId, 1);
    expect(transcript.slice(-2)).toEqual(['user: second', 'assistant: re: second']);
  });

  it('pauses behind a Stop', async () => {
    const { model, store, threadId, url } = await boot();
    model.hold('first');
    const first = send(url, { threadId, message: 'first' }).then((res) => res.text());
    await model.reached('first');
    await send(url, { threadId, message: 'second' });
    const runId = (await store.activeRunForThread(threadId)) as string;

    await call(url, 'POST', `chat/${runId}/cancel`);
    const { events, terminal } = eventsOf(await first);
    // The stream ends at the Stop: the queue's pause, then `cancelled`.
    expect(terminal).toBe('done');
    expect(events.at(-1)).toEqual({ kind: 'cancelled' });
    expect(events.filter((event) => event.kind === 'queue').at(-1)).toMatchObject({
      queue: { paused: { reason: 'cancelled' } },
    });
    expect(await json(call(url, 'GET', `threads/${threadId}/queue`))).toMatchObject({
      items: [{ content: 'second' }],
      paused: { reason: 'cancelled' },
    });
    // The stopped turn's model call was still answering: it unwinds without an answer in the thread.
    model.release('first');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(model.seen).not.toContain('second');
    const thread = await store.getThread(threadId);
    expect(thread?.activeRunId ?? null).toBeNull();
    expect(thread?.messages.map((message) => message.role)).toEqual(['user']);
  });

  it('an interrupt cancels the running turn and runs next, ahead of the queue', async () => {
    const { model, store, threadId, url } = await boot();
    model.hold('first');
    const first = send(url, { threadId, message: 'first' }).then((res) => res.text());
    await model.reached('first');
    const runId = (await store.activeRunForThread(threadId)) as string;
    await send(url, { threadId, message: 'later' });

    const interruptResponse = await send(url, { threadId, message: 'now', mode: 'interrupt' });
    expect(interruptResponse.status).toBe(202);
    const interrupt = await json(interruptResponse);
    expect(interrupt).toMatchObject({ interrupting: runId, position: 0 });

    const { events } = eventsOf(await first);
    expect(events.filter((event) => event.kind === 'queue').at(-1)).toMatchObject({
      started: { messageId: interrupt.messageId },
      queue: { items: [{ content: 'later' }], paused: null },
    });
    await until(
      async () => model.seen,
      (seen) => seen.includes('later'),
    );
    expect(model.seen).toEqual(['first', 'now', 'later']);
    model.release('first');
    const transcript = await settledTranscript(store, threadId, 2);
    expect(transcript).toEqual([
      'user: first',
      'user: now',
      'assistant: re: now',
      'user: later',
      'assistant: re: later',
    ]);
  });

  it('runs a WAITING message now: it moves to the head as an interrupt and the turn is cancelled for it', async () => {
    const { model, store, threadId, url } = await boot();
    model.hold('first');
    const first = send(url, { threadId, message: 'first' }).then((res) => res.text());
    await model.reached('first');
    const runId = (await store.activeRunForThread(threadId)) as string;
    await send(url, { threadId, message: 'later' });
    const urgent = await json(send(url, { threadId, message: 'urgent' }));

    // Another actor cannot, and an unknown id is a 404 — before anything is cancelled.
    expect(
      (await call(url, 'POST', `queue/${urgent.messageId}/interrupt`, undefined, 'u2')).status,
    ).toBe(403);
    expect((await call(url, 'POST', 'queue/nope/interrupt')).status).toBe(404);
    expect(await store.activeRunForThread(threadId)).toBe(runId);

    const answer = await call(url, 'POST', `queue/${urgent.messageId}/interrupt`);
    expect(answer.status).toBe(200);
    const interrupted = await json(answer);
    expect(interrupted.interrupting).toBe(runId);
    expect(interrupted.items.map((item: Json) => [item.content, item.interrupt === true])).toEqual([
      ['urgent', true],
      ['later', false],
    ]);

    const { events } = eventsOf(await first);
    // The message keeps the id it was queued under: that id is the run it starts as.
    expect(events.filter((event) => event.kind === 'queue').at(-1)).toMatchObject({
      started: { messageId: urgent.messageId, runId: urgent.messageId },
      queue: { items: [{ content: 'later' }], paused: null },
    });
    await until(
      async () => model.seen,
      (seen) => seen.includes('later'),
    );
    expect(model.seen).toEqual(['first', 'urgent', 'later']);
    model.release('first');
    expect(await settledTranscript(store, threadId, 2)).toEqual([
      'user: first',
      'user: urgent',
      'assistant: re: urgent',
      'user: later',
      'assistant: re: later',
    ]);
    // It already started: there is nothing left to interrupt for.
    expect((await call(url, 'POST', `queue/${urgent.messageId}/interrupt`)).status).toBe(404);
  });

  it('interrupting with nothing running starts the message, lifting the pause that held it', async () => {
    const { model, store, threadId, url } = await boot();
    model.failing.add('boom');
    model.hold('boom');
    const failed = send(url, { threadId, message: 'boom' }).then((res) => res.text());
    await model.reached('boom');
    const waiting = await json(send(url, { threadId, message: 'after' }));
    model.release('boom');
    await failed;
    expect((await json(call(url, 'GET', `threads/${threadId}/queue`))).paused).toMatchObject({
      reason: 'run_failed',
    });

    const started = await json(call(url, 'POST', `queue/${waiting.messageId}/interrupt`));
    expect(started).toMatchObject({ runId: waiting.messageId, paused: null, items: [] });
    expect(started.interrupting).toBeUndefined();
    const transcript = await settledTranscript(store, threadId, 1);
    expect(transcript.slice(-2)).toEqual(['user: after', 'assistant: re: after']);
  });

  it('edits, reorders and removes queued messages — only the thread owner may', async () => {
    const { model, store, threadId, url } = await boot();
    model.hold('first');
    const first = send(url, { threadId, message: 'first' }).then((res) => res.text());
    await model.reached('first');
    const a = (await json(send(url, { threadId, message: 'a' }))).messageId as string;
    const b = (await json(send(url, { threadId, message: 'b' }))).messageId as string;
    const c = (await json(send(url, { threadId, message: 'c' }))).messageId as string;

    const moved = await json(call(url, 'PATCH', `queue/${b}`, { position: 0 }));
    expect(moved.items.map((item: { id: string }) => item.id)).toEqual([b, a, c]);
    const edited = await json(call(url, 'PATCH', `queue/${a}`, { message: 'a, edited' }));
    expect(edited.items[1]).toMatchObject({ id: a, content: 'a, edited' });
    const removed = await json(call(url, 'DELETE', `queue/${c}`));
    expect(removed.items.map((item: { id: string }) => item.id)).toEqual([b, a]);

    const stranger = await call(url, 'PATCH', `queue/${a}`, { message: 'hijacked' }, 'intruder');
    expect(stranger.status).toBe(403);
    expect((await call(url, 'DELETE', `queue/${a}`, undefined, 'intruder')).status).toBe(403);
    expect((await send(url, { threadId, message: 'sneak' }, 'intruder')).status).toBe(403);
    expect(
      (await call(url, 'GET', `threads/${threadId}/queue`, undefined, 'intruder')).status,
    ).toBe(403);
    expect((await call(url, 'DELETE', `queue/${c}`)).status).toBe(404);
    expect((await call(url, 'PATCH', `queue/${a}`, { message: '  ' })).status).toBe(400);

    model.release('first');
    await first;
    const transcript = await settledTranscript(store, threadId, 3);
    expect(transcript.filter((line) => line.startsWith('user:'))).toEqual([
      'user: first',
      'user: b',
      'user: a, edited',
    ]);
  });

  it('clears the queue, and any pause with it', async () => {
    const { model, threadId, url } = await boot();
    model.hold('first');
    const first = send(url, { threadId, message: 'first' }).then((res) => res.text());
    await model.reached('first');
    await send(url, { threadId, message: 'a' });
    await send(url, { threadId, message: 'b' });
    expect(await json(call(url, 'DELETE', `threads/${threadId}/queue`))).toEqual({
      items: [],
      paused: null,
    });
    model.release('first');
    await first;
    expect(model.seen).toEqual(['first']);
  });

  it('checks the quota when a queued message starts, pausing the queue when it is spent', async () => {
    const quota = new SwitchableQuota();
    const { model, threadId, url } = await boot({ quota });
    model.hold('first');
    const first = send(url, { threadId, message: 'first' }).then((res) => res.text());
    await model.reached('first');
    await send(url, { threadId, message: 'second' });
    quota.blocked = true;

    model.release('first');
    const { events } = eventsOf(await first);
    expect(events.at(-1)).toMatchObject({
      kind: 'queue',
      queue: { paused: { reason: 'quota_exceeded', message: 'Daily budget spent' } },
    });
    expect(model.seen).not.toContain('second');

    // At enqueue too: a spent budget refuses the send outright.
    expect((await send(url, { threadId, message: 'third' })).status).toBe(429);
  });

  it('replaces a holder that is no longer running instead of queueing behind it for ever', async () => {
    const { store, threadId, url } = await boot();
    // What a process that crashed mid-turn leaves behind.
    await store.setActiveStream(threadId, 'ghost-run');
    const res = await send(url, { threadId, message: 'hello' });
    expect(res.status).toBe(200);
    expect(eventsOf(await res.text()).terminal).toBe('done');
    expect(await settledTranscript(store, threadId, 1)).toEqual([
      'user: hello',
      'assistant: re: hello',
    ]);
  });

  it('keeps AgentService.chat() a start-or-refuse call for in-process callers', async () => {
    const { model, store, threadId, url, service } = await boot();
    model.hold('first');
    const first = send(url, { threadId, message: 'first' }).then((res) => res.text());
    await model.reached('first');

    const refused = await service
      .chat({ actor: { id: 'u1' }, threadId, message: 'second' })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ChatQueueError);
    expect(refused).toMatchObject({ status: 409, code: 'run_active' });
    expect(await store.listQueue(threadId)).toEqual([]);
    model.release('first');
    await first;
  });

  it('refuses to regenerate while a turn is running', async () => {
    const { model, threadId, url } = await boot();
    model.hold('first');
    const first = send(url, { threadId, message: 'first' }).then((res) => res.text());
    await model.reached('first');
    const res = await send(url, { threadId, message: '', regenerate: true });
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('run_active');
    model.release('first');
    await first;
  });

  it('knows who owns a run that holds its thread before it has a run row', async () => {
    const { store, threadId, url } = await boot();
    // Admitted to the thread, not started: what a drain leaves for the instant before the next run
    // begins (and, on a durable runner, until a worker picks it up).
    await store.claimActiveStream(threadId, 'q-1');
    // Another actor is told it is not theirs — not that it does not exist…
    expect((await call(url, 'GET', 'chat/q-1/stream', undefined, 'u2')).status).toBe(403);
    // …and the owner reaches the stream check. The inline runner runs in this process and knows no
    // such run, so the claim is a stale one: nothing to resume.
    const owner = await call(url, 'GET', 'chat/q-1/stream');
    expect(owner.status).toBe(404);
    expect(await owner.json()).toEqual({ message: 'Nothing is streaming under that run.' });
    expect((await call(url, 'GET', 'chat/never-ran/stream')).status).toBe(404);
  });

  it('rejects an unknown mode', async () => {
    const { threadId, url } = await boot();
    expect((await send(url, { threadId, message: 'x', mode: 'later' })).status).toBe(400);
  });
});
