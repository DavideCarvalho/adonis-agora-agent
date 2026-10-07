import type { HttpContext } from '@adonisjs/core/http';
import { DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY } from '../action-proposal-text.js';
import { AgentService } from '../agent-service.js';
import type { StreamFrame } from '../spi/token-stream-sink.js';
import type { ToolConfirmation } from '../tool-presentation.js';
import type { Actor, PageContext } from '../types.js';
import { type ChannelDedupeStore, InMemoryChannelDedupe } from './dedupe.js';
import { toChannelMarkdown } from './markdown.js';
import { splitMessage } from './split.js';
import type { ChannelAdapter, ChannelRequest, InboundMessage, OutboundMessage } from './types.js';

/**
 * What a channel turn needs from the agent — `AgentService` is one. The proposal methods are
 * optional: without them (blocking approvals) a button press is read as the text it says.
 */
export interface ChannelTurnService
  extends Pick<AgentService, 'send' | 'subscribe' | 'skip' | 'cancel' | 'actionProposalReply'>,
    Partial<
      Pick<
        AgentService,
        | 'decideActionProposal'
        | 'listActionProposals'
        | 'actionProposalVocabulary'
        | 'actionApprovalMode'
      >
    > {}

/** A proposal the turn left pending, as the channel puts it to the person. */
export interface ChannelProposal {
  id: string;
  toolName: string;
  confirmation?: ToolConfirmation;
}

/** Everything the channel says on its own (not the model). English defaults; override any. */
export interface ChannelTexts {
  /** The Confirm button's label. */
  approve: string;
  /** The Cancel button's label. */
  reject: string;
  /** What a proposal says above its buttons — default: its confirmation's bold title and detail. */
  proposal(proposal: ChannelProposal): string;
  /**
   * How to answer a proposal by text, when there are no buttons. `approve`/`reject` are the reply
   * commands, built from the configured `actionProposalText.vocabulary` — `#ID` included when more
   * than one proposal is waiting.
   */
  instruction(commands: { approve: string; reject: string }): string;
  /** An approval in blocking mode, which a text channel cannot settle. */
  blockingApproval: string;
  /** The turn failed. */
  failed: string;
  /** An approved action ran, and presented nothing the channel could show. */
  actionSucceeded: string;
  /** An approved action's execution failed. */
  actionFailed: string;
  /** Answer a sender `actor()` maps to nobody. Omitted → say nothing. */
  unknownSender?: string;
}

export const DEFAULT_CHANNEL_TEXTS: ChannelTexts = {
  approve: 'Confirm',
  reject: 'Cancel',
  proposal: ({ confirmation, toolName }) =>
    confirmation
      ? `*${confirmation.title}*${confirmation.detail ? `\n${confirmation.detail}` : ''}`
      : `*Run ${toolName}?*`,
  instruction: ({ approve, reject }) => `Reply *${approve}* to confirm or *${reject}* to cancel.`,
  blockingApproval: 'This action needs an approval that can only be given in the app.',
  failed: 'Sorry, something went wrong. Please try again.',
  actionSucceeded: 'Done.',
  actionFailed: 'The action could not be completed.',
};

export interface ChannelHandleOptions {
  /**
   * The account the sender is — from `message.from` (a phone number, a Telegram id). `null` → the
   * message is not answered (or answered with `texts.unknownSender`). This IS the authentication of
   * every message, so map only senders the channel itself vouches for.
   */
  actor(message: InboundMessage): Actor | null | Promise<Actor | null>;
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
  /** The turn's page context. Default `{ kind: adapter.name }`. */
  pageContext?: PageContext | ((message: InboundMessage) => PageContext);
  /** The agent that answers. Default: the thread's, else the configured default. */
  agentName?: string;
  /** The agent service. Default: `AgentService` from the container. */
  service?: ChannelTurnService;
  /**
   * Where taken message ids are remembered. Default: in this process's memory — use
   * `redisChannelDedupe()` (or your own store) when the app runs on several replicas. `false` → no
   * deduplication.
   */
  dedupe?: ChannelDedupeStore | false;
  /** How long a message id is remembered. Default 24 h. */
  dedupeTtlMs?: number;
  /** Stop waiting for a turn after this long (and cancel it). Default 5 minutes. */
  timeoutMs?: number;
  /**
   * After a proposal is approved, wait this long for it to execute and relay its outcome. `0` → do
   * not wait (the decision reply is all the person gets). Default 60 s.
   */
  outcomeTimeoutMs?: number;
  texts?: Partial<ChannelTexts>;
  /** A message whose handling failed. Default: `console.error`. */
  onError?(error: unknown, message: InboundMessage): void;
}

