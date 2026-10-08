import type { HttpContext } from '@adonisjs/core/http';
import {
  DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY,
  parseTextActionProposalCommand,
} from '../action-proposal-text.js';
import { AgentService, AttachmentRefusedError, type ChatSendOptions } from '../agent-service.js';
import type { AttachmentLimits } from '../attachment-limits.js';
import { onAgentEngine, registeredAgentEngine } from '../durable/agent-run-context.js';
import type { ElicitationQuestion } from '../elicitation.js';
import type { UiCapabilities } from '../genui/capabilities.js';
import type { ActionProposal } from '../spi/action-proposal-store.js';
import type { AttachmentRef } from '../spi/attachment-staging.js';
import type { StreamFrame } from '../spi/token-stream-sink.js';
import type { Actor, PageContext } from '../types.js';
import {
  type ChannelExecutor,
  type ChannelJob,
  type ChannelRetryOptions,
  type ChannelStepRunner,
  type ChannelWorkflowEngine,
  durableExecutor,
  inlineExecutor,
  jobId,
  registerChannelWorkflows,
  withRetries,
} from './executor.js';
import { ChannelMediaTooLargeError } from './http.js';
import { toChannelMarkdown } from './markdown.js';
import { formatChannelQuestion, parseChannelAnswer } from './questions.js';
import { splitMessage } from './split.js';
import { type ChannelStore, InMemoryChannelStore, lucidChannelStore } from './store.js';
import {
  type ChannelComponent,
  type ChannelMediaRefusal,
  type ChannelProposal,
  type ChannelTexts,
  type ChannelTextsOverrides,
  channelTextsFor,
  mergeTexts,
} from './texts.js';
import type {
  ChannelAdapter,
  ChannelMediaFile,
  ChannelRequest,
  InboundMedia,
  InboundMessage,
  OutboundMedia,
  OutboundMessage,
} from './types.js';

/**
 * What a channel turn needs from the agent — `AgentService` is one. The optional methods turn
 * features on: proposals (buttons, outcomes), questions (`answer`), media (`stageAttachment`), and
 * the Lucid default store (`lucidDatabase`).
 */
export interface ChannelTurnService
  extends Pick<AgentService, 'subscribe' | 'skip' | 'cancel' | 'actionProposalReply'>,
    Partial<
      Pick<
        AgentService,
        | 'decideActionProposal'
        | 'listActionProposals'
        | 'actionProposalVocabulary'
        | 'actionApprovalMode'
        | 'answer'
        | 'attachmentLimits'
        | 'stageAttachment'
        | 'lucidDatabase'
        | 'drive'
      >
    > {
  /**
   * Start (or queue) a turn. The channel passes `{ textDecisions: false }`: it decides text
   * decisions itself, only for the cards it delivered to the conversation.
   */
  send(...args: Parameters<AgentService['send']>): ReturnType<AgentService['send']>;
}

/**
 * Something the channel sends on the app's behalf (a hook's answer): text in the model's markdown
 * (converted and split for the channel), text sent exactly as given (`raw` — a message the person
 * forwards as is), or a file with a caption.
 */
export type ChannelReply =
  | string
  | { text: string; raw?: boolean }
  | {
      media: OutboundMedia;
      /** In the model's markdown, converted. */
      caption?: string;
      /** What a channel without files sends instead. Default: the caption. */
      fallbackText?: string;
    };

/** What {@link ChannelHandleOptions.beforeTurn} decides. */
export type ChannelGate =
  | 'continue'
  | 'stop'
  | undefined
  | { reply: ChannelReply }
  | { replies: ChannelReply[] };

/** What a hook is told about the message being handled. */
export interface ChannelHookContext {
  /** The adapter's name. */
  channel: string;
  conversation: string;
  message: InboundMessage;
}

/** One message about to go out — what {@link ChannelHandleOptions.canDeliver} checks. */
export interface ChannelDelivery {
  channel: string;
  conversation: string;
  /** What goes out, exactly as the adapter will get it. */
  outbound: OutboundMessage;
  /**
   * What it is: the turn's answer (`reply`), a proposal card, a relayed `outcome`, a `question`, a
   * hook's answer before the turn (`gate`), or the channel's own text (`notice`).
   */
  kind: 'reply' | 'card' | 'outcome' | 'question' | 'gate' | 'notice';
  /** Who the conversation was answered as, when known. */
  actor: Actor | null;
  /** The account reference the outbound belongs to: the actor's id, or a relayed proposal's `actorRef`. */
  actorRef: string | null;
  /** The message being answered, when there is one. */
  message: InboundMessage | null;
  /** The proposal whose outcome is relayed (`kind: 'outcome'`). */
  proposal: ActionProposal | null;
}

/** What a webhook request came to — {@link ChannelHandleOptions.onWebhook}. */
export interface ChannelWebhookEvent {
  channel: string;
  /**
   * `accepted` → at least one new message taken; `duplicate` → only messages already taken;
   * `ignored` → a verified body with no message to answer; `unauthorized` → `verify` refused it;
   * `challenge` → a subscription check answered; `method_not_allowed`; `failed` → the messages
   * could not be taken (store or engine down): answered `500`, the provider retries.
   */
  status:
    | 'accepted'
    | 'duplicate'
    | 'ignored'
    | 'unauthorized'
    | 'challenge'
    | 'method_not_allowed'
    | 'failed';
  /** Why it was ignored (the adapter's reason — never message content), or what failed. */
  reason?: string;
  /** The provider's event name, when the body has one. */
  event?: string;
  /** New messages taken. */
  accepted: number;
  /** Messages already taken before (provider retries). */
  duplicates: number;
  /** The new messages, for counting — handled on their own, do not answer them here. */
  messages: readonly InboundMessage[];
}

/** A turn has started — {@link ChannelHandleOptions.onTurnStarted}. */
export interface ChannelTurnStarted {
  runId: string;
  threadId: string;
  actor: Actor;
  message: InboundMessage;
  /** The message waits in the thread's queue (its run starts later under `runId`). */
  queued: boolean;
}

/** What {@link ChannelHandleOptions.prepareMedia} makes of a downloaded file. */
export type ChannelPreparedMedia =
  | undefined
  /** Attach this file instead (converted, resized…). */
  | { file: ChannelMediaFile }
  /** Read the file as this text (a voice note's transcript): added to the message, not attached. */
  | { text: string }
  /** Refuse it with `texts.mediaRefused(reason)`. */
  | { refuse: ChannelMediaRefusal };

/** The message as it goes to the agent — what {@link ChannelHandleOptions.transformInbound} edits. */
export interface ChannelInbound {
  /** The text (with prepared media's text appended). */
  text: string;
  attachments: AttachmentRef[];
}

