import type { CompanyClient } from './company.js';
import { throwForResponse } from './company.js';
import { ConversationError, PoppyError } from './errors.js';
import { readJson } from './http.js';
import { parseSse } from './sse.js';
import type {
  ConversationEvent,
  ConversationState,
  EventMessage,
  EventsPage,
  OutgoingMessage,
  PoppyProtocolEntry,
  StartConversationResponse,
  TextDelta,
} from './types.js';
import { randomId, requireSecureUrl, sleep } from './util.js';

const ID_RE = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * A fresh request ID: URL-safe base64, prefixed, unique for the User across all its requests (8.2,
 * 8.3). A message's ID is its request's.
 */
export function newRequestId(prefix = 'req_'): string {
  return randomId(prefix, 12);
}

/** A request ID for a message (8.3). */
export function newMessageId(): string {
  return newRequestId('msg_');
}

/**
 * The `poppy` conversation protocol entries (8.1), with their `description` of what the agent there
 * can help with, so a caller can choose between them. Unknown types are skipped.
 */
export function poppyProtocols(company: CompanyClient): PoppyProtocolEntry[] {
  return (company.document.agent?.protocols ?? []).filter(
    (p) => p?.type === 'poppy' && typeof p.endpoint === 'string',
  );
}

/** The first `poppy` conversation protocol entry (8.1). */
export function poppyProtocol(company: CompanyClient): PoppyProtocolEntry | undefined {
  return poppyProtocols(company)[0];
}

/** `author.type` as 8.4 says to read it: one this client doesn't know is `agent`. */
export function authorTypeOf(message: EventMessage | undefined): 'agent' | 'human' {
  return message?.author?.type === 'human' ? 'human' : 'agent';
}

/** Whether a message is the Company's: any `role` other than `user` is content from the Company (8.4). */
export function isFromCompany(message: EventMessage | undefined): boolean {
  return message !== undefined && message.role !== 'user';
}

/** The state fields as 8.7 says to read them: unknown `handoff` is `pending`, unknown `responder` `human`. */
export function readState(
  raw: { [K in keyof ConversationState]?: ConversationState[K] | undefined } | undefined,
): ConversationState {
  const handoff = raw?.handoff === 'none' || raw?.handoff === undefined ? 'none' : 'pending';
  const responder = raw?.responder === 'agent' || raw?.responder === undefined ? 'agent' : 'human';
  return {
    working: raw?.working === true,
    handoff,
    responder,
    closed: raw?.closed === true,
  };
}

export type StreamItem =
  | { kind: 'event'; event: ConversationEvent }
  | { kind: 'delta'; delta: TextDelta }
  /** `working` changed (8.6). It isn't an event and has no ID. */
  | { kind: 'working'; working: boolean }
  /** The reader reconnected; any provisional `text-delta` pieces must be dropped (8.6). */
  | { kind: 'reconnected' }
  /** `cursor_expired`: the read restarted from the beginning; part of history is missing. */
  | { kind: 'history_gap' };

export interface FollowOptions {
  signal?: AbortSignal | undefined;
  /** Stop once `working` is false (the Company's reply is complete) or the conversation is closed. */
  untilSettled?: boolean | undefined;
  /** Prefer SSE (default). When the Company answers with JSON, long-polling is used. */
  stream?: boolean | undefined;
  /** Long-poll `wait` seconds. */
  wait?: number | undefined;
}

type PostOptions = { wait?: number | undefined; cursor?: string | undefined };

/**
 * Client for one Company's Poppy conversation endpoint (section 8). Every request carries the
 * Session header (8.2) and, when signed in, an access token, through `CompanyClient.fetch`. Every
 * POST carries a request `id`, so a retry is safe (8.3). A successful POST means the Company accepted
 * the request: what it did comes from the events and the state (8.5, 8.7).
 */
export class ConversationClient {
  readonly endpoint: string;
  /** What the agent at this endpoint can help with (8.1). */
  readonly description: string | undefined;
  /** Narrower scope for every request of this client (4.4), when set. */
  private readonly scope?: string | undefined;

  constructor(
    readonly company: CompanyClient,
    entry: PoppyProtocolEntry | undefined = poppyProtocol(company),
    options: { scope?: string | undefined } = {},
  ) {
    if (!entry)
      throw new PoppyError('no_conversation_protocol', 'Company lists no `poppy` protocol');
    this.endpoint = requireSecureUrl(entry.endpoint, 'agent endpoint', company.security)
      .toString()
      .replace(/\/+$/, '');
    this.description = typeof entry.description === 'string' ? entry.description : undefined;
    this.scope = options.scope;
  }

