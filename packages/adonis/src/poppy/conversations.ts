import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { scopeRole } from '../a2a/gate.js';
import { PERSONAL_AGENT_ROLE } from '../a2a/permission-tool.js';
import {
  type A2aActionPolicy,
  type A2aTurnOutcome,
  type A2aTurnService,
  runA2aTurn,
} from '../a2a/turn.js';
import type { StreamFrame } from '../spi/token-stream-sink.js';
import type { Actor } from '../types.js';
import type { PoppyPrincipal } from './auth.js';
import {
  derivedPoppyId,
  isCompatiblePoppyVersion,
  newPoppyId,
  POPPY_PROTOCOL_VERSION,
  type PoppyAuthor,
  type PoppyContext,
  PoppyError,
  type PoppyEvent,
  type PoppyEventBody,
  type PoppyEventMessage,
  type PoppyInboundMessage,
  type PoppyRequestBody,
  type PoppyResponder,
  type PoppySendBody,
  type PoppyState,
  requestFingerprint,
} from './protocol.js';
import {
  eventIdSeq,
  type PoppyConversationPatch,
  type PoppyConversationRecord,
  type PoppyGrant,
  type PoppyMessageReceipt,
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
 *    {@link PoppyConversations.handoffUnavailable} if nobody can. Meanwhile `handoff` is `pending`
 *    and the Company Agent keeps answering (§8.9).
 *  - `'joined'` — a person took it now.
 *  - `{ unavailable }` — nobody can; the text is what the Company Agent says (§8.9).
 */
export type PoppyHandoffDecision = 'queued' | 'joined' | { unavailable: string };

/**
 * How the app brings a person in (§8.9). Without these, a handoff is answered by the Company Agent
 * saying no one is available — the conversation stays with the agent.
 */
export interface PoppyHandoffHooks {
  /** A person was asked for — by the Personal Agent (`requested`) or by the app (`company`). */
  request(
    ctx: PoppyHookContext & { by: 'requested' | 'company' },
  ): PoppyHandoffDecision | Promise<PoppyHandoffDecision>;
  /**
   * A message from the Personal Agent for the person handling the conversation — the agent does
   * not answer those. When a person joins, the messages the agent had not taken up yet come here
   * too. Route them to your support tool.
   */
  message?(ctx: PoppyHookContext & { message: PoppyEventMessage }): void | Promise<void>;
  /**
   * The Personal Agent withdrew its request while a person was being found (§8.9). Return `false`
   * to keep looking (a help desk that cannot withdraw a routed request); anything else stops, and
   * `handoff` goes back to `none`. Without this hook, the Company stops looking.
   */
  withdraw?(ctx: PoppyHookContext): boolean | undefined | Promise<boolean | undefined>;
  /** The conversation closed while a person was handling it or being found (§8.12). */
  cancel?(ctx: PoppyHookContext): void | Promise<void>;
}

/** Notified when the Personal Agent opens or closes a Direct Conversation (§8.10). */
export interface PoppyDirectHooks {
  opened?(ctx: PoppyHookContext & { parentId: string }): void | Promise<void>;
  closed?(ctx: PoppyHookContext & { parentId: string }): void | Promise<void>;
}

/** What the Company Agent says on its own — and what it is told when it must speak first. */
export interface PoppyTexts {
  /** A handoff with no one to take it (§8.9). */
  handoffUnavailable: string;
  /** A turn that failed before saying anything. */
  failed: string;
  /** Asked in a Direct Conversation alongside an `authorization` event (§8.11). */
  signIn: string;
  /** An action that ran — `{title}` is the app's confirmation title (default {@link formatPoppyAction}). */
  actionSucceeded: string;
  /** An approved action that did not run. `{title}`, `{error}`. */
  actionFailed: string;
  /** An action the policy refused. `{title}`. */
  actionRejected: string;
  /**
   * Given to the Company Agent — never shown — when the User accepts its `user_requested` event and
   * opens a Direct Conversation (§8.10), so it speaks first. `{reason}` is the event's reason.
   */
  userJoined: string;
}

export const DEFAULT_POPPY_TEXTS: PoppyTexts = {
  handoffUnavailable: 'No one is available to take this conversation right now.',
  failed: 'Sorry, something went wrong on our side. Please try again.',
  signIn: 'Please sign in to your account so I can continue with this request.',
  actionSucceeded: 'Done: {title}',
  actionFailed: 'This could not be done: {title}',
  actionRejected: 'This was not done: {title}',
  userJoined:
    'The user has now joined this conversation themselves, because you asked to talk with them: "{reason}". Speak to them directly.',
};

/** An action of the turn, as the reply's `data.actions` carries it. */
export type PoppyActionOutcome = A2aTurnOutcome;

/**
 * Words an action for the reply's text (§8: the message must make sense without `data`). Return
 * `null` to leave it out. Default {@link formatPoppyAction}.
 */
export type PoppyActionFormatter = (
  action: PoppyActionOutcome,
  texts: PoppyTexts,
) => string | null | undefined;

/**
 * Default wording: the status line from `texts` with the confirmation title (a question like
 * "Log this dose?" loses its `?`), then the confirmation detail.
 */
export function formatPoppyAction(action: PoppyActionOutcome, texts: PoppyTexts): string {
  const title = action.summary.title.trim().replace(/\?+$/, '');
  const template =
    action.status === 'succeeded'
      ? texts.actionSucceeded
      : action.status === 'failed'
        ? texts.actionFailed
        : texts.actionRejected;
  const line = template.replaceAll('{title}', title).replaceAll('{error}', action.error ?? '');
  const detail = action.summary.detail?.trim();
  return detail ? `${line}\n${detail}` : line;
}

/** The versions a conversation started in, and those of a request on it (§8.2). */
export interface PoppyVersionCheck {
  conversation: PoppyConversationRecord;
  started: { protocolVersion: string; extensions: Record<string, string> };
  request: { protocolVersion: string; extensions: Record<string, string> };
  /** `read` for `GET …/events`; `write` for every POST on the conversation. */
  kind: 'read' | 'write';
}

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
  /** Words each action of a reply. Default {@link formatPoppyAction}. */
  formatAction?: PoppyActionFormatter;
  handoff?: PoppyHandoffHooks;
  direct?: PoppyDirectHooks;
  texts?: Partial<PoppyTexts>;
  /**
   * Whether a request in other versions than the conversation started in continues it (§8.2);
   * `false` answers `version_mismatch`. Default: when the protocol versions are compatible.
   */
  continueVersion?: (check: PoppyVersionCheck) => boolean | Promise<boolean>;
  /** Keep events this long, then prune them (a cursor there is `cursor_expired`). Default: forever. */
  retentionMs?: number;
  /** How often a waiting read looks for events another replica appended. Default 1000 ms. */
  pollMs?: number;
  /** Logs what fails outside a request (a turn, a hook). */
  onError?: (error: unknown, context: string) => void;
}