export interface ChannelHandleOptions {
  /**
   * The account the sender is — from `message.from` (a phone number, a Telegram id). `null` → the
   * message is not answered by the agent ({@link unknownSender} / `texts.unknownSender`). This IS
   * the authentication of every message, so map only senders the channel itself vouches for.
   */
  actor(message: InboundMessage): Actor | null | Promise<Actor | null>;
  /**
   * A sender `actor()` mapped to nobody: what to answer (an onboarding step, a "link your number"
   * link) — `null`/`undefined` → nothing. Default: `texts.unknownSender`.
   */
  unknownSender?(
    message: InboundMessage,
    context: ChannelHookContext,
  ):
    | ChannelReply
    | ChannelReply[]
    | null
    | undefined
    | Promise<ChannelReply | ChannelReply[] | null | undefined>;
  /**
   * Before anything else for a known sender — before its answers, button presses, text decisions
   * and turns: `'continue'` (or nothing) goes on; `'stop'` ends here; `{ reply }` / `{ replies }`
   * answers and ends here. For flows the app owns: terms to accept, an account to finish, a quota.
   */
  beforeTurn?(
    message: InboundMessage,
    actor: Actor,
    context: ChannelHookContext,
  ): ChannelGate | Promise<ChannelGate>;
  /**
   * The thread this conversation continues; `null`/`undefined` → a new one, reported to
   * {@link onThreadCreated} so you can store it.
   */
  thread(
    actor: Actor,
    message: InboundMessage,
  ): string | null | undefined | Promise<string | null | undefined>;
  /** A new thread was created for the conversation — remember it for {@link thread}. */
  onThreadCreated?(threadId: string, actor: Actor, message: InboundMessage): void | Promise<void>;
  /** A turn started (or was queued) for a message — record where it came from, start a meter. */
  onTurnStarted?(turn: ChannelTurnStarted): void | Promise<void>;
  /**
   * Checked before EVERY message the channel sends — replies, cards, questions, relayed outcomes.
   * `false` → that message is dropped (e.g. the number was unlinked from the account mid-turn).
   */
  canDeliver?(delivery: ChannelDelivery): boolean | Promise<boolean>;
  /**
   * The turn's page context. Default `{ kind: adapter.name }`. The handler adds `channel: { name,
   * conversation }` to it — what a proposal's outcome is routed back by.
   */
  pageContext?: PageContext | ((message: InboundMessage) => PageContext);
  /** The agent that answers. Default: the thread's, else the configured default. */
  agentName?: string;
  /** The agent service. Default: `AgentService` from the container. */
  service?: ChannelTurnService;
  /**
   * Where the channel's short-lived state lives: message ids already taken, what was delivered,
   * questions waiting for an answer, cards sent, outcomes relayed. Default: `lucidChannelStore()`
   * over the agent store's database when the agent store is Lucid, else this process's memory.
   */
  store?: ChannelStore;
  /**
   * Process messages as `@adonis-agora/durable` runs: persisted before the `200`, one at a time per
   * conversation, retried, and resumed after a crash (a reply never lost, never sent twice). Default:
   * on when the agent runs durably (`durable: true` in `config/agent.ts`), on that engine. `false` →
   * in this process (a restart loses what is in flight). An engine → that one.
   */
  durable?: boolean | ChannelWorkflowEngine;
  /** How each phase of a message is retried when it fails. */
  retry?: ChannelRetryOptions;
  /** How long a message id (and what was delivered for it) is remembered. Default 24 h. */
  dedupeTtlMs?: number;
  /** Stop waiting for a turn after this long (and cancel it). Default 5 minutes. */
  timeoutMs?: number;
  /**
   * After a proposal is approved, wait this long for it to execute and relay its outcome. `0` → do
   * not wait (`channels.onSettled` relays it once it runs). Default 60 s.
   */
  outcomeTimeoutMs?: number;
  /** How long a question waits for its answer before the agent proceeds without it. Default 30 min. */
  questionTimeoutMs?: number;
  /**
   * What the channel says on its own. Omitted parts come from {@link channelTextsFor}: Brazilian
   * Portuguese when the agent's `actionProposalText` is `ptBrActionProposalText`, else English. A
   * function picks them per message (the actor's locale) — `actor` is `null` before it is known and
   * for a relayed outcome (then `proposal` is set).
   */
  texts?:
    | ChannelTextsOverrides
    | ((context: {
        actor: Actor | null;
        message: InboundMessage | null;
        proposal?: ActionProposal;
      }) => ChannelTextsOverrides | Promise<ChannelTextsOverrides>);
  /**
   * Accept "always in this conversation" in a text decision. Default `true`; `false` → it is refused
   * with `texts.rememberRefused` (every action needs its own confirmation here).
   */
  allowRemember?: boolean;
  /**
   * What the turn may draw. Default `{ components: [] }`: every component arrives as its
   * `fallbackText`. Allow some with {@link renderComponent} to send them as files.
   */
  uiCapabilities?: UiCapabilities;
  /**
   * A component the turn drew: what to send for it — a file (a chart as an image), text, several —
   * or `null`/`undefined` for its `fallbackText`. Rendered components are sent when the turn ends (or
   * asks a question), before its text; a later one with the same id replaces it; a failed turn sends
   * none.
   */
  renderComponent?(
    component: ChannelComponent,
    context: { actor: Actor; conversation: string; runId: string; rendered: number },
  ):
    | ChannelReply
    | ChannelReply[]
    | null
    | undefined
    | Promise<ChannelReply | ChannelReply[] | null | undefined>;
  /**
   * The attachment limits for one file — e.g. let audio through to {@link prepareMedia}, which
   * transcribes it. Default: the agent's.
   */
  mediaLimits?(limits: AttachmentLimits | null, media: InboundMedia): AttachmentLimits | null;
  /**
   * A downloaded file, before it is attached: attach another (`{ file }`), read it as text (`{ text }`
   * — a voice note's transcript), refuse it, or (nothing) attach it as is.
   */
  prepareMedia?(
    file: ChannelMediaFile,
    media: InboundMedia,
    context: ChannelHookContext & { actor: Actor },
  ): ChannelPreparedMedia | Promise<ChannelPreparedMedia>;
  /**
   * The message as it goes to the agent, last: add a note about the attachments, a default question
   * for an image without a caption… Text decisions are read from the result.
   */
  transformInbound?(
    inbound: ChannelInbound,
    context: ChannelHookContext & { actor: Actor; threadId: string | null },
  ): ChannelInbound | Promise<ChannelInbound>;
  /**
   * What an executed proposal tells the person, in order — the outcome, then follow-ups (a message
   * to forward, sent `raw` and alone). Relayed once. `null`/`undefined` → the default (`text`: the
   * proposal's own outcome text, else `texts.actionSucceeded` / `texts.actionFailed`); `[]` → nothing.
   */
  formatOutcome?(
    proposal: ActionProposal,
    context: { text: string; texts: ChannelTexts },
  ): ChannelReply[] | null | undefined | Promise<ChannelReply[] | null | undefined>;
  /** What every webhook request came to — for counters and logs, without parsing the body again. */
  onWebhook?(event: ChannelWebhookEvent): void | Promise<void>;
  /** A message whose handling failed (after its retries). Default: `console.error`. */
  onError?(error: unknown, message: InboundMessage): void;
}

/** The route handler `channels.handle()` returns. */
export interface ChannelRouteHandler {
  (ctx: HttpContext): Promise<void>;
  /**
   * Resolves once every message this handler took has been handled — for tests and shutdown. With
   * a durable engine: once their runs ended.
   */
  drain(): Promise<void>;
  /** Handle a request built by hand (another framework, a test). */
  handleRequest(
    request: ChannelRequest,
  ): Promise<{ status: number; body: unknown; contentType?: string }>;
}

const BUTTON_ID = /^agora:(approve|reject):([^\s]+)$/;
/** The tail of a proposal id a button carries — Telegram's `callback_data` holds 64 bytes. */
const BUTTON_REF_LENGTH = 32;
const OUTCOME_POLL_MS = 500;
/** How often a durable job reading a turn looks for a part of it still waiting for a worker. */
const DRIVE_POLL_MS = 500;
/** How long "this outcome was relayed" is remembered. */
const OUTCOME_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const buttonRef = (proposalId: string) => proposalId.slice(-BUTTON_REF_LENGTH);
/** How long the proposal cards sent to a conversation are remembered, and how many. */
const CARDS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CARDS = 20;
const foldLabel = (label: string) => label.trim().toLowerCase();

/** The button ids for a proposal: what {@link ChannelRouteHandler} maps back to its decision. */
export function proposalButtonIds(proposalId: string): { approve: string; reject: string } {
  const ref = buttonRef(proposalId);
  return { approve: `agora:approve:${ref}`, reject: `agora:reject:${ref}` };
}

/** Where a turn's output goes back to — `pageContext.channel`, recorded with every proposal. */
export interface ChannelAddress {
  name: string;
  conversation: string;
}

/** A question set waiting for the person's answer, one question at a time. */
interface PendingQuestions {
  threadId: string | null;
  /** The run parked on it. */
  runId: string;
  /** The run whose stream the person reads (the parked run's top-level ancestor). */
  streamRunId: string;
  toolCallId: string;
  preamble?: string;
  questions: ElicitationQuestion[];
  index: number;
  answers: Record<string, string[]>;
  /** The message the last answer came in — an answer applied once, however often its phase runs. */
  lastMessageId?: string;
}