  private url(
    id?: string | undefined,
    suffix?: string | undefined,
    query?: Record<string, string | number | undefined>,
  ) {
    if (id !== undefined && !ID_RE.test(id))
      throw new PoppyError('invalid_id', `bad conversation id ${id}`);
    const u = new URL(id === undefined ? this.endpoint : `${this.endpoint}/${id}${suffix ?? ''}`);
    for (const [k, v] of Object.entries(query ?? {}))
      if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  /**
   * POST with retries on network errors / 5xx. Safe because the request ID makes it idempotent: the
   * Company returns the original response for a repeat with the same path and body (8.3).
   */
  private async post<T>(
    url: string,
    body: { id: string; [k: string]: unknown },
    retries = 2,
  ): Promise<{ status: number; body: T }> {
    if (!ID_RE.test(body.id))
      throw new ConversationError('invalid_request', { description: 'bad request id' });
    const json = JSON.stringify(body);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.company.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: json,
          service: this.endpoint,
          scope: this.scope,
        });
        if (res.status >= 500 && attempt < retries) {
          await res.body?.cancel().catch(() => {});
          lastErr = new PoppyError(`http_${res.status}`);
          await sleep(300 * (attempt + 1));
          continue;
        }
        if (!res.ok) await throwForResponse(res);
        return { status: res.status, body: (await readJson<T>(res)) as T };
      } catch (e) {
        if (e instanceof PoppyError) throw e;
        lastErr = e;
        if (attempt < retries) await sleep(300 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  private remember(
    id: string,
    patch: {
      cursor?: string | undefined;
      closed?: boolean | undefined;
      parent?: string | undefined;
    },
  ) {
    const convs = this.company.state.conversations;
    convs[id] ??= { endpoint: this.endpoint, createdAt: Date.now() };
    const rec = convs[id];
    if (patch.cursor !== undefined) rec.cursor = patch.cursor;
    if (patch.closed !== undefined) rec.closed = patch.closed;
    if (patch.parent !== undefined) rec.parentConversationId = patch.parent;
  }

  /** The cursor this client last handled for a conversation, if any. */
  cursorOf(id: string): string | undefined {
    return this.company.state.conversations[id]?.cursor || undefined;
  }

  /** `as_of_cursor` on a message the Personal Agent wrote (8.4): never on the User's own words. */
  private withAsOf(id: string | undefined, message: OutgoingMessage): OutgoingMessage {
    if (message.author.type !== 'agent') {
      const { as_of_cursor: _drop, ...rest } = message;
      return rest;
    }
    if (message.as_of_cursor !== undefined || id === undefined) return message;
    const cursor = this.cursorOf(id);
    return cursor ? { ...message, as_of_cursor: cursor } : message;
  }

  /**
   * Starts a conversation with its first message (8.3), or a Direct Conversation with
   * `parentConversationId` (8.10). Accepting a `user_requested` event (`userRequestedEventId`) may
   * leave the message out, so the Company speaks first.
   */
  async start(
    message: OutgoingMessage | undefined,
    opts: PostOptions & {
      /** The request ID; a retry of the same start reuses it. */
      requestId?: string | undefined;
      parentConversationId?: string | undefined;
      userRequestedEventId?: string | undefined;
    } = {},
  ): Promise<StartConversationResponse> {
    if (message === undefined) {
      if (!opts.parentConversationId || !opts.userRequestedEventId) {
        throw new ConversationError('invalid_request', {
          description:
            'only a Direct Conversation accepting user_requested starts without a message',
        });
      }
    } else {
      checkMessage(message);
    }
    const body: { id: string; [k: string]: unknown } = {
      id: opts.requestId ?? (message ? newMessageId() : newRequestId('dir_')),
    };
    if (opts.parentConversationId) body.parent_conversation_id = opts.parentConversationId;
    if (opts.userRequestedEventId) body.user_requested_event_id = opts.userRequestedEventId;
    if (message) body.message = this.withAsOf(undefined, message);
    const r = await this.post<StartConversationResponse>(
      this.url(undefined, undefined, { wait: opts.wait, cursor: opts.cursor }),
      body,
    );
    if (!r.body?.conversation_id) throw new PoppyError('invalid_response', 'no conversation_id');
    this.remember(r.body.conversation_id, { parent: opts.parentConversationId });
    await this.company.save();
    return r.body;
  }

  /** Sends another message (8.3). HTTP 202 with `conversation_id`, or a read with `wait`. */
  async send(
    id: string,
    message: OutgoingMessage,
    opts: PostOptions & { requestId?: string | undefined } = {},
  ): Promise<StartConversationResponse> {
    checkMessage(message);
    const r = await this.post<StartConversationResponse>(
      this.url(id, '/messages', { wait: opts.wait, cursor: opts.cursor }),
      { id: opts.requestId ?? newMessageId(), message: this.withAsOf(id, message) },
    );
    return r.body;
  }

  /** One read of events after `cursor` (8.5). */
  async read(
    id: string,
    opts: { cursor?: string | undefined; wait?: number | undefined } = {},
  ): Promise<EventsPage> {
    const { body } = await this.company.json<EventsPage>(this.url(id, '/events', opts), {
      headers: { accept: 'application/json' },
      service: this.endpoint,
      scope: this.scope,
    });
    if (!Array.isArray(body?.events))
      throw new PoppyError('invalid_response', 'events must be a list');
    return { ...body, ...readState(body) };
  }

  /** Asks for a person at the Company (8.9). Accepted (202): `handoff` and `responder` tell the outcome. */
  async handoff(
    id: string,
    opts: PostOptions & { requestId?: string | undefined } = {},
  ): Promise<StartConversationResponse> {
    return (
      await this.post<StartConversationResponse>(
        this.url(id, '/handoff', { wait: opts.wait, cursor: opts.cursor }),
        { id: opts.requestId ?? newRequestId('hnd_') },
      )
    ).body;
  }

  /**
   * Withdraws a request for a person (8.9). The Company MAY keep looking: read `handoff` and
   * `responder`, never assume the cancel took effect.
   */
  async cancelHandoff(
    id: string,
    opts: PostOptions & { requestId?: string | undefined } = {},
  ): Promise<StartConversationResponse> {
    return (
      await this.post<StartConversationResponse>(
        this.url(id, '/handoff/cancel', { wait: opts.wait, cursor: opts.cursor }),
        { id: opts.requestId ?? newRequestId('hcn_') },
      )
    ).body;
  }

  /**
   * Closes the conversation (8.12): HTTP 202. A close doesn't wait its turn, so the Company may drop
   * requests it hasn't acted on: read until `working` is false first (`collect`) when that matters.
   */
  async close(
    id: string,
    opts: { requestId?: string | undefined } = {},
  ): Promise<StartConversationResponse> {
    const r = (
      await this.post<StartConversationResponse>(this.url(id, '/close'), {
        id: opts.requestId ?? newRequestId('cls_'),
      })
    ).body;
    this.remember(id, { closed: true });
    await this.company.save();
    return r;
  }

  /**
   * Reads (long-polling, JSON) until `working` is false and `has_more` is false (8.5, 8.7), returning
   * the new events and the state. Used by the autonomous `ask` mode.
   */
  async collect(
    id: string,
    opts: { timeoutMs?: number | undefined; wait?: number | undefined } = {},
  ): Promise<{ events: ConversationEvent[]; state: ConversationState }> {
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    const events: ConversationEvent[] = [];
    const seen = new Set<string>();
    let cursor = this.cursorOf(id);
    for (;;) {
      let page: EventsPage;
      try {
        page = await this.read(id, { cursor, wait: opts.wait ?? 20 });
      } catch (e) {
        if (e instanceof ConversationError && e.code === 'cursor_expired') {
          cursor = undefined;
          continue;
        }
        throw e;
      }
      for (const ev of page.events) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        events.push(ev);
      }
      if (page.cursor) cursor = page.cursor;
      this.remember(id, { cursor, ...(page.closed ? { closed: true } : {}) });
      await this.company.save();
      if (page.has_more) continue;
      if (!page.working || page.closed || Date.now() > deadline) {
        return { events, state: readState(page) };
      }
    }
  }

  /**
   * Follows a conversation's events in order, from the saved cursor: SSE when the Company streams
   * (reconnecting with `Last-Event-ID`), long-polling otherwise. Skips event IDs it already handled,
   * restarts from the beginning on `cursor_expired`, persists the cursor, and skips SSE event names
   * and event types it doesn't know (8.5, 8.6).
   */
  async *follow(id: string, opts: FollowOptions = {}): AsyncGenerator<StreamItem> {
    const seen = new Set<string>();
    let cursor = this.cursorOf(id);
    let useStream = opts.stream !== false;
    let firstConnect = true;
    let working: boolean | undefined;
    let closed = false;

    const handle = async (ev: ConversationEvent): Promise<boolean> => {
      if (!ev || typeof ev.id !== 'string' || seen.has(ev.id)) return false;
      seen.add(ev.id);
      cursor = ev.id;
      this.remember(id, { cursor });
      if (ev.type === 'state' && ev.closed === true) {
        closed = true;
        this.remember(id, { closed: true });
      }
      return true;
    };
    const settled = () => closed || (opts.untilSettled === true && working === false);

    // Read what is there first: a conversation whose reply is already complete is the answer, and
    // a request the Company accepted keeps `working` true until it acted on it (8.7).
    if (opts.untilSettled) {
      for (;;) {
        let page: EventsPage;
        try {
          page = await this.read(id, cursor ? { cursor } : {});
        } catch (e) {
          if (e instanceof ConversationError && e.code === 'cursor_expired') {
            cursor = undefined;
            this.remember(id, { cursor: '' });
            yield { kind: 'history_gap' };
            continue;
          }
          throw e;
        }
        for (const ev of page.events) {
          if (await handle(ev)) yield { kind: 'event', event: ev };
        }
        if (page.cursor) {
          cursor = page.cursor;
          this.remember(id, { cursor });
        }
        if (!page.has_more) {
          working = page.working;
          closed ||= page.closed;
          break;
        }
      }
      await this.company.save();
      if (settled()) return;
    }

    while (!opts.signal?.aborted) {
      if (!firstConnect) yield { kind: 'reconnected' };
      firstConnect = false;
      let res: Response;
      try {
        const headers: Record<string, string> = {
          accept: useStream ? 'text/event-stream' : 'application/json',
        };
        // Reconnects carry Last-Event-ID in place of `cursor` (8.6).
        if (useStream && cursor) headers['last-event-id'] = cursor;
        res = await this.company.fetch(
          this.url(id, '/events', useStream ? {} : { cursor, wait: opts.wait ?? 25 }),
          { headers, signal: opts.signal, service: this.endpoint, scope: this.scope },
        );
      } catch (e) {
        if (opts.signal?.aborted) return;
        throw e;
      }
      if (!res.ok) {
        const body = await readJson<{ error?: string | undefined }>(res.clone());
        if (body?.error === 'cursor_expired') {
          cursor = undefined;
          this.remember(id, { cursor: '' });
          yield { kind: 'history_gap' };
          continue;
        }
        await throwForResponse(res);
      }
      const type = res.headers.get('content-type') ?? '';
      if (type.includes('text/event-stream') && res.body) {
        try {
          for await (const sse of parseSse(res.body)) {
            if (sse.event === 'text-delta') {
              const delta = safeJson<TextDelta>(sse.data);
              if (delta?.message_id) yield { kind: 'delta', delta };
              continue;
            }
            if (sse.event === 'working') {
              const w = safeJson<{ working?: unknown }>(sse.data);
              if (typeof w?.working !== 'boolean') continue;
              working = w.working;
              yield { kind: 'working', working };
              if (settled()) {
                // The stream may send `working` before the events it replays: read what's left.
                yield* this.#drain(id, () => cursor, handle);
                await this.company.save();
                return;
              }
              continue;
            }
            if (sse.event !== 'message') continue; // unknown SSE event names are skipped (8.6)
            const ev = safeJson<ConversationEvent>(sse.data);
            if (ev && (await handle(ev))) {
              yield { kind: 'event', event: ev };
              if (settled()) {
                await this.company.save();
                return;
              }
            }
          }
        } catch (e) {
          if (opts.signal?.aborted) return;
          this.company.agent.log(`stream interrupted: ${(e as Error).message}`);
        }
        await this.company.save();
        if (closed) return;
        await sleep(250, opts.signal).catch(() => {});
        continue;
      }
      // The Company answered with JSON: it doesn't stream, so long-poll from now on (8.6).
      useStream = false;
      const page = (await readJson<EventsPage>(res)) as EventsPage;
      for (const ev of page?.events ?? []) {
        if (await handle(ev)) yield { kind: 'event', event: ev };
      }
      if (page?.cursor) {
        cursor = page.cursor;
        this.remember(id, { cursor });
      }
      await this.company.save();
      if (page?.has_more) {
        firstConnect = true; // not a reconnect, just the next page
        continue;
      }
      const state = readState(page);
      if (working !== state.working) yield { kind: 'working', working: state.working };
      working = state.working;
      closed ||= state.closed;
      if (settled()) return;
      firstConnect = true;
    }
  }

  /** Reads the events after the cursor until `has_more` is false, without waiting. */
  async *#drain(
    id: string,
    cursorNow: () => string | undefined,
    handle: (ev: ConversationEvent) => Promise<boolean>,
  ): AsyncGenerator<StreamItem> {
    for (;;) {
      const cursor = cursorNow();
      const page = await this.read(id, cursor ? { cursor } : {});
      for (const ev of page.events) {
        if (await handle(ev)) yield { kind: 'event', event: ev };
      }
      if (page.cursor) this.remember(id, { cursor: page.cursor });
      if (!page.has_more) return;
    }
  }
}

function safeJson<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

/** 8.4: `author.type` agent or human, and at least one of `text`, `data`, `context`, `extensions`. */
function checkMessage(m: OutgoingMessage) {
  if (m.author?.type !== 'agent' && m.author?.type !== 'human') {
    throw new ConversationError('invalid_message', {
      description: 'author.type must be agent or human',
    });
  }
  if (
    m.text === undefined &&
    m.data === undefined &&
    m.context === undefined &&
    m.extensions === undefined
  ) {
    throw new ConversationError('invalid_message', {
      description: 'a message needs text, data, context or extensions',
    });
  }
}