/** What a read answers (§8.5): the events, and the state when the Company responds (§8.7). */
export interface PoppyReadResult extends PoppyState {
  conversation_id: string;
  events: PoppyEvent[];
  cursor: string | null;
  has_more: boolean;
}

/** What an accepted POST answers (§8.3): only the conversation's ID. */
export interface PoppyAccepted {
  status: 201 | 202;
  body: { conversation_id: string };
}

/** What a stream yields: a stored event, a provisional piece of text, or `working` (§8.6). */
export type PoppyStreamItem =
  | { kind: 'event'; event: PoppyEvent }
  | { kind: 'delta'; messageId: string; text: string }
  | { kind: 'working'; working: boolean };

const PAGE_SIZE = 100;
const LEASE_MS = 30_000;
const RUN_ACTIVE_RETRY_MS = 250;
const PRUNE_EVERY_MS = 60_000;

/** The actor of a principal the resolver gave none: stable per (Personal Agent, its User). */
export function poppyActorId(clientId: string, userId: string): string {
  return `poppy:${createHash('sha256').update(`${clientId}\n${userId}`).digest('hex').slice(0, 40)}`;
}

/** The idempotency owner of §8.3: request IDs are unique per User of a Personal Agent. */
function ownerKey(principal: PoppyPrincipal): string {
  return createHash('sha256').update(`${principal.clientId}\n${principal.userId}`).digest('hex');
}

/** Where a parent keeps which Direct Conversation accepted each `user_requested` event (§8.10). */
function directKey(parentId: string): string {
  return createHash('sha256').update(`direct\n${parentId}`).digest('hex');
}

const hasContent = (message: Pick<PoppyEventMessage, 'text' | 'data'>) =>
  (message.text !== undefined && message.text.trim() !== '') || message.data !== undefined;

/** Merge a message's context into the conversation's: `null` clears a field (§8.4). */
function mergeContext(current: PoppyContext, update: PoppyContext): PoppyContext {
  const merged: PoppyContext = { ...current };
  for (const [field, value] of Object.entries(update)) {
    if (value === null) delete merged[field];
    else if (value !== undefined) merged[field] = value;
  }
  return merged;
}

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

const stateOf = (conversation: PoppyConversationRecord): PoppyState => ({
  working: conversation.working,
  handoff: conversation.handoff,
  responder: conversation.responder,
  closed: conversation.closed,
});

/**
 * Poppy conversations (§8) over the agent runtime: the state, the event log and the turns.
 * HTTP-free — `createPoppyHandler` puts the protocol's requests on it, and the app drives the
 * Company side through it (a person joining, their messages, `user_requested`).
 *
 * A conversation is an agent thread owned by the principal's actor. Every request is accepted
 * first, then acted on (§8.3): a user message is appended to the event log, and the log is the turn
 * queue — a pump per conversation (one replica at a time, by lease) answers the messages after
 * `turnSeq` in one turn, streams its text as `text-delta`, then appends the reply as a `message`
 * event. `working` is true from a message's acceptance until its reply is written. A replica that
 * finds a conversation `working` with no pump picks it up, so a reply survives the process that
 * started it.
 *
 * @experimental Implements Personal Agent Protocol 1.0 (https://personalagentprotocol.org/docs/1.0/spec).
 * The surface may still change between minor releases of this package while it settles.
 */
export class PoppyConversations {
  readonly #bus = new EventEmitter();
  readonly #pumps = new Map<string, Promise<void>>();
  readonly #rekick = new Set<string>();
  readonly #locks = new Map<string, Promise<unknown>>();
  /** Handoff requests and cancels, acted on per conversation in the order they were accepted. */
  readonly #actions = new Map<string, Promise<unknown>>();
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

  /** The account a signed-in principal is — what a conversation binds to once used (§8.2). */
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