function requestOf(ctx: HttpContext): ChannelRequest {
  return {
    method: ctx.request.method().toUpperCase(),
    url: ctx.request.url(true),
    header: (name) => ctx.request.header(name),
    params: (ctx.params ?? {}) as Record<string, unknown>,
    body: ctx.request.body(),
    rawBody: ctx.request.raw(),
  };
}

type ChannelLogger = Partial<
  Record<'debug' | 'warn', (bindings: Record<string, unknown>, message: string) => void>
>;

/** `AgentService` from the app's container, for code that runs outside a request. */
async function containerService(): Promise<ChannelTurnService> {
  const { default: app } = await import('@adonisjs/core/services/app');
  return (await app.container.make(AgentService)) as unknown as ChannelTurnService;
}

/** One registered channel: what `channels.onSettled` and the durable jobs reach it by. */
interface Registration {
  adapter: ChannelAdapter;
  /** Process one job (a message, a resume, a timeout). */
  run(job: ChannelJob, step: ChannelStepRunner): Promise<void>;
  /** Relay an executed proposal's outcome once; `false` when it was not relayed. */
  relay(
    proposal: ActionProposal,
    conversation: string,
    service?: ChannelTurnService,
  ): Promise<boolean>;
}

const registry = new Map<string, Registration>();

/** The job runner of the channel registered under `channel` in this process. */
const runnerFor = (channel: string) => registry.get(channel)?.run;

let following = false;
/** Register the channel workflows on the agent's durable engine, now or once it is wired. */
function followAgentEngine(): void {
  if (following) return;
  following = true;
  onAgentEngine((engine) =>
    registerChannelWorkflows(engine as unknown as ChannelWorkflowEngine, runnerFor),
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `image/jpeg` → `jpeg`, for a file that arrives without a name. */
const extensionOf = (contentType: string) =>
  (contentType.split('/')[1] ?? 'bin').split(/[;+]/)[0] ?? 'bin';

const replyList = <T>(value: T | T[] | null | undefined): T[] =>
  value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];

/** The component a frame carries (a live one, or a replayed `ui` event), else `null`. */
function componentOf(frame: StreamFrame, position: number): ChannelComponent | null {
  // A preview of a layout the model is still writing: a channel gets the final component (or its
  // fallback text) and nothing before it.
  if (
    (frame.t === 'component' && frame.partial === true) ||
    (frame.t === 'event' && frame.event.kind === 'ui' && frame.event.partial === true)
  ) {
    return null;
  }
  if (frame.t === 'component') {
    return {
      id: frame.id ?? `ui:${position}`,
      name: frame.name,
      data: frame.data,
      version: frame.version ?? 1,
      ...(frame.fallbackText !== undefined ? { fallbackText: frame.fallbackText } : {}),
    };
  }
  if (frame.t === 'event' && frame.event.kind === 'ui') {
    const { event } = frame;
    return {
      id: event.id,
      name: event.component,
      data: event.props,
      version: event.version ?? 1,
      ...(event.fallbackText !== undefined ? { fallbackText: event.fallbackText } : {}),
    };
  }
  return null;
}

/**
 * Keep executing, in this process, what of `runId` waits for a worker (`service.drive`), until
 * stopped. A durable channel job runs inside a worker's tick, and the tick ends only when the job
 * does: a turn the job started with a dispatcher that only persists it — or a delegate that turn
 * started — would wait for the next tick, and the job for the turn, until the read times out.
 */
function keepDriving(drive: (runId: string) => Promise<void>, runId: string): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pass = async () => {
    await drive(runId).catch(() => {});
    if (stopped) return;
    timer = setTimeout(() => void pass(), DRIVE_POLL_MS);
    timer.unref?.();
  };
  void pass();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * The webhook route for one channel. Each request is verified (`401` when it is not the provider's),
 * parsed, deduplicated by the provider's message id, taken (persisted, with a durable engine) and
 * acknowledged with `200`; the message is handled after the response — one at a time per
 * conversation, each phase retried — so a slow model never makes the provider retry. Then:
 *
 * - an unknown sender gets `unknownSender`; a known one goes through `beforeTurn`;
 * - an answer to a question the turn asked resumes it;
 * - a press on a proposal's button decides that proposal (`via` = the adapter's name);
 * - a text decision ("yes", "no #ID", a button label) decides a card delivered to THIS conversation
 *   — never a proposal made elsewhere (`texts.noPendingConfirmation`);
 * - media are downloaded (`prepareMedia`) and attached, or refused with a text;
 * - the message (`transformInbound`) starts a turn with the channel's capabilities;
 * - the reply is converted to the channel's markdown, split at its length limit, and sent — each
 *   message once, even when the work is retried or resumed after a crash;
 * - a proposal the turn left pending is sent with Confirm/Cancel buttons (or a text instruction);
 * - an approved proposal's outcome is relayed once it executed (see `outcomeTimeoutMs`, and
 *   `channels.onSettled` for one that runs later).
 *
 * Wants `actionApprovalMode: 'independent'`: a blocking approval holds the turn open until someone
 * decides it in the app, so the channel sends what it has and `texts.blockingApproval`.
 *
 * Registers the adapter under its `name` for `channels.onSettled` and the durable jobs — names must
 * be unique, and a process that resumes durable channel jobs must create the same handlers at boot.
 */
