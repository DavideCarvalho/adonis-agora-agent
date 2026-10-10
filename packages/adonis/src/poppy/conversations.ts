import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { scopeRole } from '../a2a/gate.js';
import { PERSONAL_AGENT_ROLE } from '../a2a/permission-tool.js';
import { type A2aActionPolicy, type A2aTurnService, runA2aTurn } from '../a2a/turn.js';
import type { StreamFrame } from '../spi/token-stream-sink.js';
import type { Actor } from '../types.js';
import type { PoppyPrincipal } from './auth.js';
import {
  derivedPoppyId,
  messageFingerprint,
  newPoppyId,
  PoppyError,
  type PoppyEvent,
  type PoppyEventBody,
  type PoppyEventMessage,
  type PoppyInboundMessage,
  type PoppyResponder,
  type PoppySendBody,
  type PoppySender,
  type PoppyStatus,
} from './protocol.js';
import {
  eventIdSeq,
  type PoppyConversationPatch,
  type PoppyConversationRecord,
  type PoppyGrant,
  type PoppyStore,
  type StoredPoppyEvent,
} from './store.js';

/** What the hooks are told about a conversation. */
export interface PoppyHookContext {
  conversationId: string;
  conversation: PoppyConversationRecord;
  /** Who the conversation's turns run as (its latest request); `null` before any. */
  actor: Actor | null;
}

/**
 * What {@link PoppyHandoffHooks.request} decided:
 *  - `'queued'` — someone will join: call {@link PoppyConversations.humanJoined} when they do, or
 *    {@link PoppyConversations.handoffUnavailable} if nobody can.
 *  - `'joined'` — a person took it now.
 *  - `{ unavailable }` — nobody can; the text is what the Company Agent says (§7.9).
 */
export type PoppyHandoffDecision = 'queued' | 'joined' | { unavailable: string };

/**
 * How the app brings a person in (§7.9). Without these, a handoff is answered by the Company Agent
 * saying no one is available — the conversation stays with the agent.
 */
export interface PoppyHandoffHooks {
  /** A person was asked for — by the Personal Agent (`requested`) or by the app (`company`). */
  request(
    ctx: PoppyHookContext & { by: 'requested' | 'company' },
  ): PoppyHandoffDecision | Promise<PoppyHandoffDecision>;
  /**
   * A message from the Personal Agent while a person handles the conversation or is being found —
   * the agent does not answer those. Route it to your support tool.
   */
  message?(ctx: PoppyHookContext & { message: PoppyEventMessage }): void | Promise<void>;
  /** The conversation closed while a person was handling it or being found (§7.12). */
  cancel?(ctx: PoppyHookContext): void | Promise<void>;
}

/** Notified when the Personal Agent opens or closes a Direct Conversation (§7.10). */
export interface PoppyDirectHooks {
  opened?(ctx: PoppyHookContext & { parentId: string }): void | Promise<void>;
  closed?(ctx: PoppyHookContext & { parentId: string }): void | Promise<void>;
}

/** What the Company Agent says on its own. */
export interface PoppyTexts {
  /** A handoff with no one to take it (§7.9). */
  handoffUnavailable: string;
  /** A turn that failed before saying anything. */
  failed: string;
  /** Asked in a Direct Conversation alongside an `authorization` event (§7.11 SHOULD). */
  signIn: string;
}

export const DEFAULT_POPPY_TEXTS: PoppyTexts = {
  handoffUnavailable: 'No one is available to take this conversation right now.',
  failed: 'Sorry, something went wrong on our side. Please try again.',
  signIn: 'Please sign in to your account so I can continue with this request.',
};

export interface PoppyConversationsOptions {
  store: PoppyStore;
  /** What runs a turn — `AgentService`, or an app's adapter (the A2A surface's contract). */
  service: A2aTurnService & { drive?(runId: string): Promise<void> };
  /** The roles a tool declares, for matching the token's scopes. */
  toolRoles: (toolName: string) => string[] | undefined;
  /** The registered agent that answers. Omitted → the agent provider's default. */
  agentName?: string;
  /** What happens to `action` calls that park for approval. Default `'approve-delegated'`. */
  actions?: A2aActionPolicy;
  /** Give up on a turn after this many ms. Default 120 000. */
  timeoutMs?: number;
  /** Drive a durable run left pending, in this process (see `AgentService.drive`). Default `true`. */
  drive?: boolean;
  /** Map a principal without an actor to the app's actor. Default: `poppy:<hash>`. */
  actorFor?: (principal: PoppyPrincipal, defaults: Actor) => Actor | Promise<Actor>;
  handoff?: PoppyHandoffHooks;
  direct?: PoppyDirectHooks;
  texts?: Partial<PoppyTexts>;
  /** Keep events this long, then prune them (a cursor there is `cursor_expired`). Default: forever. */
  retentionMs?: number;
  /** How often a waiting read looks for events another replica appended. Default 1000 ms. */
  pollMs?: number;
  /** Logs what fails outside a request (a turn, a hook). */
  onError?: (error: unknown, context: string) => void;
}

/** What a read answers (§7.5). */
export interface PoppyReadResult {
  conversation_id: string;
  events: PoppyEvent[];
  cursor: string | null;
  has_more: boolean;
  status: PoppyStatus;
  responder: PoppyResponder;
}

/** What a stream yields: a stored event, or a provisional piece of text (§7.6). */
export type PoppyStreamItem =
  | { kind: 'event'; event: PoppyEvent }
  | { kind: 'delta'; messageId: string; text: string }
  | { kind: 'state'; status: PoppyStatus };

