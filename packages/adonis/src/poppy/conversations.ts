import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { scopeRole } from '../a2a/gate.js';
import { PERSONAL_AGENT_ROLE } from '../a2a/permission-tool.js';
import {
  type A2aActionPolicy,
  type A2aParkedAction,
  type A2aParkedDecision,
  type A2aTurnOutcome,
  type A2aTurnService,
  runA2aTurn,
} from '../a2a/turn.js';
import type { StreamFrame } from '../spi/token-stream-sink.js';
import { humanizeToolName } from '../tool-presentation.js';
import type { Actor } from '../types.js';
import type { PoppyAuthRequest, PoppyPrincipal } from './auth.js';
import { announcedPoppyEndpoints } from './endpoints.js';
import {
  declineOf,
  formatPoppyApproval,
  globalPoppyOperations,
  operationOf,
  POPPY_OPERATIONS_EXTENSION,
  POPPY_OPERATIONS_VERSION,
  type PoppyApproval,
  type PoppyDecline,
  type PoppyOperation,
  type PoppyOperationsService,
  parsePoppyApproval,
} from './operations.js';
import {
  checkPoppyAddons,
  derivedPoppyId,
  isCompatiblePoppyVersion,
  newPoppyId,
  POPPY_DISCLOSURES_VERSION,
  POPPY_LINKS_VERSION,
  POPPY_PROTOCOL_VERSION,
  type PoppyAuthor,
  type PoppyContext,
  PoppyError,
  type PoppyEvent,
  type PoppyEventBody,
  type PoppyEventMessage,
  type PoppyInboundMessage,
  type PoppyMessageAddons,
  type PoppyRequestBody,
  type PoppySendBody,
  type PoppyState,
  requestFingerprint,
} from './protocol.js';
import {
  eventIdSeq,
  type PoppyConversationOperation,
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
  /**
   * What the Company Agent reads for an action held for approval (Operations extension) — the
   * tool's answer; the action did not run.
   */
  operationHeld: string;
  /** A message that carries an operation, when nothing else was said. `{summary}`. */
  operationRequired: string;
  /** A message that carries a declined approval. `{summary}`, `{reason}`. */
  operationDeclined: string;
  /**
   * Given to the Company Agent — never shown — when an approval lets it perform a held action:
   * `{summary}`, `{tool}`, `{input}` (JSON).
   */
  operationApproved: string;
  /** An approval of an operation this conversation never asked for. `{operation}`. */
  operationUnknown: string;
  /** An approved action that is still being performed. `{summary}`. */
  operationPerforming: string;
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
  operationHeld:
    "Not done yet: this action needs the approval of the user's personal agent. Say what it will do; it runs once they approve.",
  operationRequired: 'This needs your approval: {summary}',
  operationDeclined: 'This was not done: {summary}',
  operationApproved:
    "The user's personal agent approved this action: {summary}. Perform it now: call `{tool}` with exactly this input: {input}",
  operationUnknown:
    'An approval arrived for operation {operation}, which this conversation did not ask for. Nothing was performed.',
  operationPerforming: 'This is still being done: {summary}',
};

/**
 * Conversations with the Operations extension (version 3): an action that waits for approval is
 * not performed — the Company Agent's message carries the operation, and the action runs once the
 * Personal Agent sends its approval in a later message. Used only when the request declares
 * `"operations";v="3"`; the operations service stores and verifies them.
 */
export interface PoppyOperationsOptions {
  /** The operations service. Default: the one in `Symbol.for('@adonis-agora/poppy:operations')`. */
  service?: PoppyOperationsService;
  /** Which actions are operations. Default: every action that waits for approval. */
  requires?: (
    action: A2aParkedAction & { conversation: PoppyConversationRecord },
  ) => boolean | Promise<boolean>;
  /**
   * The operation's words and terms. Default: the tool's confirmation as `summary` (its name and
   * input without one), `{ tool, input }` as `terms`.
   */
  describe?: (
    action: A2aParkedAction & { conversation: PoppyConversationRecord },
  ) => PoppyOperationTerms | Promise<PoppyOperationTerms>;
  /** How long an approval may take, in ms. Default 15 minutes. */
  expiresInMs?: number;
}