export function handleChannel(
  adapter: ChannelAdapter,
  options: ChannelHandleOptions,
): ChannelRouteHandler {
  const dedupeTtlMs = options.dedupeTtlMs ?? 24 * 60 * 60 * 1000;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const outcomeTimeoutMs = options.outcomeTimeoutMs ?? 60_000;
  const questionTimeoutMs = options.questionTimeoutMs ?? 30 * 60 * 1000;
  const { capabilities } = adapter;
  const buttons = (capabilities.buttons ?? 0) >= 2;
  const name = adapter.name;

  let resolvedService: Promise<ChannelTurnService> | undefined;
  const serviceFor = (given?: ChannelTurnService): Promise<ChannelTurnService> => {
    if (options.service) return Promise.resolve(options.service);
    if (given) return Promise.resolve(given);
    resolvedService ??= containerService().catch((error: unknown) => {
      resolvedService = undefined;
      throw error;
    });
    return resolvedService;
  };

  let resolvedStore: Promise<ChannelStore> | undefined;
  /** The configured store, else Lucid over the agent store's database, else memory — chosen once. */
  const storeFor = (service?: ChannelTurnService): Promise<ChannelStore> => {
    resolvedStore ??= (async () => {
      if (options.store) return options.store;
      const agent = options.service ?? service ?? (await containerService().catch(() => undefined));
      const db = agent?.lucidDatabase?.() ?? null;
      return db === null ? new InMemoryChannelStore() : lucidChannelStore(db);
    })();
    return resolvedStore;
  };

  /** The texts for one context, over the defaults in the language of the service's vocabulary. */
  const textsFor = async (
    service: ChannelTurnService,
    context: { actor: Actor | null; message: InboundMessage | null; proposal?: ActionProposal },
  ): Promise<ChannelTexts> => {
    const base = channelTextsFor(service.actionProposalVocabulary?.() ?? null);
    const overrides =
      typeof options.texts === 'function' ? await options.texts(context) : options.texts;
    return mergeTexts(overrides, base);
  };

  const questionKey = (conversation: string) => `${name}:question:${conversation}`;
  const cardsKey = (conversation: string) => `${name}:cards:${conversation}`;
  const answeredKey = (runId: string, toolCallId: string) =>
    `${name}:answered:${runId}:${toolCallId}`;
  /**
   * Settle a question once — by its answer, by its timeout, or skipped: `true` when `owner` settles
   * it (now, or in an earlier run of the same phase), `false` when something else did first.
   */
  const settleQuestion = async (
    store: ChannelStore,
    runId: string,
    toolCallId: string,
    owner: string,
  ): Promise<boolean> => {
    const key = answeredKey(runId, toolCallId);
    if (await store.claim(key, dedupeTtlMs)) {
      await store.set(key, owner, dedupeTtlMs);
      return true;
    }
    return (await store.get(key)) === owner;
  };

  /**
   * Sends to one conversation, each message at most once: every message takes a numbered slot
   * under `key` in the store before it goes out, so a phase that runs again (a retry, a crash
   * recovery) skips what already went. A failed send frees its slot, so the retry sends it.
   */
  const outbox = (
    store: ChannelStore,
    key: string,
    conversation: string,
    who: {
      actor: Actor | null;
      actorRef?: string | null;
      message: InboundMessage | null;
      proposal?: ActionProposal | null;
    },
  ) => {
    let next = 0;
    const send = async (outbound: OutboundMessage, kind: ChannelDelivery['kind']) => {
      const slot = `${key}:${next++}`;
      if (!(await store.claim(slot, dedupeTtlMs))) return;
      try {
        if (
          options.canDeliver &&
          !(await options.canDeliver({
            channel: name,
            conversation,
            outbound,
            kind,
            actor: who.actor,
            actorRef: who.actorRef ?? who.actor?.id ?? null,
            message: who.message,
            proposal: who.proposal ?? null,
          }))
        )
          return;
        await adapter.send(conversation, outbound);
      } catch (error) {
        await Promise.resolve(store.delete(slot)).catch(() => {});
        throw error;
      }
    };
    /** Text in the model's markdown: converted, split. */
    const text = async (value: string, kind: ChannelDelivery['kind']) => {
      for (const piece of splitMessage(
        toChannelMarkdown(value, capabilities.markdown),
        capabilities.maxLength,
      ))
        await send({ text: piece }, kind);
    };
    /** A hook's reply. */
    const reply = async (value: ChannelReply, kind: ChannelDelivery['kind']) => {
      if (typeof value === 'string') return text(value, kind);
      if ('media' in value) {
        const caption = value.caption ?? '';
        if (capabilities.media === true) {
          const max = capabilities.maxCaptionLength ?? capabilities.maxLength;
          return send(
            {
              text: toChannelMarkdown(caption, capabilities.markdown).slice(0, max),
              media: value.media,
            },
            kind,
          );
        }
        const fallback = value.fallbackText ?? caption;
        if (fallback.trim() !== '') return text(fallback, kind);
        return;
      }
      if (value.raw === true) {
        for (const piece of splitMessage(value.text, capabilities.maxLength))
          await send({ text: piece }, kind);
        return;
      }
      return text(value.text, kind);
    };
    return { send, text, reply };
  };
  type Outbox = ReturnType<typeof outbox>;

  const commandsFor = (
    service: ChannelTurnService,
    proposalId: string | null,
  ): { approve: string; reject: string } => {
    const vocabulary =
      service.actionProposalVocabulary?.() ?? DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY;
    const suffix = proposalId !== null ? ` #${proposalId}` : '';
    return {
      approve: `${vocabulary.approve[0] ?? 'yes'}${suffix}`,
      reject: `${vocabulary.reject[0] ?? 'no'}${suffix}`,
    };
  };

  /** Remember a proposal card sent to `conversation` — the only proposals it can decide. */
  const rememberCard = async (store: ChannelStore, conversation: string, proposalId: string) => {
    const key = cardsKey(conversation);
    const saved = await store.get(key);
    const ref = buttonRef(proposalId);
    const refs = saved === null ? [] : (JSON.parse(saved) as string[]);
    const next = [...refs.filter((known) => known !== ref), ref].slice(-MAX_CARDS);
    await store.set(key, JSON.stringify(next), CARDS_TTL_MS);
  };

  const cardsOf = async (store: ChannelStore, conversation: string): Promise<Set<string>> => {
    const saved = await store.get(cardsKey(conversation));
    return new Set(saved === null ? [] : (JSON.parse(saved) as string[]));
  };

  const sendProposal = async (
    service: ChannelTurnService,
    store: ChannelStore,
    texts: ChannelTexts,
    out: Outbox,
    conversation: string,
    proposal: ChannelProposal,
    withId: boolean,
  ) => {
    const summary = texts.proposal(proposal);
    const footer = typeof texts.footer === 'function' ? texts.footer(proposal) : texts.footer;
    const instruction = texts.instruction(commandsFor(service, withId ? proposal.id : null));
    const asText = toChannelMarkdown(
      [summary, instruction, footer]
        .filter((part) => part !== undefined && part !== '')
        .join('\n\n'),
      capabilities.markdown,
    );
    // Remembered before it goes: a "yes" can only decide a card this conversation was sent.
    await rememberCard(store, conversation, proposal.id);
    if (!buttons) {
      for (const piece of splitMessage(asText, capabilities.maxLength))
        await out.send({ text: piece }, 'card');
      return;
    }
    const ids = proposalButtonIds(proposal.id);
    await out.send(
      {
        text: toChannelMarkdown(summary, capabilities.markdown).slice(0, capabilities.maxLength),
        buttons: [
          { id: ids.approve, label: texts.approve },
          { id: ids.reject, label: texts.reject },
        ],
        fallbackText: asText.slice(0, capabilities.maxLength),
        instruction: toChannelMarkdown(instruction, capabilities.markdown),
        ...(footer !== undefined && footer !== ''
          ? { footer: toChannelMarkdown(footer, capabilities.markdown) }
          : {}),
      },
      'card',
    );
  };

  /** What an executed proposal tells the person, in order; `null` when it did not execute. */
  const outcomeReplies = async (
    proposal: ActionProposal,
    texts: ChannelTexts,
  ): Promise<ChannelReply[] | null> => {
    const status = proposal.execution?.status;
    if (status !== 'failed' && status !== 'succeeded') return null;
    // What its presentation said (`present` / `emitUi` text), else a plain confirmation.
    const text =
      status === 'failed'
        ? texts.actionFailed
        : proposal.outcome?.text?.trim() || texts.actionSucceeded;
    const formatted = await options.formatOutcome?.(proposal, { text, texts });
    return formatted ?? [text];
  };

  /** Send an executed proposal's outcome unless it was sent already (by this or another replica). */
  const relay = async (
    proposal: ActionProposal,
    conversation: string,
    given?: ChannelTurnService,
    who?: { actor: Actor | null; message: InboundMessage | null },
  ): Promise<boolean> => {
    const service = await serviceFor(given);
    const store = await storeFor(service);
    const status = proposal.execution?.status;
    if (status !== 'failed' && status !== 'succeeded') return false;
    if (!(await store.claim(`${name}:outcome:${proposal.id}`, OUTCOME_TTL_MS))) return false;
    const texts = await textsFor(service, {
      actor: who?.actor ?? null,
      message: who?.message ?? null,
      proposal,
    });
    const replies = (await outcomeReplies(proposal, texts)) ?? [];
    const out = outbox(store, `${name}:out:outcome:${proposal.id}`, conversation, {
      actor: who?.actor ?? null,
      actorRef: who?.actor?.id ?? proposal.actorRef ?? null,
      message: who?.message ?? null,
      proposal,
    });
    for (const reply of replies) await out.reply(reply, 'outcome');
    return true;
  };

  /** Wait for an approved proposal to run, then relay what it said (or that it failed). */
  const relayOutcome = async (
    service: ChannelTurnService,
    actor: Actor,
    threadId: string,
    proposalId: string,
    message: InboundMessage,
  ) => {
    if (outcomeTimeoutMs <= 0 || !service.listActionProposals) return;
    const deadline = Date.now() + outcomeTimeoutMs;
    while (Date.now() < deadline) {
      const current = (await service.listActionProposals(actor, threadId)).find(
        (proposal) => proposal.id === proposalId,
      );
      if (current?.decision !== 'approved') return;
      const status = current.execution?.status;
      if (status === 'succeeded' || status === 'failed') {
        await relay(current, message.conversation, service, { actor, message });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, OUTCOME_POLL_MS));
    }
  };

  /**
   * A button press the provider forwarded without its id — only the label (Whatsmiau): the id of
   * the one card it can have come from — a card sent to this conversation whose proposal is still
   * pending. Several such cards → `undefined`: never guess; the label then goes on as a text
   * decision, which asks for the `#id`.
   */
  const recoverButtonId = async (
    service: ChannelTurnService,
    store: ChannelStore,
    texts: ChannelTexts,
    actor: Actor,
    threadId: string | null,
    message: InboundMessage,
  ): Promise<string | undefined> => {
    if (message.buttonId !== undefined || message.buttonWithoutId !== true) return undefined;
    if (threadId === null || !service.listActionProposals) return undefined;
    const label = foldLabel(message.text);
    const action =
      label === foldLabel(texts.approve)
        ? 'approve'
        : label === foldLabel(texts.reject)
          ? 'reject'
          : undefined;
    if (action === undefined) return undefined;
    const refs = await cardsOf(store, message.conversation);
    if (refs.size === 0) return undefined;
    const live = (await service.listActionProposals(actor, threadId)).filter(
      (proposal) => proposal.decision === 'pending' && refs.has(buttonRef(proposal.id)),
    );
    const only = live.length === 1 ? live[0] : undefined;
    return only === undefined ? undefined : `agora:${action}:${buttonRef(only.id)}`;
  };

  /** Decide one proposal by a press or a text, answer, and relay its outcome when it ran. */
  const decide = async (
    service: ChannelTurnService,
    out: Outbox,
    actor: Actor,
    threadId: string,
    proposalId: string,
    decision: 'approved' | 'rejected',
    remember: boolean,
    message: InboundMessage,
  ) => {
    if (!service.decideActionProposal) return;
    const result = await service.decideActionProposal(
      actor,
      threadId,
      proposalId,
      decision,
      remember ? { remember: true } : {},
      name,
    );
    await out.text(service.actionProposalReply(result, decision), 'notice');
    if (result.status === 'applied' && decision === 'approved')
      await relayOutcome(service, actor, threadId, proposalId, message);
  };

  /** A press on one of our proposal buttons: decide it. `false` → not one of ours. */
  const pressButton = async (
    service: ChannelTurnService,
    out: Outbox,
    actor: Actor,
    threadId: string | null,
    message: InboundMessage,
  ): Promise<boolean> => {
    const match = message.buttonId === undefined ? null : BUTTON_ID.exec(message.buttonId);
    if (!match || !service.decideActionProposal || !service.listActionProposals) return false;
    const decision = match[1] === 'approve' ? 'approved' : 'rejected';
    const ref = match[2] ?? '';
    const proposal =
      threadId === null
        ? undefined
        : (await service.listActionProposals(actor, threadId)).find(
            (candidate) => buttonRef(candidate.id) === ref,
          );
    if (threadId === null || !proposal) {
      await out.text(service.actionProposalReply({ status: 'not_found' }, decision), 'notice');
      return true;
    }
    await decide(service, out, actor, threadId, proposal.id, decision, false, message);
    return true;
  };

  /**
   * A text decision ("yes", "no #ID", a button label the provider forwarded alone), scoped to the
   * cards this conversation was sent. `false` → not a decision: an ordinary message.
   */
  const decideByText = async (
    service: ChannelTurnService,
    store: ChannelStore,
    texts: ChannelTexts,
    out: Outbox,
    actor: Actor,
    threadId: string | null,
    message: InboundMessage,
    text: string,
  ): Promise<boolean> => {
    if (threadId === null || !service.listActionProposals || !service.decideActionProposal)
      return false;
    const vocabulary =
      service.actionProposalVocabulary?.() ?? DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY;
    const command = parseTextActionProposalCommand(text, vocabulary);
    if (command.status !== 'command') return false;
    const proposals = await service.listActionProposals(actor, threadId);
    const cards = await cardsOf(store, message.conversation);
    const deliverable = proposals.filter(
      (proposal) => proposal.decision === 'pending' && cards.has(buttonRef(proposal.id)),
    );
    const named = command.proposalId;
    if (named !== undefined) {
      const target = deliverable.find((proposal) => proposal.id === named);
      // An `#ID` naming no proposal of the thread is an ordinary message.
      if (target === undefined && !proposals.some((proposal) => proposal.id === named))
        return false;
      if (target === undefined) {
        await out.text(texts.noPendingConfirmation, 'notice');
        return true;
      }
      if (command.remember && options.allowRemember === false) {
        await out.text(texts.rememberRefused, 'notice');
        return true;
      }
      await decide(
        service,
        out,
        actor,
        threadId,
        target.id,
        command.decision,
        command.remember,
        message,
      );
      return true;
    }
    if (deliverable.length === 0) {
      // Nothing pending anywhere: "yes" is just a word in the conversation.
      if (!proposals.some((proposal) => proposal.decision === 'pending')) return false;
      await out.text(texts.noPendingConfirmation, 'notice');
      return true;
    }
    if (deliverable.length > 1) {
      await out.text(
        texts.ambiguousDecision(
          deliverable.map((proposal) => proposal.id),
          commandsFor(service, null),
        ),
        'notice',
      );
      return true;
    }
    if (command.remember && options.allowRemember === false) {
      await out.text(texts.rememberRefused, 'notice');
      return true;
    }
    const [only] = deliverable;
    if (only === undefined) return false;
    await decide(
      service,
      out,
      actor,
      threadId,
      only.id,
      command.decision,
      command.remember,
      message,
    );
    return true;
  };

  const askNext = (texts: ChannelTexts, out: Outbox, pending: PendingQuestions) => {
    const question = pending.questions[pending.index];
    if (!question) return Promise.resolve();
    return out.text(
      formatChannelQuestion(
        question,
        {
          index: pending.index,
          total: pending.questions.length,
          ...(pending.preamble !== undefined ? { preamble: pending.preamble } : {}),
        },
        texts.questions,
      ),
      'question',
    );
  };

  /**
   * The person's message answers the question in front of them; the last one resumes the run.
   * Returns the run to read on, once all are answered.
   */
  const answerQuestion = async (
    service: ChannelTurnService,
    store: ChannelStore,
    texts: ChannelTexts,
    out: Outbox,
    actor: Actor,
    message: InboundMessage,
    pending: PendingQuestions,
  ): Promise<string | null | 'expired'> => {
    if (!service.answer) return null;
    const key = questionKey(message.conversation);
    // This message's answer was applied already (its phase is running again): carry on from there.
    const applied = pending.lastMessageId === message.id;
    let next = pending;
    if (!applied) {
      const question = pending.questions[pending.index];
      if (!question) return null;
      const parsed = parseChannelAnswer(question, message.text, texts.questions.skipWord);
      if (parsed.status === 'invalid') {
        await out.text(texts.questions.invalid(parsed.problem), 'question');
        await askNext(texts, out, pending);
        return null;
      }
      next = {
        ...pending,
        index: pending.index + 1,
        answers:
          parsed.status === 'answer'
            ? { ...pending.answers, [question.id]: parsed.values }
            : pending.answers,
        lastMessageId: message.id,
      };
      await store.set(key, JSON.stringify(next), questionTimeoutMs);
    }
    if (next.index < next.questions.length) {
      await askNext(texts, out, next);
      return null;
    }
    if (!(await settleQuestion(store, next.runId, next.toolCallId, `answer:${message.id}`))) {
      // It timed out while this answer was on its way: the run went on without it, and this is a
      // message like any other.
      await store.delete(key);
      return 'expired';
    }
    // The run that asked goes on: what it says next is read from its stream.
    try {
      await service.answer({
        runId: next.runId,
        toolCallId: next.toolCallId,
        answers: next.answers,
        answeredByRef: actor.id,
        answeredVia: name,
      });
    } catch (error) {
      // Taken by a run of this phase that died after answering: the run has it.
      if (!applied) throw error;
    }
    await store.delete(key);
    return next.streamRunId;
  };

  /** Download a message's files and stage them for the turn; refuse what cannot be attached. */
  const attachMedia = async (
    service: ChannelTurnService,
    texts: ChannelTexts,
    out: Outbox,
    actor: Actor,
    message: InboundMessage,
  ): Promise<{ refs: AttachmentRef[]; extra: string[] }> => {
    const refs: AttachmentRef[] = [];
    const extra: string[] = [];
    const base = service.attachmentLimits?.() ?? null;
    for (const media of message.media ?? []) {
      const limits = options.mediaLimits ? options.mediaLimits(base, media) : base;
      const refuse = (reason: ChannelMediaRefusal) =>
        out.text(texts.mediaRefused(reason, media, limits), 'notice');
      if (
        limits === null ||
        !adapter.download ||
        (!service.stageAttachment && !options.prepareMedia)
      ) {
        await refuse('disabled');
        continue;
      }
      const declared = media.contentType?.split(';')[0]?.trim().toLowerCase();
      if (declared !== undefined && !limits.allowedContentTypes.includes(declared)) {
        await refuse('type');
        continue;
      }
      if (media.sizeBytes !== undefined && media.sizeBytes > limits.maxBytes) {
        await refuse('size');
        continue;
      }
      try {
        let file = await adapter.download(media, { maxBytes: limits.maxBytes });
        const prepared = await options.prepareMedia?.(file, media, {
          channel: name,
          conversation: message.conversation,
          message,
          actor,
        });
        if (prepared && 'refuse' in prepared) {
          await refuse(prepared.refuse);
          continue;
        }
        if (prepared && 'text' in prepared) {
          if (prepared.text.trim() !== '') extra.push(prepared.text);
          continue;
        }
        if (prepared && 'file' in prepared) file = prepared.file;
        if (!service.stageAttachment) {
          await refuse('disabled');
          continue;
        }
        const attachment = await service.stageAttachment(actor, {
          data: file.data,
          contentType: file.contentType,
          filename: file.filename ?? `${media.kind}.${extensionOf(file.contentType)}`,
        });
        refs.push({ mediaId: attachment.mediaId });
      } catch (error) {
        if (error instanceof ChannelMediaTooLargeError) await refuse('size');
        else if (error instanceof AttachmentRefusedError)
          await refuse(error.status === 413 ? 'size' : error.status === 415 ? 'type' : 'failed');
        else {
          await refuse('failed');
          options.onError?.(error, message);
        }
      }
    }
    return { refs, extra };
  };

  /**
   * Read a run's frames until it ends (or parks on a question, or on something a text channel
   * cannot settle) and deliver them. Reads the stream from its start: what was delivered before (a
   * read before a question, a read a crash cut short) is skipped by its slot.
   */
  const readTurn = async (
    service: ChannelTurnService,
    store: ChannelStore,
    actor: Actor,
    runId: string,
    threadId: string | null,
    conversation: string,
    message: InboundMessage | null,
  ) => {
    const texts = await textsFor(service, { actor, message });
    const out = outbox(store, `${name}:out:${runId}`, conversation, { actor, message });
    const parts: string[] = [];
    const proposals = new Map<string, ChannelProposal>();
    /** Components rendered as files, by id (a later one replaces), sent before the text. */
    const rendered = new Map<string, { component: ChannelComponent; replies: ChannelReply[] }>();
    const asText = new Set<string>();
    let wroteText = false;
    let failed = false;
    let blocked = false;
    let parked = false;
    let position = 0;
    const deadlineAt = Date.now() + timeoutMs;
    const flush = async (end: boolean) => {
      const batch = [...rendered.values()];
      rendered.clear();
      for (const { replies } of batch) for (const reply of replies) await out.reply(reply, 'reply');
      const text = parts.join('').trim();
      parts.length = 0;
      if (text !== '') await out.text(text, 'reply');
      if (end && !wroteText && batch.length > 0) {
        const after = texts.componentsOnly?.(batch.map(({ component }) => component));
        if (after !== undefined && after !== '') await out.text(after, 'reply');
      }
    };
    const stream = service.subscribe(runId)[Symbol.asyncIterator]();
    const drive = service.drive?.bind(service);
    const stopDriving =
      executor().durable && drive !== undefined ? keepDriving(drive, runId) : undefined;
    try {
      for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), Math.max(0, deadlineAt - Date.now()));
        });
        const next = await Promise.race([stream.next(), timeout]).finally(() =>
          clearTimeout(timer),
        );
        if (next === 'timeout') {
          failed = parts.length === 0 && rendered.size === 0 && !wroteText;
          await service.cancel(runId).catch(() => {});
          break;
        }
        if (next.done) break;
        const frame: StreamFrame = next.value;
        const component = componentOf(frame, position++);
        if (component !== null) {
          const replies = options.renderComponent
            ? replyList(
                await options.renderComponent(component, {
                  actor,
                  conversation,
                  runId,
                  rendered: rendered.size,
                }),
              )
            : [];
          if (replies.length > 0) {
            rendered.set(component.id, { component, replies });
            continue;
          }
          rendered.delete(component.id);
          if (component.fallbackText && !asText.has(component.id)) {
            // Only a component the turn negotiated as drawable comes as a frame; its text is all a
            // channel that does not render it can show.
            asText.add(component.id);
            wroteText = true;
            parts.push(`\n\n${component.fallbackText}\n\n`);
          }
        } else if (frame.t === 'text') {
          wroteText ||= frame.v.trim() !== '';
          parts.push(frame.v);
        } else if (frame.t === 'event' && frame.event.kind === 'text') {
          wroteText ||= frame.event.text.trim() !== '';
          parts.push(frame.event.text);
        } else if (frame.t === 'approval') {
          if (frame.target?.kind === 'proposal') {
            proposals.set(frame.target.proposalId, {
              id: frame.target.proposalId,
              toolName: frame.toolName,
              ...(frame.confirmation ? { confirmation: frame.confirmation } : {}),
            });
          } else {
            // Blocking mode: the run waits for a decision this channel cannot make.
            blocked = true;
            break;
          }
        } else if (frame.t === 'elicitation') {
          const questions = frame.request.questions;
          const asked: PendingQuestions = {
            threadId,
            runId: frame.runId,
            streamRunId: runId,
            toolCallId: frame.id,
            ...(frame.request.preamble !== undefined ? { preamble: frame.request.preamble } : {}),
            questions,
            index: 0,
            answers: {},
          };
          if ((await store.get(answeredKey(frame.runId, frame.id))) !== null) {
            // Answered (or skipped) before, and the run went on past it. What was sent around it
            // then is sent (skipped, by its slots) the same way now, so what follows keeps its slots.
            if (service.answer && questions.length > 0) {
              await flush(false);
              await askNext(texts, out, asked);
            }
            continue;
          }
          if (!service.answer || questions.length === 0) {
            await settleQuestion(store, frame.runId, frame.id, 'skipped');
            await service
              .skip({
                runId: frame.runId,
                toolCallId: frame.id,
                answeredByRef: actor.id,
                answeredVia: name,
              })
              .catch(() => {});
            continue;
          }
          await flush(false);
          const pending = asked;
          const key = questionKey(conversation);
          const waiting = await store.get(key);
          const same =
            waiting !== null && (JSON.parse(waiting) as PendingQuestions).toolCallId === frame.id;
          if (!same) await store.set(key, JSON.stringify(pending), questionTimeoutMs);
          await askNext(texts, out, pending);
          // The answers come as the next messages; nobody answering in time skips it.
          await executor().later(
            {
              kind: 'timeout',
              channel: name,
              conversation,
              runId: frame.runId,
              toolCallId: frame.id,
              streamRunId: runId,
              threadId,
              actor,
            },
            jobId(name, 'timeout', frame.runId, frame.id),
            Date.now() + questionTimeoutMs,
          );
          parked = true;
          break;
        } else if (frame.t === 'error') {
          failed = true;
          // A failed turn shows none of what it drew before failing.
          rendered.clear();
        }
      }
    } finally {
      stopDriving?.();
      void stream.return?.();
    }
    if (parked) return;
    await flush(true);
    if (failed) await out.text(texts.failed, 'notice');
    if (blocked) await out.text(texts.blockingApproval, 'notice');
    const left = [...proposals.values()];
    for (const proposal of left)
      await sendProposal(service, store, texts, out, conversation, proposal, left.length > 1);
  };

  const hookContext = (message: InboundMessage): ChannelHookContext => ({
    channel: name,
    conversation: message.conversation,
    message,
  });

  /** Before the turn: who is talking, and whether the app lets them through. */
  const prepare = async (
    message: InboundMessage,
  ): Promise<{ stop: true } | { stop: false; actor: Actor; threadId: string | null }> => {
    const service = await serviceFor();
    const store = await storeFor(service);
    await adapter.acknowledge?.(message).catch(() => {});
    const actor = await options.actor(message);
    if (actor === null) {
      const out = outbox(store, `${name}:out:msg:${message.id}:sender`, message.conversation, {
        actor: null,
        message,
      });
      const replies = options.unknownSender
        ? replyList(await options.unknownSender(message, hookContext(message)))
        : replyList((await textsFor(service, { actor: null, message })).unknownSender);
      for (const reply of replies) await out.reply(reply, 'gate');
      return { stop: true };
    }
    const gate = await options.beforeTurn?.(message, actor, hookContext(message));
    if (gate === 'stop') return { stop: true };
    if (gate !== undefined && gate !== 'continue') {
      const out = outbox(store, `${name}:out:msg:${message.id}:gate`, message.conversation, {
        actor,
        message,
      });
      for (const reply of 'replies' in gate ? gate.replies : [gate.reply])
        await out.reply(reply, 'gate');
      return { stop: true };
    }
    const threadId = (await options.thread(actor, message)) ?? null;
    return { stop: false, actor, threadId };
  };

  /**
   * The message itself: an answer, a press, a decision, or a turn. Returns the run to read, if any.
   * A turn is started once per message, however often this runs: its run id is kept under the
   * message id before anything else can fail.
   */
  const act = async (
    received: InboundMessage,
    actor: Actor,
    threadId: string | null,
  ): Promise<{ runId: string; threadId: string | null } | null> => {
    const service = await serviceFor();
    const store = await storeFor(service);
    const turnKey = `${name}:turn:${received.id}`;
    const started = await store.get(turnKey);
    if (started !== null && started !== '') {
      // This phase ran to its end before (a retry, a recovery): the same outcome.
      return JSON.parse(started) as { runId: string; threadId: string | null } | null;
    }
    /** What this message came to, kept so a phase that runs again does not do it twice. */
    const done = async (result: { runId: string; threadId: string | null } | null) => {
      await store.set(turnKey, JSON.stringify(result), dedupeTtlMs);
      return result;
    };
    const texts = await textsFor(service, { actor, message: received });
    const out = outbox(store, `${name}:out:msg:${received.id}`, received.conversation, {
      actor,
      message: received,
    });
    const recovered = await recoverButtonId(service, store, texts, actor, threadId, received);
    const message = recovered === undefined ? received : { ...received, buttonId: recovered };
    const ours = message.buttonId !== undefined && BUTTON_ID.test(message.buttonId);
    if (!ours) {
      const waiting = await store.get(questionKey(message.conversation));
      const pending = waiting === null ? null : (JSON.parse(waiting) as PendingQuestions);
      if (pending !== null && (pending.threadId === null || pending.threadId === threadId)) {
        const resume = await answerQuestion(service, store, texts, out, actor, message, pending);
        if (resume !== 'expired')
          return done(resume === null ? null : { runId: resume, threadId: pending.threadId });
      }
    }
    if (await pressButton(service, out, actor, threadId, message)) return done(null);
    const media = await attachMedia(service, texts, out, actor, message);
    let inbound: ChannelInbound = {
      text: [message.text, ...media.extra].filter((part) => part.trim() !== '').join('\n\n'),
      attachments: media.refs,
    };
    if (options.transformInbound)
      inbound = await options.transformInbound(inbound, {
        ...hookContext(message),
        actor,
        threadId,
      });
    if (
      inbound.attachments.length === 0 &&
      (await decideByText(service, store, texts, out, actor, threadId, message, inbound.text))
    )
      return done(null);
    // A file nobody could attach, and no caption: there is nothing left to answer.
    if (inbound.text === '' && inbound.attachments.length === 0) return done(null);
    if (!(await store.claim(turnKey, dedupeTtlMs))) {
      // Taken by a run of this phase that died between starting the turn and recording it: never
      // start a second turn for one message.
      throw Object.assign(
        new Error(
          `[@adonis-agora/agent] channel ${name}: message ${message.id} may have started a turn already; not starting another`,
        ),
        { name: 'ChannelTurnUncertainError', status: 409 },
      );
    }
    const pageContext =
      typeof options.pageContext === 'function'
        ? options.pageContext(message)
        : (options.pageContext ?? { kind: name });
    const channel: ChannelAddress = { name, conversation: message.conversation };
    const sendOptions: ChatSendOptions = { textDecisions: false };
    let sent: Awaited<ReturnType<ChannelTurnService['send']>>;
    try {
      sent = await service.send(
        {
          actor,
          message: inbound.text,
          ...(threadId !== null ? { threadId } : {}),
          ...(options.agentName !== undefined ? { agentName: options.agentName } : {}),
          ...(inbound.attachments.length > 0 ? { attachments: inbound.attachments } : {}),
          uiCapabilities: options.uiCapabilities ?? { components: [] },
          pageContext: { ...pageContext, channel },
          hostContext: {
            channel: name,
            conversation: message.conversation,
            messageId: message.id,
          },
        },
        sendOptions,
      );
    } catch (error) {
      // Nothing started: a retry may start it.
      await Promise.resolve(store.delete(turnKey)).catch(() => {});
      throw error;
    }
    if ('proposalDecision' in sent) {
      // A service that decides by text itself (one that ignores `textDecisions`).
      await done(null);
      await out.text(sent.text, 'notice');
      const decided = sent.proposalDecision;
      if (
        'proposal' in decided &&
        decided.status === 'applied' &&
        decided.proposal?.decision === 'approved'
      )
        await relayOutcome(service, actor, sent.threadId, decided.proposal.id, message);
      return null;
    }
    // A queued message starts later under its own id: its answer is read the same way.
    const runId = sent.queued === true ? (sent.runId ?? sent.messageId) : sent.runId;
    const turn = await done({ runId, threadId: sent.threadId });
    if (threadId === null) await options.onThreadCreated?.(sent.threadId, actor, message);
    await options.onTurnStarted?.({
      runId,
      threadId: sent.threadId,
      actor,
      message,
      queued: sent.queued === true,
    });
    return turn;
  };

  const retry = <T>(fn: () => Promise<T>) => withRetries(fn, options.retry);

  const report = (error: unknown, message: InboundMessage | null) => {
    if (options.onError && message !== null) options.onError(error, message);
    else
      console.error('[@adonis-agora/agent] Channel message failed', {
        channel: name,
        message: error instanceof Error ? error.message : String(error),
      });
  };

  /** One job, phase by phase — each phase a checkpoint under a durable engine. */
  const run = async (job: ChannelJob, step: ChannelStepRunner): Promise<void> => {
    const message = job.kind === 'message' ? job.message : null;
    try {
      if (job.kind === 'timeout') {
        await step('timeout', () =>
          retry(async () => {
            const service = await serviceFor();
            const store = await storeFor(service);
            // Answered in time: nothing to do.
            if (!(await settleQuestion(store, job.runId, job.toolCallId, 'timeout'))) return false;
            // Nobody answered: the agent goes on on its own assumptions.
            const key = questionKey(job.conversation);
            const waiting = await store.get(key);
            const pending = waiting === null ? null : (JSON.parse(waiting) as PendingQuestions);
            if (pending?.runId === job.runId && pending.toolCallId === job.toolCallId)
              await store.delete(key);
            await service
              .skip({
                runId: job.runId,
                toolCallId: job.toolCallId,
                answeredByRef: job.actor.id,
                answeredVia: name,
              })
              .catch(() => {});
            await executor().enqueue(
              {
                kind: 'resume',
                channel: name,
                conversation: job.conversation,
                runId: job.streamRunId,
                threadId: job.threadId,
                actor: job.actor,
              },
              jobId(name, 'resume', job.runId, job.toolCallId),
            );
            return true;
          }),
        );
        return;
      }
      if (job.kind === 'resume') {
        await step('read', () =>
          retry(async () => {
            const service = await serviceFor();
            await readTurn(
              service,
              await storeFor(service),
              job.actor,
              job.runId,
              job.threadId,
              job.conversation,
              null,
            );
            return null;
          }),
        );
        return;
      }
      const received = job.message;
      const prepared = await step('prepare', () => retry(() => prepare(received)));
      if (prepared.stop) return;
      const turn = await step('act', () =>
        retry(() => act(received, prepared.actor, prepared.threadId)),
      );
      if (turn === null) return;
      await step('read', () =>
        retry(async () => {
          const service = await serviceFor();
          await readTurn(
            service,
            await storeFor(service),
            prepared.actor,
            turn.runId,
            turn.threadId,
            received.conversation,
            received,
          );
          return null;
        }),
      );
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name === 'WorkflowSuspended') throw error;
      report(error, message);
    }
  };

  let current: ChannelExecutor | undefined;
  /** Durable when an engine is there (given, or the agent's), else in this process. */
  const executor = (): ChannelExecutor => {
    if (current) return current;
    const engine =
      options.durable === false
        ? undefined
        : typeof options.durable === 'object'
          ? options.durable
          : (registeredAgentEngine() as ChannelWorkflowEngine | undefined);
    if (engine === undefined && options.durable === true)
      console.warn(
        `[@adonis-agora/agent] channel ${name}: \`durable: true\` but no durable engine is wired (\`durable: true\` in config/agent.ts) — messages are handled in this process`,
      );
    if (engine !== undefined) {
      registerChannelWorkflows(engine, runnerFor);
      current = durableExecutor(engine);
      return current;
    }
    current = inlineExecutor((job) => run(job, (_name, fn) => fn()));
    return current;
  };

  registry.set(name, {
    adapter,
    run,
    relay: (proposal, conversation, service) => relay(proposal, conversation, service),
  });
  // Registered on the engine as soon as there is one: a restarted process resumes the jobs a crash
  // interrupted only for workflows it knows.
  if (typeof options.durable === 'object') registerChannelWorkflows(options.durable, runnerFor);
  else if (options.durable !== false) followAgentEngine();

  const notify = async (event: Omit<ChannelWebhookEvent, 'channel'>) => {
    try {
      await options.onWebhook?.({ channel: name, ...event });
    } catch {
      // Observation never changes the answer.
    }
  };

  const handleRequest = async (
    request: ChannelRequest,
    logger?: ChannelLogger,
  ): Promise<{ status: number; body: unknown; contentType?: string }> => {
    const empty = { accepted: 0, duplicates: 0, messages: [] };
    const challenge = adapter.challenge?.(request) ?? null;
    if (challenge !== null) {
      await notify({ status: 'challenge', ...empty });
      return {
        status: challenge.status,
        body: challenge.body,
        contentType: challenge.contentType ?? 'text/plain',
      };
    }
    if (request.method !== 'POST') {
      await notify({ status: 'method_not_allowed', ...empty });
      return { status: 405, body: { error: 'method_not_allowed' } };
    }
    if (!(await adapter.verify(request))) {
      await notify({ status: 'unauthorized', ...empty });
      return { status: 401, body: { error: 'unauthorized' } };
    }
    const parsed = adapter.parse(request.body);
    const messages = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
    if (messages.length === 0) {
      const ignored = adapter.ignored?.(request.body) ?? null;
      const event =
        ignored?.event ??
        (typeof request.body === 'object' && request.body !== null
          ? (request.body as { event?: unknown }).event
          : undefined);
      const reason = ignored?.reason ?? 'no message';
      // Logged with the event and the reason — never the content — so a dropped message can be
      // diagnosed.
      if (logger) {
        const log = ignored?.unexpected ? logger.warn : logger.debug;
        log?.call(
          logger,
          { channel: name, ...(typeof event === 'string' ? { event } : {}), reason },
          'channels: webhook ignored',
        );
      }
      await notify({
        status: 'ignored',
        reason,
        ...(typeof event === 'string' ? { event } : {}),
        ...empty,
      });
      return { status: 200, body: { ok: true } };
    }
    const fresh: InboundMessage[] = [];
    try {
      const store = await storeFor(await serviceFor());
      // Taken before the 200: a store or an engine that is down answers 500, and the provider
      // retries.
      for (const message of messages) {
        const key = `${name}:${message.id}`;
        if (!(await store.claim(key, dedupeTtlMs))) continue;
        try {
          await executor().enqueue(
            { kind: 'message', channel: name, conversation: message.conversation, message },
            jobId(name, 'message', message.id),
          );
        } catch (error) {
          await Promise.resolve(store.delete(key)).catch(() => {});
          throw error;
        }
        fresh.push(message);
      }
    } catch (error) {
      await notify({
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        accepted: fresh.length,
        duplicates: 0,
        messages: fresh,
      });
      return { status: 500, body: { error: 'unavailable' } };
    }
    await notify({
      status: fresh.length > 0 ? 'accepted' : 'duplicate',
      accepted: fresh.length,
      duplicates: messages.length - fresh.length,
      messages: fresh,
    });
    return { status: 200, body: { ok: true } };
  };

  const handler = async (ctx: HttpContext) => {
    const answer = await handleRequest(requestOf(ctx), (ctx as { logger?: ChannelLogger }).logger);
    if (answer.contentType !== undefined)
      ctx.response
        .status(answer.status)
        .header('content-type', answer.contentType)
        .send(answer.body);
    else ctx.response.status(answer.status).send(answer.body);
  };

  return Object.assign(handler, {
    drain: () => executor().drain(),
    handleRequest: (request: ChannelRequest) => handleRequest(request),
  });
}