/** The route handler `channels.handle()` returns. */
export interface ChannelRouteHandler {
  (ctx: HttpContext): Promise<void>;
  /** Resolves once every turn this handler started has been answered — for tests and shutdown. */
  drain(): Promise<void>;
}

const BUTTON_ID = /^agora:(approve|reject):([^\s]+)$/;
/** The tail of a proposal id a button carries — Telegram's `callback_data` holds 64 bytes. */
const BUTTON_REF_LENGTH = 32;
const OUTCOME_POLL_MS = 500;

const buttonRef = (proposalId: string) => proposalId.slice(-BUTTON_REF_LENGTH);

/** The button ids for a proposal: what {@link ChannelRouteHandler} maps back to its decision. */
export function proposalButtonIds(proposalId: string): { approve: string; reject: string } {
  const ref = buttonRef(proposalId);
  return { approve: `agora:approve:${ref}`, reject: `agora:reject:${ref}` };
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

/**
 * The webhook route for one channel. Each request is verified (`401` when it is not the provider's),
 * parsed, deduplicated by the provider's message id, and acknowledged with `200` at once; the turn
 * runs after the response, so a slow model never makes the provider retry. Then:
 *
 * - the message is sent with text-only capabilities (components arrive as their `fallbackText`);
 *   a text decision ("yes", "confirm #ID") is answered with its reply instead of starting a turn;
 * - a press on a proposal's button decides that proposal (`via` = the adapter's name);
 * - the reply is converted to the channel's markdown, split at its length limit, and sent;
 * - a proposal the turn left pending is sent with Confirm/Cancel buttons — or, on a channel without
 *   them, with a text instruction in the configured `actionProposalText` vocabulary;
 * - an approved proposal's outcome is relayed once it executed (see `outcomeTimeoutMs`).
 *
 * Wants `actionApprovalMode: 'independent'`: a blocking approval holds the turn open until someone
 * decides it in the app, so the channel sends what it has and `texts.blockingApproval`.
 */
export function handleChannel(
  adapter: ChannelAdapter,
  options: ChannelHandleOptions,
): ChannelRouteHandler {
  const texts: ChannelTexts = { ...DEFAULT_CHANNEL_TEXTS, ...options.texts };
  const dedupe = options.dedupe === false ? null : (options.dedupe ?? new InMemoryChannelDedupe());
  const dedupeTtlMs = options.dedupeTtlMs ?? 24 * 60 * 60 * 1000;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const outcomeTimeoutMs = options.outcomeTimeoutMs ?? 60_000;
  const { capabilities } = adapter;
  const buttons = (capabilities.buttons ?? 0) >= 2;
  const inFlight = new Set<Promise<void>>();

  const format = (text: string) =>
    splitMessage(toChannelMarkdown(text, capabilities.markdown), capabilities.maxLength);

  const deliver = async (conversation: string, text: string) => {
    for (const piece of format(text)) await adapter.send(conversation, { text: piece });
  };

  const commandsFor = (
    service: ChannelTurnService,
    proposalId: string,
    withId: boolean,
  ): { approve: string; reject: string } => {
    const vocabulary =
      service.actionProposalVocabulary?.() ?? DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY;
    const suffix = withId ? ` #${proposalId}` : '';
    return {
      approve: `${vocabulary.approve[0] ?? 'yes'}${suffix}`,
      reject: `${vocabulary.reject[0] ?? 'no'}${suffix}`,
    };
  };

  const sendProposal = async (
    service: ChannelTurnService,
    conversation: string,
    proposal: ChannelProposal,
    withId: boolean,
  ) => {
    const summary = texts.proposal(proposal);
    const instruction = texts.instruction(commandsFor(service, proposal.id, withId));
    const asText = toChannelMarkdown(`${summary}\n\n${instruction}`, capabilities.markdown);
    if (!buttons) {
      for (const piece of splitMessage(asText, capabilities.maxLength))
        await adapter.send(conversation, { text: piece });
      return;
    }
    const ids = proposalButtonIds(proposal.id);
    const message: OutboundMessage = {
      text: toChannelMarkdown(summary, capabilities.markdown).slice(0, capabilities.maxLength),
      buttons: [
        { id: ids.approve, label: texts.approve },
        { id: ids.reject, label: texts.reject },
      ],
      fallbackText: asText.slice(0, capabilities.maxLength),
    };
    await adapter.send(conversation, message);
  };

  /** Wait for an approved proposal to run, then relay what it said (or that it failed). */
  const relayOutcome = async (
    service: ChannelTurnService,
    actor: Actor,
    threadId: string,
    proposalId: string,
    conversation: string,
  ) => {
    if (outcomeTimeoutMs <= 0 || !service.listActionProposals) return;
    const deadline = Date.now() + outcomeTimeoutMs;
    while (Date.now() < deadline) {
      const current = (await service.listActionProposals(actor, threadId)).find(
        (proposal) => proposal.id === proposalId,
      );
      if (current?.decision !== 'approved') return;
      const status = current.execution?.status;
      if (status === 'failed') {
        await deliver(conversation, texts.actionFailed);
        return;
      }
      if (status === 'succeeded') {
        // What its presentation said (`present` / `emitUi` text), else a plain confirmation.
        await deliver(conversation, current.outcome?.text?.trim() || texts.actionSucceeded);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, OUTCOME_POLL_MS));
    }
  };

  /** A press on one of our proposal buttons: decide it. `false` → not one of ours. */
  const pressButton = async (
    service: ChannelTurnService,
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
      await deliver(
        message.conversation,
        service.actionProposalReply({ status: 'not_found' }, decision),
      );
      return true;
    }
    const result = await service.decideActionProposal(
      actor,
      threadId,
      proposal.id,
      decision,
      {},
      adapter.name,
    );
    await deliver(message.conversation, service.actionProposalReply(result, decision));
    if (result.status === 'applied' && decision === 'approved')
      await relayOutcome(service, actor, threadId, proposal.id, message.conversation);
    return true;
  };

  /** Read a run's frames until it ends (or parks on something a text channel cannot settle). */
  const readTurn = async (service: ChannelTurnService, actor: Actor, runId: string) => {
    const parts: string[] = [];
    const proposals = new Map<string, ChannelProposal>();
    let failed = false;
    let blocked = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const stream = service.subscribe(runId)[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await Promise.race([stream.next(), deadline]);
        if (next === 'timeout') {
          failed = parts.length === 0;
          await service.cancel(runId).catch(() => {});
          break;
        }
        if (next.done) break;
        const frame: StreamFrame = next.value;
        if (frame.t === 'text') parts.push(frame.v);
        else if (frame.t === 'component' && frame.fallbackText) {
          // Only a component the turn negotiated as drawable comes as a frame — never with
          // text-only capabilities; its text is all a channel can show.
          parts.push(`\n\n${frame.fallbackText}\n\n`);
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
          // A form has no text rendering: the agent proceeds on its own assumptions, as if the
          // person had skipped it.
          await service
            .skip({
              runId: frame.runId,
              toolCallId: frame.id,
              answeredByRef: actor.id,
              answeredVia: adapter.name,
            })
            .catch(() => {});
        } else if (frame.t === 'error') failed = true;
      }
    } finally {
      clearTimeout(timer);
      void stream.return?.();
    }
    return { text: parts.join('').trim(), proposals: [...proposals.values()], failed, blocked };
  };

  const handleMessage = async (service: ChannelTurnService, message: InboundMessage) => {
    await adapter.acknowledge?.(message).catch(() => {});
    const actor = await options.actor(message);
    if (actor === null) {
      if (texts.unknownSender !== undefined)
        await deliver(message.conversation, texts.unknownSender);
      return;
    }
    const threadId = (await options.thread(actor, message)) ?? null;
    if (await pressButton(service, actor, threadId, message)) return;
    const pageContext =
      typeof options.pageContext === 'function'
        ? options.pageContext(message)
        : (options.pageContext ?? { kind: adapter.name });
    const sent = await service.send({
      actor,
      message: message.text,
      ...(threadId !== null ? { threadId } : {}),
      ...(options.agentName !== undefined ? { agentName: options.agentName } : {}),
      // Nothing is drawn: every component arrives as its text.
      uiCapabilities: { components: [] },
      pageContext,
      hostContext: {
        channel: adapter.name,
        conversation: message.conversation,
        messageId: message.id,
      },
    });
    if (threadId === null) await options.onThreadCreated?.(sent.threadId, actor, message);
    if ('proposalDecision' in sent) {
      await deliver(message.conversation, sent.text);
      const decided = sent.proposalDecision;
      if (
        'proposal' in decided &&
        decided.status === 'applied' &&
        decided.proposal?.decision === 'approved'
      )
        await relayOutcome(
          service,
          actor,
          sent.threadId,
          decided.proposal.id,
          message.conversation,
        );
      return;
    }
    // A queued message starts later under its own id: its answer is read the same way.
    const runId = sent.queued === true ? (sent.runId ?? sent.messageId) : sent.runId;
    const turn = await readTurn(service, actor, runId);
    if (turn.text !== '') await deliver(message.conversation, turn.text);
    if (turn.failed) await deliver(message.conversation, texts.failed);
    if (turn.blocked) await deliver(message.conversation, texts.blockingApproval);
    for (const proposal of turn.proposals)
      await sendProposal(service, message.conversation, proposal, turn.proposals.length > 1);
  };

  const track = (work: Promise<void>) => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };

  const handler = async (ctx: HttpContext) => {
    const request = requestOf(ctx);
    const challenge = adapter.challenge?.(request) ?? null;
    if (challenge !== null) {
      ctx.response
        .status(challenge.status)
        .header('content-type', challenge.contentType ?? 'text/plain')
        .send(challenge.body);
      return;
    }
    if (request.method !== 'POST') {
      ctx.response.status(405).send({ error: 'method_not_allowed' });
      return;
    }
    if (!(await adapter.verify(request))) {
      ctx.response.status(401).send({ error: 'unauthorized' });
      return;
    }
    const parsed = adapter.parse(request.body);
    const messages = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
    const fresh: InboundMessage[] = [];
    // Claimed before the 200: a store that is down answers 500, and the provider retries.
    for (const message of messages) {
      if (dedupe === null || (await dedupe.claim(`${adapter.name}:${message.id}`, dedupeTtlMs)))
        fresh.push(message);
    }
    if (fresh.length > 0) {
      const service =
        options.service ??
        ((await ctx.containerResolver.make(AgentService)) as unknown as ChannelTurnService);
      for (const message of fresh) {
        track(
          handleMessage(service, message).catch((error: unknown) => {
            if (options.onError) options.onError(error, message);
            else
              console.error('[@adonis-agora/agent] Channel message failed', {
                channel: adapter.name,
                message: error instanceof Error ? error.message : String(error),
              });
          }),
        );
      }
    }
    ctx.response.status(200).send({ ok: true });
  };

  return Object.assign(handler, {
    async drain() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  });
}

/** `channels.handle(adapter, options)` — see {@link handleChannel}. */
export const channels = { handle: handleChannel };