const PAGE_SIZE = 100;
const LEASE_MS = 30_000;
const RUN_ACTIVE_RETRY_MS = 250;
const PRUNE_EVERY_MS = 60_000;

/** The actor of a principal the resolver gave none: stable per (Personal Agent, its User). */
export function poppyActorId(clientId: string, userId: string): string {
  return `poppy:${createHash('sha256').update(`${clientId}\n${userId}`).digest('hex').slice(0, 40)}`;
}

/** The idempotency owner of §7.3: message ids are unique per User of a Personal Agent. */
function ownerKey(principal: PoppyPrincipal): string {
  return createHash('sha256').update(`${principal.clientId}\n${principal.userId}`).digest('hex');
}

const hasContent = (message: PoppyInboundMessage) =>
  (message.text !== undefined && message.text.trim() !== '') || message.data !== undefined;

/** A user message as the model reads it: its text, and its data as JSON. */
function turnText(messages: PoppyEventMessage[]): string {
  return messages
    .map((message) =>
      [
        message.text?.trim() ?? '',
        message.data !== undefined
          ? `\`\`\`json\n${JSON.stringify(message.data, null, 2)}\n\`\`\``
          : '',
      ]
        .filter((part) => part !== '')
        .join('\n\n'),
    )
    .filter((text) => text !== '')
    .join('\n\n');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poppy conversations (§7) over the agent runtime: the state machine, the event log and the turns.
 * HTTP-free — `createPoppyHandler` puts the protocol's requests on it, and the app drives the
 * Company side through it (a person joining, their messages, `user_requested`).
 *
 * A conversation is an agent thread owned by the principal's actor. A user message is appended to
 * the event log, and the log is the turn queue: a pump per conversation (one replica at a time,
 * by lease) answers the messages after `turnSeq` in one turn, streams its text as `text-delta`,
 * then appends the reply as a `message` event. A replica that finds a conversation `working` with
 * no pump picks it up, so a reply survives the process that started it.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */
export class PoppyConversations {
  readonly #bus = new EventEmitter();
  readonly #pumps = new Map<string, Promise<void>>();
  readonly #rekick = new Set<string>();
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #pruned = new Map<string, number>();
  readonly #holder = `poppy:${randomUUID()}`;
  readonly #texts: PoppyTexts;
  #closed = false;

  constructor(private readonly options: PoppyConversationsOptions) {
    this.#texts = { ...DEFAULT_POPPY_TEXTS, ...options.texts };
    this.#bus.setMaxListeners(0);
  }

  // ── identity and ownership ──────────────────────────────────────────────────

  /**
   * The actor a principal's turns run as: the resolver's (`toActor`), else the app's `actorFor`,
   * else — signed in — the ACCOUNT, `{ id: accountId }`, the way a PACT delegation runs as the
   * account; signed out, `poppy:<hash>` (stable per Personal Agent and User, never an account).
   * It ALWAYS carries `personal_agent` (what puts it behind `personalAgentGate`) and one
   * `scope:<id>` role per account scope of a signed-in token — the roles a PACT delegation gives,
   * so a tool written for personal agents gates both surfaces alike.
   */
  async actorOf(principal: PoppyPrincipal): Promise<Actor> {
    const defaults: Actor = principal.actor ?? {
      id:
        principal.signedIn && principal.accountId
          ? principal.accountId
          : poppyActorId(principal.clientId, principal.userId),
    };
    const actor =
      principal.actor === undefined && this.options.actorFor
        ? await this.options.actorFor(principal, defaults)
        : defaults;
    const scopes = principal.signedIn ? principal.scopes : [];
    return {
      ...actor,
      roles: [...new Set([...(actor.roles ?? []), PERSONAL_AGENT_ROLE, ...scopes.map(scopeRole)])],
    };
  }

  /** The account a signed-in principal is — what a conversation binds to once used (§7.2). */
  async #accountOf(principal: PoppyPrincipal): Promise<string | null> {
    if (!principal.signedIn) return null;
    return principal.accountId ?? (await this.actorOf(principal)).id;
  }

  #grant(principal: PoppyPrincipal, actor: Actor): PoppyGrant {
    return {
      actor,
      scopes: principal.signedIn ? [...principal.scopes] : [],
      signedIn: principal.signedIn,
    };
  }

  /**
   * The conversation, when `principal` may use it (§7.2): the same Personal Agent and User — and
   * once it used an account, a token signed in to that account. Anything else is indistinguishable
   * from no conversation, except a signed-out token of its own User: `sign_in_required` (§7.11).
   */
  async #owned(principal: PoppyPrincipal, id: string): Promise<PoppyConversationRecord> {
    const conversation = await this.options.store.getConversation(id);
    if (!conversation || conversation.clientId !== principal.clientId) {
      throw new PoppyError('conversation_not_found');
    }
    if (conversation.accountRef !== null) {
      if (principal.signedIn) {
        if ((await this.#accountOf(principal)) !== conversation.accountRef) {
          throw new PoppyError('conversation_not_found');
        }
        return conversation;
      }
      if (conversation.userId === principal.userId) {
        throw new PoppyError('sign_in_required', 'This conversation used your account: sign in');
      }
      throw new PoppyError('conversation_not_found');
    }
    if (conversation.userId !== principal.userId) throw new PoppyError('conversation_not_found');
    return conversation;
  }

  /** Run `fn` alone among this process's mutations of conversation `id`. */
  async #locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.#locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.#locks.get(id) === next) this.#locks.delete(id);
    }
  }

  // ── the event log ──────────────────────────────────────────────────────────

  async #append(
    conversationId: string,
    body: PoppyEventBody,
    key?: string,
  ): Promise<StoredPoppyEvent> {
    const { event, created } = await this.options.store.appendEvent(
      conversationId,
      body,
      key !== undefined ? { key } : {},
    );
    if (created) this.#bus.emit(`event:${conversationId}`, event);
    return event;
  }

  /** Change status and/or responder; every change is a `state` event (§7.7). */
  async #setState(
    conversation: PoppyConversationRecord,
    next: { status?: PoppyStatus; responder?: PoppyResponder },
    extra: PoppyConversationPatch = {},
  ): Promise<PoppyConversationRecord> {
    const status = next.status ?? conversation.status;
    const responder = next.responder ?? conversation.responder;
    const changed = status !== conversation.status || responder !== conversation.responder;
    await this.options.store.updateConversation(conversation.id, { status, responder, ...extra });
    const updated = { ...conversation, ...extra, status, responder };
    if (changed) await this.#append(conversation.id, { type: 'state', status, responder });
    return updated;
  }

  #companyMessage(
    text: string | undefined,
    data: Record<string, unknown> | undefined,
    sender: PoppySender,
    id = newPoppyId('msg'),
  ): PoppyEventMessage {
    return {
      id,
      role: 'company',
      sender,
      ...(text !== undefined && text !== '' ? { text } : {}),
      ...(data !== undefined ? { data } : {}),
    };
  }

  // ── Personal Agent requests ─────────────────────────────────────────────────

  /** `POST {endpoint}` — start a conversation (or a Direct Conversation) with its first message. */
  async start(
    principal: PoppyPrincipal,
    body: PoppySendBody,
  ): Promise<{ status: number; body: Record<string, unknown>; conversationId: string }> {
    const actor = await this.actorOf(principal);
    const owner = ownerKey(principal);
    const fingerprint = messageFingerprint('new', body);

    let parent: PoppyConversationRecord | null = null;
    if (body.parentConversationId !== undefined) {
      parent = await this.#owned(principal, body.parentConversationId);
      // A Direct Conversation is not a parent (§7.10): as a parent, it does not exist.
      if (parent.parentId !== null) throw new PoppyError('conversation_not_found');
    }

    for (;;) {
      const id = newPoppyId('cnv');
      const content = hasContent(body.message);
      const response = {
        status: 201,
        body: {
          conversation_id: id,
          status: (content ? 'working' : 'idle') as PoppyStatus,
          responder: 'agent' as PoppyResponder,
        },
      };
      const claim = await this.options.store.claimMessage(owner, body.message.id, {
        fingerprint,
        conversationId: id,
        response,
      });
      if (claim.status === 'existing') {
        if (claim.fingerprint !== fingerprint) throw new PoppyError('message_id_conflict');
        const existing = await this.options.store.getConversation(claim.conversationId);
        if (existing) {
          // A retried first message: the conversation it already started (§7.3).
          return { ...claim.response, conversationId: claim.conversationId };
        }
        // Claimed by a delivery that died before creating it: take it over.
        await this.options.store.releaseMessage(owner, body.message.id);
        continue;
      }

      try {
        if (parent !== null) {
          const parentId = parent.id;
          await this.#locked(parentId, async () => {
            const current = await this.#owned(principal, parentId);
            await this.#assertNoDirect(current);
            if (current.status === 'closed') throw new PoppyError('conversation_closed');
            await this.#create(id, principal, actor, current);
            await this.options.store.updateConversation(current.id, { openDirectId: id });
            await this.#append(current.id, { type: 'direct_opened', conversation_id: id });
          });
        } else {
          await this.#create(id, principal, actor, null);
        }
      } catch (error) {
        await this.options.store.releaseMessage(owner, body.message.id);
        throw error;
      }

      const created = (await this.options.store.getConversation(id)) as PoppyConversationRecord;
      await this.#locked(id, () =>
        this.#acceptMessage(created, body.message, response.body.status, {}),
      );
      if (parent !== null) {
        const parentId = parent.id;
        await this.#hook('direct.opened', () =>
          this.options.direct?.opened?.({
            conversationId: id,
            conversation: created,
            actor,
            parentId,
          }),
        );
      }
      return { ...response, conversationId: id };
    }
  }

  async #create(
    id: string,
    principal: PoppyPrincipal,
    actor: Actor,
    parent: PoppyConversationRecord | null,
  ): Promise<void> {
    const now = Date.now();
    await this.options.store.createConversation({
      id,
      clientId: principal.clientId,
      userId: principal.userId,
      accountRef: await this.#accountOf(principal),
      agentName: parent?.agentName ?? this.options.agentName ?? '',
      threadId: parent?.threadId ?? null,
      parentId: parent?.id ?? null,
      openDirectId: null,
      status: 'idle',
      responder: 'agent',
      context: {},
      activeRunId: null,
      turnSeq: 0,
      grant: this.#grant(principal, actor),
      prunedSeq: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  async #assertNoDirect(conversation: PoppyConversationRecord): Promise<void> {
    if (conversation.openDirectId === null) return;
    const direct = await this.options.store.getConversation(conversation.openDirectId);
    if (direct && direct.status !== 'closed') {
      throw new PoppyError('direct_conversation_open', undefined, {
        conversation_id: direct.id,
      });
    }
    // A Direct Conversation that closed without telling its parent: the parent is free.
    await this.options.store.updateConversation(conversation.id, { openDirectId: null });
  }

  /** `POST {endpoint}/{id}/messages` — another message (§7.3). */
  async send(
    principal: PoppyPrincipal,
    conversationId: string,
    body: PoppySendBody,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const owned = await this.#owned(principal, conversationId);
    const actor = await this.actorOf(principal);
    const owner = ownerKey(principal);
    const fingerprint = messageFingerprint(conversationId, body);

    // A retry is answered as before, whatever happened since (§7.3).
    return this.#locked(conversationId, async () => {
      const conversation = (await this.options.store.getConversation(owned.id)) ?? owned;
      const content = hasContent(body.message);
      const toAgent = conversation.responder === 'agent' && conversation.status !== 'queued';
      const status: PoppyStatus =
        content && toAgent && conversation.status !== 'closed' ? 'working' : conversation.status;
      const response = {
        status: 202,
        body: { conversation_id: conversationId, status, responder: conversation.responder },
      };
      const claim = await this.options.store.claimMessage(owner, body.message.id, {
        fingerprint,
        conversationId,
        response,
      });
      if (claim.status === 'existing') {
        if (claim.fingerprint !== fingerprint) throw new PoppyError('message_id_conflict');
        return claim.response;
      }
      try {
        if (conversation.status === 'closed') throw new PoppyError('conversation_closed');
        await this.#assertNoDirect(conversation);
      } catch (error) {
        await this.options.store.releaseMessage(owner, body.message.id);
        throw error;
      }

      const patch: PoppyConversationPatch = { grant: this.#grant(principal, actor) };
      // Once it is used signed in, the conversation belongs to that account (§7.2).
      if (principal.signedIn && conversation.accountRef === null) {
        patch.accountRef = await this.#accountOf(principal);
      }
      await this.#acceptMessage(conversation, body.message, status, patch);
      return response;
    });
  }

  /**
   * Record a user message, and hand it to whoever answers: the agent's pump, or — while a person
   * handles the conversation or is being found — the app's handoff hook.
   */
  async #acceptMessage(
    conversation: PoppyConversationRecord,
    message: PoppyInboundMessage,
    status: PoppyStatus,
    patch: PoppyConversationPatch,
  ): Promise<void> {
    const context =
      message.context !== undefined
        ? { ...conversation.context, ...message.context }
        : conversation.context;
    if (message.context !== undefined) patch = { ...patch, context };
    const eventMessage: PoppyEventMessage = { role: 'user', ...message };
    const stored = await this.#append(conversation.id, { type: 'message', message: eventMessage });
    const toAgent = conversation.responder === 'agent' && conversation.status !== 'queued';
    if (!toAgent) patch = { ...patch, turnSeq: stored.seq };
    await this.#setState(conversation, { status }, patch);
    if (!toAgent) {
      await this.#hook('handoff.message', () =>
        this.options.handoff?.message?.({
          conversationId: conversation.id,
          conversation: { ...conversation, context },
          actor: conversation.grant?.actor ?? null,
          message: eventMessage,
        }),
      );
      return;
    }
    if (hasContent(message)) this.#kick(conversation.id);
  }

  /** `GET {endpoint}/{id}/events` without streaming — read (and wait for) events (§7.5). */
  async read(
    principal: PoppyPrincipal,
    conversationId: string,
    options: { cursor?: string; waitMs?: number },
  ): Promise<PoppyReadResult> {
    const conversation = await this.#owned(principal, conversationId);
    return this.readOwned(conversation, options);
  }

  /** A read of a conversation already checked — also what a POST with `wait` answers (§7.3). */
  async readOwned(
    conversation: PoppyConversationRecord,
    options: { cursor?: string; waitMs?: number },
  ): Promise<PoppyReadResult> {
    await this.#maintain(conversation);
    let afterSeq = await this.#cursorSeq(conversation, options.cursor);
    const deadline = Date.now() + (options.waitMs ?? 0);
    let page = await this.options.store.listEvents(conversation.id, afterSeq, PAGE_SIZE + 1);
    while (page.length === 0 && Date.now() < deadline && !this.#closed) {
      await this.#waitForEvent(conversation.id, deadline - Date.now());
      page = await this.options.store.listEvents(conversation.id, afterSeq, PAGE_SIZE + 1);
    }
    const events = page.slice(0, PAGE_SIZE);
    if (events.length > 0) afterSeq = events[events.length - 1]?.seq ?? afterSeq;
    const current = (await this.options.store.getConversation(conversation.id)) ?? conversation;
    return {
      conversation_id: conversation.id,
      events: events.map((entry) => entry.event),
      cursor: events.at(-1)?.event.id ?? options.cursor ?? null,
      has_more: page.length > PAGE_SIZE,
      status: current.status,
      responder: current.responder,
    };
  }

  /** Check a conversation is the principal's, for a caller that reads it afterwards. */
  owned(principal: PoppyPrincipal, conversationId: string): Promise<PoppyConversationRecord> {
    return this.#owned(principal, conversationId);
  }

  /**
   * `GET {endpoint}/{id}/events` as SSE (§7.6): the events after `cursor`, then new ones as they
   * come, with `text-delta` pieces of a reply being written in this process. Ends when `signal`
   * aborts, or once the conversation is closed and every event was sent.
   */
  async *stream(
    conversation: PoppyConversationRecord,
    cursor: string | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<PoppyStreamItem> {
    await this.#maintain(conversation);
    let afterSeq = await this.#cursorSeq(conversation, cursor);
    const pending: PoppyStreamItem[] = [];
    let wake: (() => void) | null = null;
    const notify = () => {
      wake?.();
      wake = null;
    };
    const onDelta = (delta: { messageId: string; text: string }) => {
      pending.push({ kind: 'delta', ...delta });
      notify();
    };
    let dirty = true;
    const onEvent = () => {
      dirty = true;
      notify();
    };
    this.#bus.on(`event:${conversation.id}`, onEvent);
    this.#bus.on(`delta:${conversation.id}`, onDelta);
    signal.addEventListener('abort', notify, { once: true });
    try {
      while (!signal.aborted && !this.#closed) {
        // Deltas that arrived before the events now in the log were written before them.
        while (pending.length > 0) yield pending.shift() as PoppyStreamItem;
        if (dirty) {
          dirty = false;
          const page = await this.options.store.listEvents(conversation.id, afterSeq, PAGE_SIZE);
          while (pending.length > 0) yield pending.shift() as PoppyStreamItem;
          for (const entry of page) {
            afterSeq = entry.seq;
            yield { kind: 'event', event: entry.event };
          }
          if (page.length === PAGE_SIZE) {
            dirty = true;
            continue;
          }
          const current = await this.options.store.getConversation(conversation.id);
          if (!current || current.status === 'closed') {
            yield { kind: 'state', status: 'closed' };
            return;
          }
          if (current.status === 'working' && !this.#pumps.has(current.id)) {
            // A turn nobody here is writing (a replica that died): take it up.
            this.#kick(current.id);
          }
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          const timer = setTimeout(() => {
            // Another replica appends without telling this one: look again now and then.
            dirty = true;
            resolve();
          }, this.options.pollMs ?? 1000);
          timer.unref?.();
          if (pending.length > 0 || dirty || signal.aborted) resolve();
        });
        wake = null;
      }
    } finally {
      this.#bus.off(`event:${conversation.id}`, onEvent);
      this.#bus.off(`delta:${conversation.id}`, onDelta);
      signal.removeEventListener('abort', notify);
    }
  }

  async #waitForEvent(conversationId: string, ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#bus.off(`event:${conversationId}`, done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, Math.min(ms, this.options.pollMs ?? 1000)));
      this.#bus.on(`event:${conversationId}`, done);
    });
  }

  /** The position after which a read starts (§7.5): unknown → `invalid_cursor`, pruned → expired. */
  async #cursorSeq(conversation: PoppyConversationRecord, cursor?: string): Promise<number> {
    if (cursor === undefined) return 0;
    const seq = await this.options.store.findEventSeq(conversation.id, cursor);
    if (seq !== null) return seq;
    const minted = eventIdSeq(cursor);
    const current = (await this.options.store.getConversation(conversation.id)) ?? conversation;
    if (minted !== null && minted <= current.prunedSeq) throw new PoppyError('cursor_expired');
    throw new PoppyError('invalid_cursor');
  }

  /** Housekeeping on read: prune past the retention, and take up a turn nobody is pumping. */
  async #maintain(conversation: PoppyConversationRecord): Promise<void> {
    const retention = this.options.retentionMs;
    if (retention !== undefined) {
      const last = this.#pruned.get(conversation.id) ?? 0;
      if (Date.now() - last >= PRUNE_EVERY_MS) {
        this.#pruned.set(conversation.id, Date.now());
        await this.options.store.pruneEvents(conversation.id, Date.now() - retention);
      }
    }
    if (conversation.status === 'working' && !this.#pumps.has(conversation.id)) {
      this.#kick(conversation.id);
    }
  }

  /** `POST {endpoint}/{id}/handoff` — ask for a person at the Company (§7.9). */
  async requestHandoff(
    principal: PoppyPrincipal,
    conversationId: string,
  ): Promise<{ status: PoppyStatus; responder: PoppyResponder }> {
    const owned = await this.#owned(principal, conversationId);
    const conversation = await this.#locked(owned.id, async () => {
      const current = (await this.options.store.getConversation(owned.id)) ?? owned;
      if (current.status === 'closed') throw new PoppyError('conversation_closed');
      await this.#assertNoDirect(current);
      return current;
    });
    return this.#handoff(conversation, 'requested');
  }

  async #handoff(
    conversation: PoppyConversationRecord,
    by: 'requested' | 'company',
  ): Promise<{ status: PoppyStatus; responder: PoppyResponder }> {
    // Already with a person, or being found one: nothing more to ask for.
    if (conversation.status === 'queued' || conversation.responder === 'human') {
      return { status: conversation.status, responder: conversation.responder };
    }
    const hooks = this.options.handoff;
    if (!hooks) {
      // No people to hand off to: the Company Agent says so, and keeps the conversation (§7.9).
      await this.#append(conversation.id, {
        type: 'message',
        message: this.#companyMessage(this.#texts.handoffUnavailable, undefined, 'agent'),
      });
      return { status: conversation.status, responder: conversation.responder };
    }
    const queued = await this.#locked(conversation.id, async () => {
      const current = (await this.options.store.getConversation(conversation.id)) ?? conversation;
      return this.#setState(current, { status: 'queued' });
    });
    let decision: PoppyHandoffDecision;
    try {
      decision = await hooks.request({
        conversationId: conversation.id,
        conversation: queued,
        actor: queued.grant?.actor ?? null,
        by,
      });
    } catch (error) {
      this.options.onError?.(error, 'poppy: handoff.request failed');
      decision = { unavailable: this.#texts.handoffUnavailable };
    }
    if (decision === 'joined') return this.humanJoined(conversation.id);
    if (typeof decision === 'object') {
      return this.handoffUnavailable(conversation.id, decision.unavailable);
    }
    return { status: queued.status, responder: queued.responder };
  }

  /** `POST {endpoint}/{id}/close` — close the conversation (§7.12). */
  async closeByAgent(
    principal: PoppyPrincipal,
    conversationId: string,
  ): Promise<{ status: PoppyStatus; responder: PoppyResponder }> {
    const conversation = await this.#owned(principal, conversationId);
    return this.close(conversation.id);
  }

  // ── the Company side (app API) ─────────────────────────────────────────────

  /** Look a conversation up — for the app's own routing (a support tool, an admin page). */
  get(conversationId: string): Promise<PoppyConversationRecord | null> {
    return this.options.store.getConversation(conversationId);
  }

  async #require(conversationId: string): Promise<PoppyConversationRecord> {
    const conversation = await this.options.store.getConversation(conversationId);
    if (!conversation) throw new PoppyError('conversation_not_found');
    return conversation;
  }

  /**
   * Close a conversation (§7.12): its open Direct Conversation first, a pending handoff is
   * cancelled, and a `closed` state event added. Nothing it started is undone. Idempotent.
   */
  async close(conversationId: string): Promise<{ status: PoppyStatus; responder: PoppyResponder }> {
    const conversation = await this.#require(conversationId);
    if (conversation.status === 'closed') {
      return { status: 'closed', responder: conversation.responder };
    }
    if (conversation.openDirectId !== null) {
      const direct = await this.options.store.getConversation(conversation.openDirectId);
      if (direct && direct.status !== 'closed') await this.close(direct.id);
    }
    const before = (await this.options.store.getConversation(conversationId)) ?? conversation;
    const closed = await this.#locked(conversationId, async () => {
      const current = (await this.options.store.getConversation(conversationId)) ?? before;
      if (current.status === 'closed') return current;
      return this.#setState(current, { status: 'closed' });
    });
    if (before.status === 'queued' || before.responder === 'human') {
      await this.#hook('handoff.cancel', () =>
        this.options.handoff?.cancel?.({
          conversationId,
          conversation: closed,
          actor: closed.grant?.actor ?? null,
        }),
      );
    }
    if (closed.parentId !== null) {
      const parentId = closed.parentId;
      await this.#locked(parentId, async () => {
        const parent = await this.options.store.getConversation(parentId);
        if (parent?.openDirectId === conversationId) {
          await this.options.store.updateConversation(parentId, { openDirectId: null });
          await this.#append(parentId, { type: 'direct_closed', conversation_id: conversationId });
        }
      });
      await this.#hook('direct.closed', () =>
        this.options.direct?.closed?.({
          conversationId,
          conversation: closed,
          actor: closed.grant?.actor ?? null,
          parentId,
        }),
      );
    }
    return { status: 'closed', responder: closed.responder };
  }

  /** The Company Agent hands off to a person on its own (§7.9) — e.g. from one of your tools. */
  async handoff(
    conversationId: string,
  ): Promise<{ status: PoppyStatus; responder: PoppyResponder }> {
    const conversation = await this.#require(conversationId);
    if (conversation.status === 'closed') throw new PoppyError('conversation_closed');
    return this.#handoff(conversation, 'company');
  }

  /** A person at the Company joined: `responder` becomes `human` (§7.7). */
  async humanJoined(
    conversationId: string,
  ): Promise<{ status: PoppyStatus; responder: PoppyResponder }> {
    return this.#locked(conversationId, async () => {
      const conversation = await this.#require(conversationId);
      if (conversation.status === 'closed') throw new PoppyError('conversation_closed');
      const status = conversation.status === 'queued' ? 'idle' : conversation.status;
      const updated = await this.#setState(conversation, { status, responder: 'human' });
      return { status: updated.status, responder: updated.responder };
    });
  }

  /** The person left: the Company Agent answers again. */
  async humanLeft(
    conversationId: string,
  ): Promise<{ status: PoppyStatus; responder: PoppyResponder }> {
    return this.#locked(conversationId, async () => {
      const conversation = await this.#require(conversationId);
      if (conversation.status === 'closed') {
        return { status: conversation.status, responder: conversation.responder };
      }
      const status = conversation.status === 'queued' ? 'idle' : conversation.status;
      const updated = await this.#setState(conversation, { status, responder: 'agent' });
      return { status: updated.status, responder: updated.responder };
    });
  }

  /**
   * No one could take a queued handoff: the Company Agent says why, and the conversation goes back
   * to `idle` with the agent (§7.9).
   */
  async handoffUnavailable(
    conversationId: string,
    reason: string = this.#texts.handoffUnavailable,
  ): Promise<{ status: PoppyStatus; responder: PoppyResponder }> {
    return this.#locked(conversationId, async () => {
      const conversation = await this.#require(conversationId);
      if (conversation.status !== 'queued') {
        return { status: conversation.status, responder: conversation.responder };
      }
      await this.#append(conversationId, {
        type: 'message',
        message: this.#companyMessage(reason, undefined, 'agent'),
      });
      const updated = await this.#setState(conversation, { status: 'idle', responder: 'agent' });
      return { status: updated.status, responder: updated.responder };
    });
  }

  /**
   * Add a Company message — a person's (`sender: 'human'`, while they handle the conversation) or
   * an automated one. Answers the message's id.
   */
  async postMessage(
    conversationId: string,
    message: { text?: string; data?: Record<string, unknown>; sender: PoppySender },
  ): Promise<string> {
    const conversation = await this.#require(conversationId);
    if (conversation.status === 'closed') throw new PoppyError('conversation_closed');
    const event = this.#companyMessage(message.text, message.data, message.sender);
    await this.#append(conversationId, { type: 'message', message: event });
    return event.id;
  }

  /**
   * Ask to talk with the User directly (§7.10): a `user_requested` event. Only the Personal Agent
   * opens the Direct Conversation, once the User agrees.
   */
  async requestUser(conversationId: string, reason: string): Promise<void> {
    const conversation = await this.#require(conversationId);
    if (conversation.status === 'closed') throw new PoppyError('conversation_closed');
    if (conversation.parentId !== null) {
      throw new PoppyError('invalid_request', 'A Direct Conversation already has the User');
    }
    await this.#append(conversationId, { type: 'user_requested', reason });
  }

  /** Stop pumping and waiting in this process (shutdown). */
  shutdown(): void {
    this.#closed = true;
    this.#bus.emit('shutdown');
  }

  // ── turns ──────────────────────────────────────────────────────────────────

  /** Make sure a pump runs for the conversation in this process (if no replica holds it). */
  #kick(conversationId: string): void {
    if (this.#closed) return;
    if (this.#pumps.has(conversationId)) {
      this.#rekick.add(conversationId);
      return;
    }
    const pump = this.#pump(conversationId)
      .catch((error) => this.options.onError?.(error, 'poppy: turn failed'))
      .finally(() => {
        this.#pumps.delete(conversationId);
        if (this.#rekick.delete(conversationId)) this.#kick(conversationId);
      });
    this.#pumps.set(conversationId, pump);
  }

  /**
   * Answer what waits in the conversation's log, one turn at a time, while this process holds its
   * lease. Messages that arrived during a turn are answered together by the next one.
   */
  async #pump(conversationId: string): Promise<void> {
    const store = this.options.store;
    if (!(await store.leaseReader(conversationId, this.#holder, LEASE_MS))) return;
    const renew = setInterval(() => {
      void store.leaseReader(conversationId, this.#holder, LEASE_MS).catch(() => {});
    }, LEASE_MS / 3);
    renew.unref?.();
    try {
      for (;;) {
        this.#rekick.delete(conversationId);
        const conversation = await store.getConversation(conversationId);
        if (!conversation || conversation.status === 'closed') return;
        if (conversation.activeRunId !== null) {
          // A turn whose writer died: write its reply from the run's own stream.
          await this.#recover(conversation, conversation.activeRunId);
          continue;
        }
        // Decided under the lock a send takes, so a message accepted meanwhile is never left
        // behind an `idle` conversation.
        const waiting = await this.#locked(conversationId, async () => {
          const current = await store.getConversation(conversationId);
          if (!current || current.status === 'closed') return null;
          const toAgent = current.responder === 'agent' && current.status !== 'queued';
          const found = toAgent
            ? (await this.#unanswered(current)).filter(
                (entry) => entry.message.text !== undefined || entry.message.data !== undefined,
              )
            : [];
          if (found.length === 0) {
            if (current.status === 'working') await this.#setState(current, { status: 'idle' });
            return null;
          }
          if (current.status !== 'working') await this.#setState(current, { status: 'working' });
          return { current, found };
        });
        if (waiting === null) {
          if (!this.#rekick.has(conversationId)) return;
          continue;
        }
        await this.#turn(
          waiting.current,
          waiting.found.map((entry) => entry.message),
          waiting.found.at(-1)?.seq ?? 0,
        );
      }
    } finally {
      clearInterval(renew);
      await store.releaseReader(conversationId, this.#holder).catch(() => {});
    }
  }

  /** User messages after `turnSeq`. */
  async #unanswered(
    conversation: PoppyConversationRecord,
  ): Promise<{ seq: number; message: PoppyEventMessage }[]> {
    const out: { seq: number; message: PoppyEventMessage }[] = [];
    let after = conversation.turnSeq;
    for (;;) {
      const page = await this.options.store.listEvents(conversation.id, after, PAGE_SIZE);
      for (const entry of page) {
        after = entry.seq;
        const message = entry.event.message as PoppyEventMessage | undefined;
        if (entry.event.type === 'message' && message?.role === 'user') {
          out.push({ seq: entry.seq, message });
        }
      }
      if (page.length < PAGE_SIZE) return out;
    }
  }

  async #turn(
    conversation: PoppyConversationRecord,
    messages: PoppyEventMessage[],
    upToSeq: number,
  ): Promise<void> {
    const grant = conversation.grant;
    if (!grant) {
      await this.options.store.updateConversation(conversation.id, { turnSeq: upToSeq });
      return;
    }
    const deadline = Date.now() + (this.options.timeoutMs ?? 120_000);
    const components = new Map<string, Extract<StreamFrame, { t: 'component' }>>();
    let replyId: string | null = null;
    let runId: string | null = null;
    const last = messages.at(-1);
    const service = this.options.service;
    // A Direct Conversation answers in its parent's thread — which a later parent turn may create.
    let threadId = conversation.threadId;
    if (threadId === null && conversation.parentId !== null) {
      threadId =
        (await this.options.store.getConversation(conversation.parentId))?.threadId ?? null;
    }

    for (;;) {
      try {
        const result = await runA2aTurn(service, this.options.toolRoles, {
          actor: grant.actor,
          text: turnText(messages),
          ...(conversation.agentName !== '' ? { agentName: conversation.agentName } : {}),
          ...(threadId !== null ? { threadId } : {}),
          delegatedScopes: grant.signedIn ? grant.scopes : null,
          actions: this.options.actions ?? 'approve-delegated',
          timeoutMs: Math.max(1, deadline - Date.now()),
          via: 'poppy',
          pageContext: {
            channel: 'poppy',
            poppy: {
              conversationId: conversation.id,
              direct: conversation.parentId !== null,
              sender: last?.sender ?? 'agent',
              signedIn: grant.signedIn,
              context: conversation.context,
            },
          },
          ...(this.options.drive !== false && service.drive
            ? { drive: (id: string) => service.drive?.(id) ?? Promise.resolve() }
            : {}),
          onStarted: async (startedThreadId, startedRunId) => {
            runId = startedRunId;
            replyId = derivedPoppyId('msg', `reply:${startedRunId}`);
            await this.options.store.updateConversation(conversation.id, {
              threadId: startedThreadId,
              activeRunId: startedRunId,
              turnSeq: upToSeq,
            });
            // A Direct Conversation's first turn may create the thread its parent shares.
            if (conversation.parentId !== null && threadId === null) {
              const parent = await this.options.store.getConversation(conversation.parentId);
              if (parent && parent.threadId === null) {
                await this.options.store.updateConversation(parent.id, {
                  threadId: startedThreadId,
                });
              }
            }
          },
          onText: (delta) => {
            if (replyId !== null) {
              this.#bus.emit(`delta:${conversation.id}`, { messageId: replyId, text: delta });
            }
          },
          onComponent: (frame) => {
            if (frame.partial === true) return;
            components.set(frame.id ?? `ui:${components.size}`, frame);
          },
        });
        await this.#reply(conversation, grant, runId ?? randomUUID(), {
          text: result.text,
          components: [...components.values()],
          outcomes: result.outcomes,
          permission: result.permission,
          failed: result.error !== null,
        });
        return;
      } catch (error) {
        // The thread is busy — its other conversation (parent / Direct) or a run another replica
        // started: wait for it, within the turn's time.
        if ((error as { code?: string }).code === 'run_active' && Date.now() < deadline) {
          await sleep(RUN_ACTIVE_RETRY_MS);
          continue;
        }
        if (runId === null) {
          await this.options.store.updateConversation(conversation.id, { turnSeq: upToSeq });
        }
        await this.#reply(conversation, grant, runId ?? randomUUID(), {
          text: '',
          components: [],
          outcomes: [],
          permission: null,
          failed: true,
        });
        throw error;
      }
    }
  }

  /** Read a run whose writer died from its stream, and write its reply (once: keyed by run). */
  async #recover(conversation: PoppyConversationRecord, runId: string): Promise<void> {
    const grant = conversation.grant;
    let text = '';
    const components = new Map<string, Extract<StreamFrame, { t: 'component' }>>();
    let failed = false;
    const iterator = this.options.service.subscribe(runId)[Symbol.asyncIterator]();
    const deadline = Date.now() + (this.options.timeoutMs ?? 120_000);
    try {
      for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
        });
        const next = await Promise.race([iterator.next(), timeout]).finally(() =>
          clearTimeout(timer),
        );
        if (next === 'timeout') {
          failed = text === '';
          await this.options.service.cancel(runId).catch(() => {});
          break;
        }
        if (next.done) break;
        const frame = next.value;
        if (frame.t === 'text') text += frame.v;
        else if (frame.t === 'component' && frame.partial !== true) {
          components.set(frame.id ?? `ui:${components.size}`, frame);
        } else if (frame.t === 'error') failed = true;
      }
    } finally {
      void iterator.return?.();
    }
    await this.#reply(
      conversation,
      grant ?? { actor: { id: '' }, scopes: [], signedIn: false },
      runId,
      {
        text,
        components: [...components.values()],
        outcomes: [],
        permission: null,
        failed,
      },
    );
  }

  /**
   * Write a turn's reply: a `message` event (text, and `data` for components and executed actions),
   * then an `authorization` event when the turn needed a scope the token does not carry (§7.11).
   */
  async #reply(
    conversation: PoppyConversationRecord,
    grant: PoppyGrant,
    runId: string,
    turn: {
      text: string;
      components: Extract<StreamFrame, { t: 'component' }>[];
      outcomes: unknown[];
      permission: string[] | null;
      failed: boolean;
    },
  ): Promise<void> {
    const store = this.options.store;
    const current = await store.getConversation(conversation.id);
    await store.updateConversation(conversation.id, { activeRunId: null });
    // A closed conversation takes no more events from its agent (§7.12).
    if (!current || current.status === 'closed') return;

    const components = turn.components.map((frame) => ({
      name: frame.name,
      props: frame.data,
      ...(frame.fallbackText !== undefined ? { fallback_text: frame.fallbackText } : {}),
    }));
    let text = turn.text.trim();
    if (text === '') {
      // A component's fallback is all a reader that does not render it can show.
      text = turn.components
        .map((frame) => frame.fallbackText?.trim() ?? '')
        .filter((part) => part !== '')
        .join('\n\n');
    }
    if (text === '' && turn.failed && components.length === 0 && turn.outcomes.length === 0) {
      text = this.#texts.failed;
    }
    const data: Record<string, unknown> = {
      ...(components.length > 0 ? { components } : {}),
      ...(turn.outcomes.length > 0 ? { actions: turn.outcomes } : {}),
    };
    if (text !== '' || Object.keys(data).length > 0) {
      await this.#append(
        conversation.id,
        {
          type: 'message',
          message: this.#companyMessage(
            text,
            Object.keys(data).length > 0 ? data : undefined,
            'agent',
            derivedPoppyId('msg', `reply:${runId}`),
          ),
        },
        `reply:${runId}`,
      );
    }

    const missing = (turn.permission ?? []).filter(
      (scope) => !grant.signedIn || !grant.scopes.includes(scope),
    );
    if (missing.length > 0) {
      await this.#append(
        conversation.id,
        {
          type: 'authorization',
          error: grant.signedIn ? 'insufficient_scope' : 'sign_in_required',
          scope: missing.join(' '),
        },
        `authorization:${runId}`,
      );
      // In a Direct Conversation the User reads the messages, not the events: ask there too.
      if (conversation.parentId !== null) {
        await this.#append(
          conversation.id,
          {
            type: 'message',
            message: this.#companyMessage(
              this.#texts.signIn,
              undefined,
              'agent',
              derivedPoppyId('msg', `sign-in:${runId}`),
            ),
          },
          `sign-in:${runId}`,
        );
      }
    }
  }

  async #hook(name: string, fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.options.onError?.(error, `poppy: ${name} hook failed`);
    }
  }
}