  /** What a request on a conversation patches: who the next turn runs as, and the account (§8.2). */
  async #requestPatch(
    principal: PoppyPrincipal,
    conversation: PoppyConversationRecord,
  ): Promise<PoppyConversationPatch> {
    const patch: PoppyConversationPatch = {
      grant: this.#grant(principal, await this.actorOf(principal)),
    };
    // Once it is used signed in, the conversation belongs to that account (§8.2).
    if (principal.signedIn && conversation.accountRef === null) {
      patch.accountRef = await this.#accountOf(principal);
    }
    return patch;
  }

  /**
   * The conversation, when `principal` may use it (§8.2): the same Personal Agent and User — and
   * once it used an account, a token signed in to that account. Anything else is indistinguishable
   * from no conversation, except a signed-out request of its own User: a challenge (§8.11). Then
   * the request's versions are checked against the ones it started in (`version_mismatch`).
   */
  async #owned(
    principal: PoppyPrincipal,
    id: string,
    kind: 'read' | 'write',
  ): Promise<PoppyConversationRecord> {
    const conversation = await this.options.store.getConversation(id);
    if (!conversation || conversation.clientId !== principal.clientId) {
      throw new PoppyError('conversation_not_found');
    }
    if (conversation.accountRef !== null) {
      if (principal.signedIn) {
        if ((await this.#accountOf(principal)) !== conversation.accountRef) {
          throw new PoppyError('conversation_not_found');
        }
      } else if (conversation.userId === principal.userId) {
        throw new PoppyError('account_required', 'This conversation used your account: sign in');
      } else {
        throw new PoppyError('conversation_not_found');
      }
    } else if (conversation.userId !== principal.userId) {
      throw new PoppyError('conversation_not_found');
    }
    await this.#checkVersion(conversation, principal, kind);
    return conversation;
  }

  async #checkVersion(
    conversation: PoppyConversationRecord,
    principal: PoppyPrincipal,
    kind: 'read' | 'write',
  ): Promise<void> {
    // A conversation from before 1.0 recorded no version: nothing to compare.
    if (conversation.protocolVersion === null) return;
    const check: PoppyVersionCheck = {
      conversation,
      started: {
        protocolVersion: conversation.protocolVersion,
        extensions: conversation.extensions,
      },
      request: {
        protocolVersion: principal.protocolVersion ?? POPPY_PROTOCOL_VERSION,
        extensions: principal.extensions ?? {},
      },
      kind,
    };
    const continues = this.options.continueVersion
      ? await this.options.continueVersion(check)
      : isCompatiblePoppyVersion(check.request.protocolVersion, check.started.protocolVersion);
    if (!continues) {
      throw new PoppyError('version_mismatch', undefined, {
        protocol_version: conversation.protocolVersion,
      });
    }
  }

  /** Run `fn` alone among this process's mutations of conversation `id`. */
  async #locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return this.#chain(this.#locks, id, fn);
  }

  async #chain<T>(
    chains: Map<string, Promise<unknown>>,
    id: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = chains.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    chains.set(id, next);
    try {
      return await next;
    } finally {
      if (chains.get(id) === next) chains.delete(id);
    }
  }

  /**
   * Claim a request ID (§8.3). `null`: claimed now, act on the request. Otherwise the receipt of the
   * request already accepted with that ID — the same path and body, or `request_id_conflict`.
   */
  async #claim(
    principal: PoppyPrincipal,
    requestId: string,
    path: string,
    body: object,
    conversationId: string,
    status: 201 | 202,
  ): Promise<PoppyMessageReceipt | null> {
    const fingerprint = requestFingerprint(path, body);
    const claim = await this.options.store.claimMessage(ownerKey(principal), requestId, {
      fingerprint,
      conversationId,
      response: { status, body: { conversation_id: conversationId } },
    });
    if (claim.status === 'claimed') return null;
    if (claim.fingerprint !== fingerprint) throw new PoppyError('request_id_conflict');
    return claim;
  }

  #release(principal: PoppyPrincipal, requestId: string): Promise<void> {
    return this.options.store.releaseMessage(ownerKey(principal), requestId);
  }

  // ── the event log and the state ─────────────────────────────────────────────

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

  /**
   * Persist `patch`. A change of `handoff`, `responder` or `closed` adds a `state` event with all
   * three (§8.7); a change of `working` adds none, but wakes the reads and streams waiting on it.
   */
  async #update(
    conversation: PoppyConversationRecord,
    patch: PoppyConversationPatch,
  ): Promise<PoppyConversationRecord> {
    const updated = { ...conversation, ...patch };
    await this.options.store.updateConversation(conversation.id, patch);
    if (
      updated.handoff !== conversation.handoff ||
      updated.responder !== conversation.responder ||
      updated.closed !== conversation.closed
    ) {
      await this.#append(conversation.id, {
        type: 'state',
        handoff: updated.handoff,
        responder: updated.responder,
        closed: updated.closed,
      });
    }
    if (updated.working !== conversation.working) this.#bus.emit(`working:${conversation.id}`);
    return updated;
  }

  async #fresh(conversation: PoppyConversationRecord): Promise<PoppyConversationRecord> {
    return (await this.options.store.getConversation(conversation.id)) ?? conversation;
  }

  #companyMessage(
    text: string | undefined,
    data: Record<string, unknown> | undefined,
    author: PoppyAuthor,
    id = newPoppyId('msg'),
    asOfRequest?: string,
  ): PoppyEventMessage {
    return {
      id,
      role: 'company',
      author,
      // Only a message the Company Agent wrote says what it took into account (§8.4).
      ...(asOfRequest !== undefined && author.type === 'agent'
        ? { as_of_request: asOfRequest }
        : {}),
      ...(text !== undefined && text !== '' ? { text } : {}),
      ...(data !== undefined ? { data } : {}),
    };
  }

  // ── Personal Agent requests ─────────────────────────────────────────────────

  /**
   * `POST {endpoint}` — start a conversation with its first message, or a Direct Conversation
   * (§8.3, §8.10). Answers `201 { conversation_id }`; a retried request (same ID, path and body)
   * answers the conversation it already started.
   */
  async start(
    principal: PoppyPrincipal,
    body: PoppySendBody,
  ): Promise<PoppyAccepted & { conversationId: string }> {
    const fingerprintBody = {
      message: body.message ?? null,
      parent: body.parentConversationId ?? null,
      event: body.userRequestedEventId ?? null,
    };

    for (;;) {
      const id = newPoppyId('cnv');
      const accepted: PoppyAccepted = { status: 201, body: { conversation_id: id } };
      const prior = await this.#claim(principal, body.id, 'new', fingerprintBody, id, 201);
      if (prior !== null) {
        if (await this.options.store.getConversation(prior.conversationId)) {
          // A retried first request: the conversation it already started (§8.3), once its
          // ownership is checked again (§8.10).
          await this.#owned(principal, prior.conversationId, 'write');
          return {
            status: 201,
            body: { conversation_id: prior.conversationId },
            conversationId: prior.conversationId,
          };
        }
        // Claimed by a delivery that died before creating it: take it over.
        await this.#release(principal, body.id);
        continue;
      }

      let directClaimed: string | null = null;
      let parent: PoppyConversationRecord | null = null;
      try {
        if (body.parentConversationId !== undefined) {
          parent = await this.#owned(principal, body.parentConversationId, 'write');
          // A Direct Conversation is not a parent (§8.10).
          if (parent.parentId !== null) {
            throw new PoppyError('invalid_request', 'A Direct Conversation cannot be a parent');
          }
          if (body.userRequestedEventId !== undefined) {
            const eventId = body.userRequestedEventId;
            const existing = await this.options.store.claimMessage(directKey(parent.id), eventId, {
              fingerprint: 'direct',
              conversationId: id,
              response: accepted,
            });
            if (existing.status === 'existing') {
              // The same acceptance again: the same Direct Conversation, even closed (§8.10).
              const direct = await this.options.store.getConversation(existing.conversationId);
              if (direct) {
                await this.#owned(principal, direct.id, 'write');
                await this.#release(principal, body.id);
                await this.#claim(principal, body.id, 'new', fingerprintBody, direct.id, 201);
                return {
                  status: 201,
                  body: { conversation_id: direct.id },
                  conversationId: direct.id,
                };
              }
              await this.options.store.releaseMessage(directKey(parent.id), eventId);
              await this.#release(principal, body.id);
              continue;
            }
            directClaimed = eventId;
            if ((await this.#userRequested(parent.id, eventId)) === null) {
              throw new PoppyError(
                'invalid_request',
                'user_requested_event_id names no user_requested event of the parent',
              );
            }
          }
          const parentId = parent.id;
          await this.#locked(parentId, async () => {
            const current = await this.#owned(principal, parentId, 'write');
            if (current.closed) throw new PoppyError('conversation_closed');
            await this.#assertNoDirect(current);
            await this.#create(id, principal, current);
            await this.options.store.updateConversation(current.id, { openDirectId: id });
            await this.#append(current.id, { type: 'direct_opened', conversation_id: id });
          });
        } else {
          await this.#create(id, principal, null);
        }
      } catch (error) {
        if (directClaimed !== null && parent !== null) {
          await this.options.store.releaseMessage(directKey(parent.id), directClaimed);
        }
        await this.#release(principal, body.id);
        throw error;
      }

      const created = (await this.options.store.getConversation(id)) as PoppyConversationRecord;
      const reason =
        directClaimed !== null && parent !== null
          ? await this.#userRequested(parent.id, directClaimed)
          : null;
      await this.#locked(id, async () => {
        let current = created;
        if (reason !== null) {
          // The Company speaks first about what it asked for (§8.10): the conversation is
          // working from now until that first message is written.
          current = await this.#update(current, {
            prompt: this.#texts.userJoined.replaceAll('{reason}', reason),
            working: true,
          });
        }
        if (body.message !== undefined) {
          await this.#acceptMessage(current, body.id, body.message, {});
        } else {
          this.#kick(id);
        }
      });
      if (parent !== null) {
        const parentId = parent.id;
        await this.#hook('direct.opened', () =>
          this.options.direct?.opened?.({
            conversationId: id,
            conversation: created,
            actor: created.grant?.actor ?? null,
            parentId,
          }),
        );
      }
      return { ...accepted, conversationId: id };
    }
  }

  /** The reason of `parentId`'s `user_requested` event `eventId`, or `null` when it is not one. */
  async #userRequested(parentId: string, eventId: string): Promise<string | null> {
    const seq = await this.options.store.findEventSeq(parentId, eventId);
    if (seq === null) return null;
    const [entry] = await this.options.store.listEvents(parentId, seq - 1, 1);
    if (entry?.event.id !== eventId || entry.event.type !== 'user_requested') return null;
    return typeof entry.event.reason === 'string' ? entry.event.reason : '';
  }

  async #create(
    id: string,
    principal: PoppyPrincipal,
    parent: PoppyConversationRecord | null,
  ): Promise<void> {
    const now = Date.now();
    const actor = await this.actorOf(principal);
    await this.options.store.createConversation({
      id,
      clientId: principal.clientId,
      userId: principal.userId,
      accountRef: await this.#accountOf(principal),
      agentName: parent?.agentName ?? this.options.agentName ?? '',
      threadId: parent?.threadId ?? null,
      parentId: parent?.id ?? null,
      openDirectId: null,
      // A new conversation starts with handoff none, responder agent, closed false (§8.7).
      working: false,
      handoff: 'none',
      responder: 'agent',
      closed: false,
      context: {},
      protocolVersion: principal.protocolVersion ?? POPPY_PROTOCOL_VERSION,
      extensions: { ...(principal.extensions ?? {}) },
      prompt: null,
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
    if (direct && !direct.closed) {
      throw new PoppyError('direct_conversation_open', undefined, {
        conversation_id: direct.id,
      });
    }
    // A Direct Conversation that closed without telling its parent: the parent is free.
    await this.options.store.updateConversation(conversation.id, { openDirectId: null });
  }

  /**
   * Accept a request on an open conversation, under its lock: claim its ID (a retry answers as
   * before, whatever happened since), refuse it on a closed conversation or one with an open
   * Direct Conversation, then `act` on it.
   */
  async #acceptOn(
    principal: PoppyPrincipal,
    conversationId: string,
    request: { id: string; path: string; body: object },
    act: (conversation: PoppyConversationRecord) => Promise<void>,
  ): Promise<PoppyAccepted> {
    const owned = await this.#owned(principal, conversationId, 'write');
    return this.#locked(conversationId, async () => {
      const conversation = await this.#fresh(owned);
      const prior = await this.#claim(
        principal,
        request.id,
        request.path,
        request.body,
        conversationId,
        202,
      );
      if (prior !== null) return prior.response as PoppyAccepted;
      try {
        if (conversation.closed) throw new PoppyError('conversation_closed');
        await this.#assertNoDirect(conversation);
      } catch (error) {
        await this.#release(principal, request.id);
        throw error;
      }
      await act(conversation);
      return { status: 202, body: { conversation_id: conversationId } };
    });
  }

  /** `POST {endpoint}/{id}/messages` — another message (§8.3). Answers `202 { conversation_id }`. */
  async send(
    principal: PoppyPrincipal,
    conversationId: string,
    body: PoppySendBody,
  ): Promise<PoppyAccepted> {
    const message = body.message;
    if (message === undefined) throw new PoppyError('invalid_request', 'message is required');
    return this.#acceptOn(
      principal,
      conversationId,
      { id: body.id, path: `${conversationId}/messages`, body: { message } },
      async (conversation) => {
        await this.#acceptMessage(
          conversation,
          body.id,
          message,
          await this.#requestPatch(principal, conversation),
        );
      },
    );
  }

  /**
   * Record a user message — its ID is its request's (§8.3) — and hand it to whoever answers: the
   * agent's pump (`working` from now until it replies), or — while a person handles the
   * conversation — the app's handoff hook.
   */
  async #acceptMessage(
    conversation: PoppyConversationRecord,
    requestId: string,
    message: PoppyInboundMessage,
    patch: PoppyConversationPatch,
  ): Promise<void> {
    const context =
      message.context !== undefined
        ? mergeContext(conversation.context, message.context)
        : conversation.context;
    if (message.context !== undefined) patch = { ...patch, context };
    const eventMessage: PoppyEventMessage = { id: requestId, role: 'user', ...message };
    const stored = await this.#append(conversation.id, { type: 'message', message: eventMessage });
    const toAgent = conversation.responder === 'agent';
    if (!toAgent) {
      // The person reads it: acted on now.
      await this.#update(conversation, { ...patch, turnSeq: stored.seq });
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
    const answer = hasContent(message);
    await this.#update(conversation, { ...patch, ...(answer ? { working: true } : {}) });
    if (answer || conversation.prompt !== null) this.#kick(conversation.id);
  }

  /** `GET {endpoint}/{id}/events` without streaming — read (and wait for) events (§8.5). */
  async read(
    principal: PoppyPrincipal,
    conversationId: string,
    options: { cursor?: string; waitMs?: number },
  ): Promise<PoppyReadResult> {
    const conversation = await this.#owned(principal, conversationId, 'read');
    return this.readOwned(conversation, options);
  }

  /**
   * A read of a conversation already checked — also what a POST with `wait` answers (§8.3). Holds
   * up to `waitMs` until there is an event, or until `working` turns false (§8.5).
   */
  async readOwned(
    conversation: PoppyConversationRecord,
    options: { cursor?: string; waitMs?: number },
  ): Promise<PoppyReadResult> {
    await this.#maintain(conversation);
    let afterSeq = await this.#cursorSeq(conversation, options.cursor);
    const deadline = Date.now() + (options.waitMs ?? 0);
    const wasWorking = (await this.#fresh(conversation)).working;
    let page = await this.options.store.listEvents(conversation.id, afterSeq, PAGE_SIZE + 1);
    let current: PoppyConversationRecord | null = null;
    while (page.length === 0 && Date.now() < deadline && !this.#closed) {
      await this.#waitForChange(conversation.id, deadline - Date.now());
      page = await this.options.store.listEvents(conversation.id, afterSeq, PAGE_SIZE + 1);
      if (page.length === 0 && wasWorking) {
        current = await this.#fresh(conversation);
        if (!current.working) break;
      }
    }
    const events = page.slice(0, PAGE_SIZE);
    if (events.length > 0) afterSeq = events[events.length - 1]?.seq ?? afterSeq;
    current = await this.#fresh(conversation);
    return {
      conversation_id: conversation.id,
      events: events.map((entry) => entry.event),
      cursor: events.at(-1)?.event.id ?? options.cursor ?? null,
      has_more: page.length > PAGE_SIZE,
      ...stateOf(current),
    };
  }

  /** Check a conversation is the principal's (and its versions continue it), for a caller that reads it afterwards. */
  owned(
    principal: PoppyPrincipal,
    conversationId: string,
    kind: 'read' | 'write' = 'read',
  ): Promise<PoppyConversationRecord> {
    return this.#owned(principal, conversationId, kind);
  }

  /**
   * `GET {endpoint}/{id}/events` as SSE (§8.6): `working` first, the events after `cursor`, then new
   * ones as they come, with `text-delta` pieces of a reply being written in this process and
   * `working` again on each change. Ends when `signal` aborts, or once the conversation is closed
   * and every event was sent.
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
    const onChange = () => {
      dirty = true;
      notify();
    };
    this.#bus.on(`event:${conversation.id}`, onChange);
    this.#bus.on(`working:${conversation.id}`, onChange);
    this.#bus.on(`delta:${conversation.id}`, onDelta);
    signal.addEventListener('abort', notify, { once: true });
    let working: boolean | null = null;
    try {
      while (!signal.aborted && !this.#closed) {
        // Deltas that arrived before the events now in the log were written before them.
        while (pending.length > 0) yield pending.shift() as PoppyStreamItem;
        if (dirty) {
          dirty = false;
          const current = await this.options.store.getConversation(conversation.id);
          // `working` when the stream opens (before any event), and each time it changes (§8.6).
          if (working === null && current) {
            working = current.working;
            yield { kind: 'working', working };
          }
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
          const after = await this.options.store.getConversation(conversation.id);
          if (after && working !== null && after.working !== working) {
            working = after.working;
            yield { kind: 'working', working };
          }
          if (!after || after.closed) return;
          if (after.working && !this.#pumps.has(after.id)) {
            // A turn nobody here is writing (a replica that died): take it up.
            this.#kick(after.id);
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
      this.#bus.off(`event:${conversation.id}`, onChange);
      this.#bus.off(`working:${conversation.id}`, onChange);
      this.#bus.off(`delta:${conversation.id}`, onDelta);
      signal.removeEventListener('abort', notify);
    }
  }

  /** Wait up to `ms` (at most a poll interval) for an event or a change of `working`. */
  async #waitForChange(conversationId: string, ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#bus.off(`event:${conversationId}`, done);
        this.#bus.off(`working:${conversationId}`, done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, Math.min(ms, this.options.pollMs ?? 1000)));
      this.#bus.on(`event:${conversationId}`, done);
      this.#bus.on(`working:${conversationId}`, done);
    });
  }

  /** The position after which a read starts (§8.5): unknown → `invalid_cursor`, pruned → expired. */
  async #cursorSeq(conversation: PoppyConversationRecord, cursor?: string): Promise<number> {
    if (cursor === undefined) return 0;
    const seq = await this.options.store.findEventSeq(conversation.id, cursor);
    if (seq !== null) return seq;
    const minted = eventIdSeq(cursor);
    const current = await this.#fresh(conversation);
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
    if (conversation.working && !this.#pumps.has(conversation.id)) {
      this.#kick(conversation.id);
    }
  }

  /**
   * Run `act` after the handoff requests and cancels accepted before it (§8.3). Registered while
   * the request is accepted (under the conversation's lock), so the order is the acceptance order;
   * run outside that lock, so a hook may drive the conversation.
   */
  #inOrder(conversationId: string, act: () => Promise<unknown>): Promise<unknown> {
    return this.#chain(this.#actions, conversationId, act);
  }

  /** `POST {endpoint}/{id}/handoff` — ask for a person at the Company (§8.9). Answers `202`. */
  async requestHandoff(
    principal: PoppyPrincipal,
    conversationId: string,
    body: PoppyRequestBody,
  ): Promise<PoppyAccepted> {
    let action: Promise<unknown> | null = null;
    const accepted = await this.#acceptOn(
      principal,
      conversationId,
      { id: body.id, path: `${conversationId}/handoff`, body: {} },
      async (conversation) => {
        await this.#update(conversation, await this.#requestPatch(principal, conversation));
        action = this.#inOrder(conversationId, () => this.#handoff(conversationId, 'requested'));
      },
    );
    await action;
    return accepted;
  }

  /** `POST {endpoint}/{id}/handoff/cancel` — withdraw a request for a person (§8.9). Answers `202`. */
  async cancelHandoff(
    principal: PoppyPrincipal,
    conversationId: string,
    body: PoppyRequestBody,
  ): Promise<PoppyAccepted> {
    let action: Promise<unknown> | null = null;
    const accepted = await this.#acceptOn(
      principal,
      conversationId,
      { id: body.id, path: `${conversationId}/handoff/cancel`, body: {} },
      async (conversation) => {
        await this.#update(conversation, await this.#requestPatch(principal, conversation));
        action = this.#inOrder(conversationId, () => this.#withdraw(conversationId));
      },
    );
    await action;
    return accepted;
  }

  async #handoff(conversationId: string, by: 'requested' | 'company'): Promise<PoppyState> {
    const conversation = await this.#require(conversationId);
    // Closed, already with a person, or being found one: nothing more to ask for (§8.9).
    if (
      conversation.closed ||
      conversation.handoff === 'pending' ||
      conversation.responder === 'human'
    ) {
      return stateOf(conversation);
    }
    const hooks = this.options.handoff;
    if (!hooks) {
      // No people to hand off to: the Company Agent says so, and keeps the conversation (§8.9).
      await this.#append(conversation.id, {
        type: 'message',
        message: this.#companyMessage(this.#texts.handoffUnavailable, undefined, { type: 'agent' }),
      });
      return stateOf(conversation);
    }
    const pending = await this.#locked(conversationId, async () =>
      this.#update(await this.#fresh(conversation), { handoff: 'pending' }),
    );
    let decision: PoppyHandoffDecision;
    try {
      decision = await hooks.request({
        conversationId,
        conversation: pending,
        actor: pending.grant?.actor ?? null,
        by,
      });
    } catch (error) {
      this.options.onError?.(error, 'poppy: handoff.request failed');
      decision = { unavailable: this.#texts.handoffUnavailable };
    }
    if (decision === 'joined') return this.humanJoined(conversationId);
    if (typeof decision === 'object') {
      return this.handoffUnavailable(conversationId, decision.unavailable);
    }
    return stateOf(await this.#require(conversationId));
  }

  async #withdraw(conversationId: string): Promise<void> {
    const conversation = await this.#require(conversationId);
    // A cancel when handoff isn't pending changes nothing (§8.9).
    if (conversation.closed || conversation.handoff !== 'pending') return;
    let stop: boolean | undefined = true;
    try {
      stop = await this.options.handoff?.withdraw?.({
        conversationId,
        conversation,
        actor: conversation.grant?.actor ?? null,
      });
    } catch (error) {
      // The help desk could not withdraw it: keep looking.
      this.options.onError?.(error, 'poppy: handoff.withdraw hook failed');
      stop = false;
    }
    if (stop === false) return;
    await this.#locked(conversationId, async () => {
      const current = await this.#require(conversationId);
      if (current.handoff === 'pending') await this.#update(current, { handoff: 'none' });
    });
  }

  /**
   * `POST {endpoint}/{id}/close` — close the conversation (§8.12). Answers `202`, also on a
   * conversation already closed. A close does not wait its turn.
   */
  async closeByAgent(
    principal: PoppyPrincipal,
    conversationId: string,
    body: PoppyRequestBody,
  ): Promise<PoppyAccepted> {
    await this.#owned(principal, conversationId, 'write');
    const prior = await this.#claim(
      principal,
      body.id,
      `${conversationId}/close`,
      {},
      conversationId,
      202,
    );
    if (prior !== null) return prior.response as PoppyAccepted;
    await this.close(conversationId);
    return { status: 202, body: { conversation_id: conversationId } };
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
   * Close a conversation (§8.12): its open Direct Conversation first; a pending handoff stops, and
   * a `state` event says `closed`. Requests not acted on yet are dropped. Nothing it started is
   * undone. Idempotent.
   */
  async close(conversationId: string): Promise<PoppyState> {
    const conversation = await this.#require(conversationId);
    if (conversation.closed) return stateOf(conversation);
    if (conversation.openDirectId !== null) {
      const direct = await this.options.store.getConversation(conversation.openDirectId);
      if (direct && !direct.closed) await this.close(direct.id);
    }
    const before = (await this.options.store.getConversation(conversationId)) ?? conversation;
    const closed = await this.#locked(conversationId, async () => {
      const current = (await this.options.store.getConversation(conversationId)) ?? before;
      if (current.closed) return current;
      // Closed: not working, handoff none, responder whoever handled it last (§8.7).
      return this.#update(current, { closed: true, working: false, handoff: 'none', prompt: null });
    });
    if (before.handoff === 'pending' || before.responder === 'human') {
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
    return stateOf(closed);
  }

  /** The Company Agent hands off to a person on its own (§8.9) — e.g. from one of your tools. */
  async handoff(conversationId: string): Promise<PoppyState> {
    const conversation = await this.#require(conversationId);
    if (conversation.closed) throw new PoppyError('conversation_closed');
    return this.#inOrder(conversationId, () =>
      this.#handoff(conversationId, 'company'),
    ) as Promise<PoppyState>;
  }

  /**
   * A person at the Company joined: `handoff` none, `responder` human (§8.7, §8.9). The messages
   * the agent had not taken up yet go to the `handoff.message` hook.
   */
  async humanJoined(conversationId: string): Promise<PoppyState> {
    const { updated, backlog } = await this.#locked(conversationId, async () => {
      const conversation = await this.#require(conversationId);
      if (conversation.closed) throw new PoppyError('conversation_closed');
      const waiting = await this.#unanswered(conversation);
      const lastSeq = waiting.at(-1)?.seq;
      const updated = await this.#update(conversation, {
        handoff: 'none',
        responder: 'human',
        prompt: null,
        ...(lastSeq !== undefined ? { turnSeq: lastSeq } : {}),
      });
      return { updated, backlog: waiting.map((entry) => entry.message) };
    });
    for (const message of backlog) {
      await this.#hook('handoff.message', () =>
        this.options.handoff?.message?.({
          conversationId,
          conversation: updated,
          actor: updated.grant?.actor ?? null,
          message,
        }),
      );
    }
    // A turn may still be writing a reply; the pump settles `working` once nothing is left.
    if (updated.working) this.#kick(conversationId);
    return stateOf(updated);
  }

  /** The person left: the Company Agent answers again. */
  async humanLeft(conversationId: string): Promise<PoppyState> {
    return this.#locked(conversationId, async () => {
      const conversation = await this.#require(conversationId);
      if (conversation.closed) return stateOf(conversation);
      return stateOf(await this.#update(conversation, { responder: 'agent' }));
    });
  }

  /**
   * No one could take a pending handoff: the Company Agent says why, and `handoff` goes back to
   * `none` with the agent (§8.9).
   */
  async handoffUnavailable(
    conversationId: string,
    reason: string = this.#texts.handoffUnavailable,
  ): Promise<PoppyState> {
    return this.#locked(conversationId, async () => {
      const conversation = await this.#require(conversationId);
      if (conversation.handoff !== 'pending') return stateOf(conversation);
      await this.#append(conversationId, {
        type: 'message',
        message: this.#companyMessage(reason, undefined, { type: 'agent' }),
      });
      return stateOf(await this.#update(conversation, { handoff: 'none', responder: 'agent' }));
    });
  }

  /**
   * Add a Company message — a person's (`author.type: 'human'`, while they handle the conversation) or
   * an automated one. Answers the message's id.
   */
  async postMessage(
    conversationId: string,
    message: { text?: string; data?: Record<string, unknown>; author: PoppyAuthor },
  ): Promise<string> {
    const conversation = await this.#require(conversationId);
    if (conversation.closed) throw new PoppyError('conversation_closed');
    const event = this.#companyMessage(message.text, message.data, message.author);
    await this.#append(conversationId, { type: 'message', message: event });
    return event.id;
  }

  /**
   * Ask to talk with the User directly (§8.10): a `user_requested` event. Only the Personal Agent
   * opens the Direct Conversation, once the User agrees. Answers the event's ID.
   */
  async requestUser(conversationId: string, reason: string): Promise<string> {
    const conversation = await this.#require(conversationId);
    if (conversation.closed) throw new PoppyError('conversation_closed');
    if (conversation.parentId !== null) {
      throw new PoppyError('invalid_request', 'A Direct Conversation already has the User');
    }
    return (await this.#append(conversationId, { type: 'user_requested', reason })).event.id;
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
        if (!conversation || conversation.closed) return;
        if (conversation.activeRunId !== null) {
          // A turn whose writer died: write its reply from the run's own stream.
          await this.#recover(conversation, conversation.activeRunId);
          continue;
        }
        // Decided under the lock a send takes, so a message accepted meanwhile is never left
        // behind a conversation that is no longer `working`.
        const waiting = await this.#locked(conversationId, async () => {
          const current = await store.getConversation(conversationId);
          if (!current || current.closed) return null;
          const toAgent = current.responder === 'agent';
          const found = toAgent
            ? (await this.#unanswered(current)).filter((entry) => hasContent(entry.message))
            : [];
          const prompt = toAgent ? current.prompt : null;
          if (found.length === 0 && prompt === null) {
            // Everything accepted was acted on: the Company is no longer replying (§8.7).
            if (current.working) await this.#update(current, { working: false });
            return null;
          }
          const working = current.working
            ? current
            : await this.#update(current, { working: true });
          return { current: working, found, prompt };
        });
        if (waiting === null) {
          if (!this.#rekick.has(conversationId)) return;
          continue;
        }
        await this.#turn(
          waiting.current,
          waiting.found.map((entry) => entry.message),
          waiting.found.at(-1)?.seq ?? waiting.current.turnSeq,
          waiting.prompt,
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
    prompt: string | null,
  ): Promise<void> {
    const grant = conversation.grant;
    if (!grant) {
      await this.options.store.updateConversation(conversation.id, {
        turnSeq: upToSeq,
        prompt: null,
      });
      return;
    }
    // The latest request the turn takes into account (§8.4): its last message — whose ID is its
    // request's. A turn on the prompt alone has none.
    const asOfRequest = messages.at(-1)?.id;
    const text = [prompt ?? '', turnText(messages)].filter((part) => part !== '').join('\n\n');
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
          text,
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
              sender: last?.author?.type ?? 'agent',
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
              prompt: null,
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
          ...(asOfRequest !== undefined ? { asOfRequest } : {}),
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
          await this.options.store.updateConversation(conversation.id, {
            turnSeq: upToSeq,
            prompt: null,
          });
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
   * then an `authorization` event when the turn needed a scope the token does not carry (§8.11).
   */
  async #reply(
    conversation: PoppyConversationRecord,
    grant: PoppyGrant,
    runId: string,
    turn: {
      text: string;
      components: Extract<StreamFrame, { t: 'component' }>[];
      outcomes: PoppyActionOutcome[];
      permission: string[] | null;
      failed: boolean;
      asOfRequest?: string;
    },
  ): Promise<void> {
    const store = this.options.store;
    const current = await store.getConversation(conversation.id);
    await store.updateConversation(conversation.id, { activeRunId: null });
    // A closed conversation takes no more message events (§8.12).
    if (!current || current.closed) return;

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
    // Every action is told in words too: a reader that ignores `data` still learns what was done.
    // The model wrote its text before an action's result — so when one did not go through, the
    // reply is the actions' own account (the streamed deltas are provisional and get replaced).
    if (turn.outcomes.length > 0) {
      const format = this.options.formatAction ?? formatPoppyAction;
      const told = turn.outcomes
        .map((action) => format(action, this.#texts)?.trim() ?? '')
        .filter((line) => line !== '')
        .join('\n\n');
      const allDone = turn.outcomes.every((action) => action.status === 'succeeded');
      if (!allDone || text === '') text = told;
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
            { type: 'agent' },
            derivedPoppyId('msg', `reply:${runId}`),
            turn.asOfRequest,
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
          error: 'insufficient_scope',
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
              { type: 'agent' },
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