/** What {@link PoppyOperationsOptions.describe} answers. */
export interface PoppyOperationTerms {
  summary?: string;
  terms?: Record<string, unknown>;
  expiresAt?: Date | string;
}

/** What the Company Agent's reply carries besides text and data: links, disclosures. */
export type PoppyReplyAddons = (
  ctx: PoppyHookContext & { text: string; data?: Record<string, unknown> },
) => PoppyMessageAddons | undefined | Promise<PoppyMessageAddons | undefined>;

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
  /**
   * The Operations extension. Default: on when an operations service is installed in
   * `Symbol.for('@adonis-agora/poppy:operations')`; `false` turns it off.
   */
  operations?: boolean | PoppyOperationsOptions;
  /** Links and disclosures for each reply of the Company Agent (Links and Disclosures extensions). */
  replyAddons?: PoppyReplyAddons;
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

/** Whether a message says something to the Company Agent: text or data. */
const saysSomething = (message: Pick<PoppyEventMessage, 'text' | 'data'>) =>
  (message.text !== undefined && message.text.trim() !== '') || message.data !== undefined;

/** The approval a message carries (`extensions.operations.approval`), if any. */
function approvalOf(message: Pick<PoppyEventMessage, 'extensions'>): PoppyApproval | null {
  const content = message.extensions?.[POPPY_OPERATIONS_EXTENSION] as
    | { approval?: unknown }
    | undefined;
  return content?.approval !== undefined ? parsePoppyApproval(content.approval) : null;
}

/** Whether a message needs acting on: something said, or an approval. */
const hasContent = (message: Pick<PoppyEventMessage, 'text' | 'data' | 'extensions'>) =>
  saysSomething(message) || approvalOf(message) !== null;

/** Stable JSON, keys sorted — what tells an action's input apart from another's. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Which action a tool call is: its tool and input. */
function actionKey(tool: string, input: unknown): string {
  return createHash('sha256')
    .update(`${tool}\n${canonicalJson(input)}`)
    .digest('base64url');
}

/** What an approval leaves for the turn that answers it. */
interface ApprovalWork {
  /** Said to the Company Agent before the messages. */
  notes: string[];
  /** Approved proposals that ran (or did not). */
  outcomes: PoppyActionOutcome[];
  /** New operations (revisions) and declines to send. */
  operations: PoppyOperation[];
  declines: { decline: PoppyDecline; summary: string }[];
  /** Plain statements for the User (an approval still being performed). */
  said: string[];
  /** Approved calls the Company Agent is to make now. */
  approvedCalls: number;
}

const DEFAULT_OPERATION_TTL_MS = 15 * 60_000;