/**
 * Relay an executed proposal's outcome to the conversation it was proposed in — once: the handler's
 * own wait and this share a claim in the channel's store. `false` when it was not relayed (no
 * channel recorded, the channel is not registered in this process, not executed, already relayed).
 */
async function deliverOutcome(
  proposal: ActionProposal,
  service?: ChannelTurnService,
): Promise<boolean> {
  const address = record(proposal.executionContext?.pageContext?.channel);
  const channelName = typeof address?.name === 'string' ? address.name : undefined;
  const conversation = typeof address?.conversation === 'string' ? address.conversation : undefined;
  const registration = channelName === undefined ? undefined : registry.get(channelName);
  if (!registration || conversation === undefined) return false;
  return registration.relay(proposal, conversation, service);
}

/**
 * `actionProposalWorker.onSettled` for text channels: relays an executed proposal's outcome to the
 * conversation it was proposed in, through the adapter registered under the recorded channel name
 * (with its `formatOutcome`, `texts` and `canDeliver`). Proposals from other surfaces are ignored.
 * Safe next to the handler's own wait: an outcome is relayed once.
 *
 * ```ts
 * // config/agent.ts
 * actionProposalWorker: { onSettled: channels.onSettled }
 * ```
 */
export async function relayChannelOutcome(proposal: ActionProposal): Promise<void> {
  await deliverOutcome(proposal);
}

export const channels = {
  /** See {@link handleChannel}. */
  handle: handleChannel,
  /** See {@link relayChannelOutcome}. */
  onSettled: relayChannelOutcome,
  /** Relay one proposal's outcome now; `true` when it was sent. */
  deliverOutcome: (proposal: ActionProposal, service?: ChannelTurnService) =>
    deliverOutcome(proposal, service),
  /** The adapter registered under `name` (by `channels.handle`), if any. */
  adapter: (name: string): ChannelAdapter | undefined => registry.get(name)?.adapter,
};