/** An operation's default summary: the tool's confirmation, else its name and input. */
function defaultSummary(action: A2aParkedAction): string {
  const confirmation = action.confirmation;
  if (confirmation) {
    const title = confirmation.title.trim().replace(/\?+$/, '');
    return confirmation.detail ? `${title}\n\n${confirmation.detail}` : title;
  }
  return `${humanizeToolName(action.toolName) || action.toolName}: ${JSON.stringify(action.input ?? null)}`;
}

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
    const { actor: _actor, ...rest } = principal;
    return {
      actor,
      scopes: principal.signedIn ? [...principal.scopes] : [],
      signedIn: principal.signedIn,
      extensions: { ...(principal.extensions ?? {}) },
      principal: rest,
    };
  }

  /**
   * The extension content of a Personal Agent message this surface acts on (§3.3, §8.4): an
   * Operations approval, when the request declares Operations v3 and operations are on. Everything
   * else is ignored — links and disclosures too, which only Company messages carry.
   */
  #inbound(principal: PoppyPrincipal, message: PoppyInboundMessage): PoppyInboundMessage {
    if (message.extensions === undefined) return message;
    const { extensions, ...rest } = message;
    const kept: Record<string, unknown> = {};
    const content = extensions[POPPY_OPERATIONS_EXTENSION] as { approval?: unknown } | undefined;
    if (
      content?.approval !== undefined &&
      this.#operationsFor(principal.extensions) !== undefined
    ) {
      const approval = parsePoppyApproval(content.approval);
      if (approval === null) {
        throw new PoppyError(
          'invalid_request',
          'extensions.operations.approval needs operation_id, revision and approver',
        );
      }
      kept[POPPY_OPERATIONS_EXTENSION] = { approval };
    }
    return Object.keys(kept).length > 0 ? { ...rest, extensions: kept } : rest;
  }

  // ── operations ─────────────────────────────────────────────────────────────

  #operationsWarned = false;

  /** The operations service, when operations are on; `undefined` → off. */
  #operationsService(): PoppyOperationsService | undefined {
    const setting = this.options.operations;
    if (setting === false) return undefined;
    const service =
      (typeof setting === 'object' ? setting.service : undefined) ?? globalPoppyOperations();
    if (service === undefined && setting !== undefined && !this.#operationsWarned) {
      this.#operationsWarned = true;
      this.options.onError?.(
        new Error(
          "poppy: operations are on, but no operations service is installed in Symbol.for('@adonis-agora/poppy:operations') — install @adonis-agora/authkit-poppy with operations enabled, or pass operations.service. Until then conversations ask for no approvals.",
        ),
        'poppy: operations are off',
      );
    }
    return service;
  }

  /** Whether conversations ask for approval with operations (a service is there, and not turned off). */
  get operationsEnabled(): boolean {
    return this.#operationsService() !== undefined;
  }

  /** The operations service, when the request declared Operations v3 (Operations §2). */
  #operationsFor(extensions: Record<string, string> | undefined) {
    if (extensions?.[POPPY_OPERATIONS_EXTENSION] !== POPPY_OPERATIONS_VERSION) return undefined;
    return this.#operationsService();
  }

  #operationsOptions(): PoppyOperationsOptions {
    return typeof this.options.operations === 'object' ? this.options.operations : {};
  }

  /** Who an operation is asked for: the conversation's latest request. */
  #principalOf(conversation: PoppyConversationRecord, grant: PoppyGrant): PoppyPrincipal {
    return grant.principal
      ? { ...grant.principal, actor: grant.actor }
      : {
          userId: conversation.userId,
          clientId: conversation.clientId,
          accountId: grant.signedIn ? conversation.accountRef : null,
          scopes: grant.scopes,
          sessionId: '',
          signedIn: grant.signedIn,
          actor: grant.actor,
          extensions: grant.extensions ?? {},
        };
  }

  /**
   * The request the operations service is given for a conversation: the messages URL, and the
   * approval also as a `Poppy-Approval` header, for a service that reads only that.
   */
  #operationsRequest(
    conversation: PoppyConversationRecord,
    grant: PoppyGrant,
    approval: PoppyApproval | null,
  ): PoppyAuthRequest {
    const endpoint = announcedPoppyEndpoints().conversations;
    return {
      method: 'POST',
      url: endpoint
        ? `${endpoint}/${conversation.id}/messages`
        : `urn:poppy:conversation:${conversation.id}`,
      headers: {
        'poppy-version': grant.principal?.protocolVersion ?? POPPY_PROTOCOL_VERSION,
        'poppy-extensions': `"${POPPY_OPERATIONS_EXTENSION}";v="${POPPY_OPERATIONS_VERSION}"`,
        ...(approval !== null ? { 'poppy-approval': formatPoppyApproval(approval) } : {}),
      },
    };
  }

  async #saveOperation(conversationId: string, operation: PoppyConversationOperation) {
    const current = await this.options.store.getConversation(conversationId);
    await this.options.store.updateConversation(conversationId, {
      operations: {
        ...(current?.operations ?? {}),
        [operation.operationId]: { ...operation, updatedAt: Date.now() },
      },
    });
  }

  #operationAction(conversationId: string, tool: string, input: unknown): string {
    return `poppy-conversation:${conversationId}:${actionKey(tool, input)}`;
  }

  #approvedNote(operation: PoppyConversationOperation): string {
    return this.#texts.operationApproved
      .replaceAll('{summary}', operation.summary ?? humanizeToolName(operation.tool))
      .replaceAll('{tool}', operation.tool)
      .replaceAll('{input}', JSON.stringify(operation.input ?? null));
  }

  /**
   * An action parked for approval during a turn. Approved already (same tool, same input, not
   * expired) → it runs now, once. Otherwise it is held, and the operations service returns the
   * operation the reply carries (Operations §4).
   */
  async #onParked(
    conversation: PoppyConversationRecord,
    grant: PoppyGrant,
    service: PoppyOperationsService,
    action: A2aParkedAction,
    held: Map<string, PoppyOperation>,
    performing: string[],
  ): Promise<A2aParkedDecision> {
    const current = await this.#fresh(conversation);
    const key = actionKey(action.toolName, action.input);
    const existing = Object.values(current.operations ?? {}).find(
      (operation) =>
        operation.status !== 'performed' && actionKey(operation.tool, operation.input) === key,
    );
    const summaryOf = (operation: PoppyConversationOperation) =>
      operation.summary ?? humanizeToolName(operation.tool);
    if (existing?.status === 'approved' && action.kind === 'call') {
      if (Date.parse(existing.expiresAt) > Date.now()) {
        await this.#saveOperation(current.id, { ...existing, status: 'performing' });
        performing.push(existing.operationId);
        return 'approve';
      }
    }
    if (existing?.status === 'performing') {
      return { hold: this.#texts.operationPerforming.replaceAll('{summary}', summaryOf(existing)) };
    }
    const options = this.#operationsOptions();
    const context = { ...action, conversation: current };
    if (options.requires && !(await options.requires(context))) return undefined;
    const described = options.describe ? await options.describe(context) : {};
    const ttl = Date.now() + (options.expiresInMs ?? DEFAULT_OPERATION_TTL_MS);
    const lapses = action.expiresAt !== undefined ? Date.parse(action.expiresAt) : Number.NaN;
    const summary = described.summary ?? defaultSummary(action);
    const terms = described.terms ?? { tool: action.toolName, input: action.input ?? null };
    let result: Awaited<ReturnType<PoppyOperationsService['require']>>;
    try {
      result = await service.require(
        this.#operationsRequest(current, grant, null),
        this.#principalOf(current, grant),
        {
          interface: 'conversation',
          action: this.#operationAction(current.id, action.toolName, action.input),
          terms,
          summary,
          expiresAt:
            described.expiresAt ??
            new Date(Number.isNaN(lapses) ? ttl : Math.min(lapses, ttl)).toISOString(),
          conversationId: current.id,
          approval: null,
          ...(existing ? { operationId: existing.operationId } : {}),
        },
      );
    } catch (error) {
      this.options.onError?.(error, 'poppy: the operations service failed');
      return { hold: this.#texts.operationHeld };
    }
    // The service needs no approval for it: the policy decides, as without operations.
    if (result.ok) return undefined;
    const operation = operationOf(result.body);
    if (result.body.error !== 'approval_required' || operation === null) {
      this.options.onError?.(
        new Error(
          `poppy: the operations service answered ${result.status} ${String(result.body.error ?? '')} for ${action.toolName}`,
        ),
        'poppy: no operation to ask approval for',
      );
      return { hold: this.#texts.operationHeld };
    }
    const now = Date.now();
    await this.#saveOperation(current.id, {
      operationId: operation.operation_id,
      revision: operation.revision,
      expiresAt: operation.expires_at,
      summary: operation.summary ?? summary,
      terms: operation.terms,
      tool: action.toolName,
      input: action.input ?? null,
      proposalId: action.kind === 'proposal' ? (action.proposalId ?? null) : null,
      status: 'pending',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    held.set(operation.operation_id, operation);
    return { hold: this.#texts.operationHeld };
  }

  /**
   * An approval in a message (Operations §6): the operation must be this conversation's and not
   * performed; the operations service checks the revision. Then a held proposal runs now, a held
   * call when the Company Agent makes it again — or the approval is declined, or a new revision
   * is returned. A performed operation's approval adds nothing (§7).
   */
  async #onApproval(
    conversation: PoppyConversationRecord,
    grant: PoppyGrant,
    service: PoppyOperationsService,
    approval: PoppyApproval,
    work: ApprovalWork,
  ): Promise<void> {
    const current = await this.#fresh(conversation);
    const operation = current.operations?.[approval.operation_id];
    if (operation === undefined) {
      work.said.push(this.#texts.operationUnknown.replaceAll('{operation}', approval.operation_id));
      return;
    }
    const summary = operation.summary ?? humanizeToolName(operation.tool);
    if (operation.status === 'performed') return;
    if (operation.status === 'performing') {
      work.said.push(this.#texts.operationPerforming.replaceAll('{summary}', summary));
      return;
    }
    if (operation.status === 'approved') {
      work.approvedCalls++;
      work.notes.push(this.#approvedNote(operation));
      return;
    }
    // An expired revision fails the check: a new one is returned (Operations §6).
    const expired = Date.parse(operation.expiresAt) <= Date.now();
    const ttl = this.#operationsOptions().expiresInMs ?? DEFAULT_OPERATION_TTL_MS;
    let result: Awaited<ReturnType<PoppyOperationsService['require']>>;
    try {
      result = await service.require(
        this.#operationsRequest(current, grant, expired ? null : approval),
        this.#principalOf(current, grant),
        {
          interface: 'conversation',
          action: this.#operationAction(current.id, operation.tool, operation.input),
          operationId: operation.operationId,
          terms: operation.terms,
          ...(operation.summary !== undefined ? { summary: operation.summary } : {}),
          expiresAt: expired ? new Date(Date.now() + ttl).toISOString() : operation.expiresAt,
          conversationId: current.id,
          approval: expired ? null : approval,
        },
      );
    } catch (error) {
      this.options.onError?.(error, 'poppy: the operations service failed');
      work.said.push(this.#texts.failed);
      return;
    }
    if (result.ok && !expired) {
      if (operation.proposalId !== null) {
        await this.#saveOperation(current.id, { ...operation, status: 'performing' });
        const outcome = await this.#performProposal(current, grant, operation);
        if (outcome === null) {
          work.said.push(this.#texts.operationPerforming.replaceAll('{summary}', summary));
          return;
        }
        await this.#saveOperation(current.id, { ...operation, status: 'performed' });
        await service
          .markPerformed(operation.operationId)
          .catch((error) => this.options.onError?.(error, 'poppy: markPerformed failed'));
        work.outcomes.push(outcome);
        return;
      }
      await this.#saveOperation(current.id, {
        ...operation,
        revision: approval.revision,
        status: 'approved',
      });
      work.approvedCalls++;
      work.notes.push(this.#approvedNote(operation));
      return;
    }
    if (!result.ok && result.body.error === 'approval_declined') {
      work.declines.push({ decline: declineOf(result.body, approval), summary });
      return;
    }
    const renewed = result.ok ? null : operationOf(result.body);
    // Never answer an approval with the revision it names (Operations §6).
    if (renewed !== null && renewed.revision !== approval.revision) {
      await this.#saveOperation(current.id, {
        ...operation,
        revision: renewed.revision,
        expiresAt: renewed.expires_at,
        terms: renewed.terms,
        summary: renewed.summary ?? operation.summary ?? summary,
      });
      work.operations.push(renewed);
      return;
    }
    if (!result.ok && result.status === 503) {
      work.said.push(this.#texts.operationPerforming.replaceAll('{summary}', summary));
      return;
    }
    this.options.onError?.(
      new Error(
        `poppy: the operations service did not accept the approval of ${operation.operationId} (${result.ok ? 'expired' : `${result.status} ${String(result.body.error ?? '')}`})`,
      ),
      'poppy: approval not accepted',
    );
    work.said.push(
      this.#texts.operationDeclined.replaceAll('{summary}', summary).replaceAll('{reason}', ''),
    );
  }

  /** Decide a held proposal approved and wait for it to run. `null`: still running at the deadline. */
  async #performProposal(
    conversation: PoppyConversationRecord,
    grant: PoppyGrant,
    operation: PoppyConversationOperation,
  ): Promise<PoppyActionOutcome | null> {
    const service = this.options.service;
    const fallback = { title: operation.summary ?? humanizeToolName(operation.tool) };
    const { decideActionProposal, listActionProposals } = service;
    const threadId = conversation.threadId;
    const proposalId = operation.proposalId;
    if (!decideActionProposal || !listActionProposals || threadId === null || proposalId === null) {
      return { tool: operation.tool, status: 'failed', summary: fallback, error: 'not available' };
    }
    try {
      await decideActionProposal.call(
        service,
        grant.actor,
        threadId,
        proposalId,
        'approved',
        {},
        'poppy',
      );
    } catch (error) {
      return {
        tool: operation.tool,
        status: 'failed',
        summary: fallback,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const deadline = Date.now() + (this.options.timeoutMs ?? 120_000);
    while (Date.now() < deadline && !this.#closed) {
      const listed = await listActionProposals.call(service, grant.actor, threadId);
      const found = listed.find((proposal) => proposal.id === proposalId);
      const confirmation = found?.confirmation;
      const summary = confirmation
        ? {
            title: confirmation.title,
            ...(confirmation.detail ? { detail: confirmation.detail } : {}),
          }
        : fallback;
      const status = found?.execution?.status;
      if (found?.decision !== 'approved' || status === 'failed') {
        return {
          tool: operation.tool,
          status: 'failed',
          summary,
          error: found?.execution?.error ?? `${operation.tool} did not run`,
        };
      }
      if (status === 'succeeded') {
        return {
          tool: operation.tool,
          status: 'succeeded',
          summary,
          ...(found.execution?.result !== undefined ? { result: found.execution.result } : {}),
        };
      }
      await sleep(250);
    }
    return null;
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
    extensions?: Record<string, unknown>,
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
      ...(extensions !== undefined && Object.keys(extensions).length > 0 ? { extensions } : {}),
    };
  }

  /**
   * Links and disclosures in a Company message (Links, Disclosures extensions): as extension
   * content to a Personal Agent whose latest request declares them in the same version (§8.4);
   * otherwise in the text — a disclosure always reaches the User.
   */
  #withAddons(
    declared: Record<string, string>,
    text: string,
    addons: PoppyMessageAddons | undefined,
  ): { text: string; extensions: Record<string, unknown> } {
    if (addons === undefined) return { text, extensions: {} };
    const checked = checkPoppyAddons(addons);
    const extensions: Record<string, unknown> = {};
    const inText: string[] = [];
    if (checked.disclosures) {
      if (declared.disclosures === POPPY_DISCLOSURES_VERSION) {
        extensions.disclosures = { items: checked.disclosures };
      } else {
        inText.push(...checked.disclosures.map((disclosure) => disclosure.text));
      }
    }
    if (checked.links) {
      if (declared.links === POPPY_LINKS_VERSION) {
        extensions.links = { items: checked.links };
      } else {
        inText.push(
          checked.links
            .map((link) => (link.title ? `${link.title}: ${link.url}` : link.url))
            .join('\n'),
        );
      }
    }
    return {
      text: [text, ...inText].filter((part) => part.trim() !== '').join('\n\n'),
      extensions,
    };
  }

  /** The extensions a conversation's latest request declared (§3.4). */
  #declared(conversation: PoppyConversationRecord): Record<string, string> {
    return conversation.grant?.extensions ?? conversation.extensions;
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
    if (body.message !== undefined)
      body = { ...body, message: this.#inbound(principal, body.message) };
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
    if (body.message === undefined) throw new PoppyError('invalid_request', 'message is required');
    const message = this.#inbound(principal, body.message);
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
    message: {
      text?: string;
      data?: Record<string, unknown>;
      author: PoppyAuthor;
      /** Pages the message refers to (Links extension). */
      links?: PoppyMessageAddons['links'];
      /** Notices that matter whatever else it says (Disclosures extension). */
      disclosures?: PoppyMessageAddons['disclosures'];
    },
  ): Promise<string> {
    const conversation = await this.#require(conversationId);
    if (conversation.closed) throw new PoppyError('conversation_closed');
    const composed = this.#withAddons(this.#declared(conversation), message.text ?? '', {
      ...(message.links !== undefined ? { links: message.links } : {}),
      ...(message.disclosures !== undefined ? { disclosures: message.disclosures } : {}),
    });
    const event = this.#companyMessage(
      composed.text,
      message.data,
      message.author,
      undefined,
      undefined,
      composed.extensions,
    );
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
    // Approvals first (Operations §6): what they ran, declined or renewed, and what the Company
    // Agent is to do now.
    const operations = this.#operationsFor(grant.extensions);
    const work: ApprovalWork = {
      notes: [],
      outcomes: [],
      operations: [],
      declines: [],
      said: [],
      approvedCalls: 0,
    };
    if (operations !== undefined) {
      for (const message of messages) {
        const approval = approvalOf(message);
        if (approval !== null) {
          await this.#onApproval(conversation, grant, operations, approval, work);
        }
      }
    }
    if (prompt === null && !messages.some(saysSomething) && work.approvedCalls === 0) {
      // Only approvals: the Company answers them without the model.
      const key = `operations:${asOfRequest ?? upToSeq}`;
      await this.options.store.updateConversation(conversation.id, {
        turnSeq: upToSeq,
        prompt: null,
      });
      await this.#reply(conversation, grant, key, {
        text: '',
        components: [],
        outcomes: work.outcomes,
        permission: null,
        failed: false,
        operations: work.operations,
        declines: work.declines,
        said: work.said,
        ...(asOfRequest !== undefined ? { asOfRequest } : {}),
      });
      return;
    }
    const held = new Map<string, PoppyOperation>();
    const performing: string[] = [];
    const text = [prompt ?? '', ...work.notes, turnText(messages)]
      .filter((part) => part !== '')
      .join('\n\n');
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
          ...(operations !== undefined
            ? {
                onParked: (action: A2aParkedAction) =>
                  this.#onParked(conversation, grant, operations, action, held, performing),
              }
            : {}),
          onStarted: async (startedThreadId, startedRunId) => {
            runId = startedRunId;
            replyId = derivedPoppyId('msg', `reply:${startedRunId}`);
            await this.options.store.updateConversation(conversation.id, {
              threadId: startedThreadId,
              activeRunId: startedRunId,
              // A reply written by another process after this one died still says it (§8.4).
              asOfRequest: asOfRequest ?? null,
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
        // A held call approved this turn ran once: it is performed (Operations §7).
        for (const operationId of performing) {
          const current = (await this.#fresh(conversation)).operations?.[operationId];
          if (current !== undefined) {
            await this.#saveOperation(conversation.id, { ...current, status: 'performed' });
          }
          await operations
            ?.markPerformed(operationId)
            .catch((error) => this.options.onError?.(error, 'poppy: markPerformed failed'));
        }
        await this.#reply(conversation, grant, runId ?? randomUUID(), {
          text: result.text,
          components: [...components.values()],
          outcomes: [...work.outcomes, ...result.outcomes],
          permission: result.permission,
          failed: result.error !== null,
          operations: [...work.operations, ...held.values()],
          declines: work.declines,
          said: work.said,
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
        // What the dead process's turn took into account (§8.4).
        ...(conversation.asOfRequest ? { asOfRequest: conversation.asOfRequest } : {}),
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
      /** Operations to ask approval for, in this message and the next ones (Operations §4). */
      operations?: PoppyOperation[];
      /** Declined approvals, each said in a message (Operations §6). */
      declines?: { decline: PoppyDecline; summary: string }[];
      /** Statements added to the text. */
      said?: string[];
    },
  ): Promise<void> {
    const store = this.options.store;
    const current = await store.getConversation(conversation.id);
    await store.updateConversation(conversation.id, { activeRunId: null, asOfRequest: null });
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
    const said = (turn.said ?? []).filter((line) => line.trim() !== '');
    if (said.length > 0) text = [text, ...said].filter((part) => part !== '').join('\n\n');
    // Operations content goes only to a Personal Agent that declared Operations v3 (§8.4); one
    // operation or decline per message.
    const declared = this.#declared(current);
    const operationsContent =
      declared[POPPY_OPERATIONS_EXTENSION] === POPPY_OPERATIONS_VERSION
        ? [
            ...(turn.operations ?? []).map((operation) => ({
              content: { operation },
              text: this.#texts.operationRequired.replaceAll('{summary}', operation.summary ?? ''),
            })),
            ...(turn.declines ?? []).map(({ decline, summary }) => ({
              content: { declined: decline },
              text: [
                this.#texts.operationDeclined
                  .replaceAll('{summary}', summary)
                  .replaceAll('{reason}', decline.reason ?? ''),
                decline.reason ?? '',
              ]
                .filter((part) => part.trim() !== '')
                .join('\n'),
            })),
          ]
        : [];
    if (
      text === '' &&
      turn.failed &&
      components.length === 0 &&
      turn.outcomes.length === 0 &&
      operationsContent.length === 0
    ) {
      text = this.#texts.failed;
    }
    const [first, ...others] = operationsContent;
    if (text === '' && first !== undefined) text = first.text;
    const data: Record<string, unknown> = {
      ...(components.length > 0 ? { components } : {}),
      ...(turn.outcomes.length > 0 ? { actions: turn.outcomes } : {}),
    };
    let addons: PoppyMessageAddons | undefined;
    if (this.options.replyAddons && text !== '') {
      try {
        addons = await this.options.replyAddons({
          conversationId: current.id,
          conversation: current,
          actor: grant.actor,
          text,
          ...(Object.keys(data).length > 0 ? { data } : {}),
        });
      } catch (error) {
        this.options.onError?.(error, 'poppy: replyAddons hook failed');
      }
    }
    let composed: { text: string; extensions: Record<string, unknown> } = { text, extensions: {} };
    try {
      composed = this.#withAddons(declared, text, addons);
    } catch (error) {
      this.options.onError?.(error, 'poppy: replyAddons answered an invalid link or disclosure');
    }
    const extensions = {
      ...composed.extensions,
      ...(first !== undefined ? { [POPPY_OPERATIONS_EXTENSION]: first.content } : {}),
    };
    if (
      composed.text !== '' ||
      Object.keys(data).length > 0 ||
      Object.keys(extensions).length > 0
    ) {
      await this.#append(
        conversation.id,
        {
          type: 'message',
          message: this.#companyMessage(
            composed.text,
            Object.keys(data).length > 0 ? data : undefined,
            { type: 'agent' },
            derivedPoppyId('msg', `reply:${runId}`),
            turn.asOfRequest,
            extensions,
          ),
        },
        `reply:${runId}`,
      );
    }
    // Every other operation or decline in a message of its own (Operations §4, §6).
    for (const [index, item] of others.entries()) {
      const key = `reply:${runId}:operations:${index + 1}`;
      await this.#append(
        conversation.id,
        {
          type: 'message',
          message: this.#companyMessage(
            item.text,
            undefined,
            { type: 'agent' },
            derivedPoppyId('msg', key),
            turn.asOfRequest,
            { [POPPY_OPERATIONS_EXTENSION]: item.content },
          ),
        },
        key,
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
