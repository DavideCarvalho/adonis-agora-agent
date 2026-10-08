import type { HttpContext } from '@adonisjs/core/http';
import {
  DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY,
  ptBrActionProposalText,
  type TextActionProposalVocabulary,
} from '../action-proposal-text.js';
import { AgentService, AttachmentRefusedError } from '../agent-service.js';
import type { AttachmentLimits } from '../attachment-limits.js';
import type { ElicitationQuestion } from '../elicitation.js';
import type { ActionProposal } from '../spi/action-proposal-store.js';
import type { AttachmentRef } from '../spi/attachment-staging.js';
import type { StreamFrame } from '../spi/token-stream-sink.js';
import type { ToolConfirmation } from '../tool-presentation.js';
import type { Actor, PageContext } from '../types.js';
import { ChannelMediaTooLargeError } from './http.js';
import { toChannelMarkdown } from './markdown.js';
import {
  type ChannelQuestionTexts,
  DEFAULT_CHANNEL_QUESTION_TEXTS,
  formatChannelQuestion,
  parseChannelAnswer,
  ptBrChannelQuestionTexts,
} from './questions.js';
import { splitMessage } from './split.js';
import { type ChannelStore, InMemoryChannelStore, lucidChannelStore } from './store.js';
import type {
  ChannelAdapter,
  ChannelRequest,
  InboundMedia,
  InboundMessage,
  OutboundMessage,
} from './types.js';

/**
 * What a channel turn needs from the agent — `AgentService` is one. The optional methods turn
 * features on: proposals (buttons, outcomes), questions (`answer`), media (`stageAttachment`), and
 * the Lucid default store (`lucidDatabase`).
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
        | 'answer'
        | 'attachmentLimits'
        | 'stageAttachment'
        | 'lucidDatabase'
      >
    > {}

/** A proposal the turn left pending, as the channel puts it to the person. */
export interface ChannelProposal {
  id: string;
  toolName: string;
  confirmation?: ToolConfirmation;
}

/** Why a media message could not be attached. */
export type ChannelMediaRefusal = 'disabled' | 'type' | 'size' | 'failed';

/**
 * Everything the channel says on its own (not the model). English by default, Brazilian Portuguese
 * ({@link ptBrChannelTexts}) when the agent's `actionProposalText` is `ptBrActionProposalText`;
 * override any.
 */
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
  /** A file that could not be attached — no attachment store, a type or size it refuses, a failed download. */
  mediaRefused(
    reason: ChannelMediaRefusal,
    media: InboundMedia,
    limits: AttachmentLimits | null,
  ): string;
  /** How questions (the `ask` tool, intakes) are worded. */
  questions: ChannelQuestionTexts;
  /** Answer a sender `actor()` maps to nobody. Omitted → say nothing. */
  unknownSender?: string;
}

/** `20 MB`, `512 KB`. */
const readableSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024))} MB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;

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
  mediaRefused: (reason, media, limits) =>
    reason === 'disabled'
      ? 'I can only read text messages here.'
      : reason === 'size'
        ? `That file is too large${limits ? ` (the limit is ${readableSize(limits.maxBytes)})` : ''}.`
        : reason === 'failed'
          ? 'I could not download that file. Please send it again.'
          : media.kind === 'audio'
            ? 'I cannot listen to audio messages. Please type your message.'
            : `I cannot read this kind of file${media.contentType ? ` (${media.contentType})` : ''}.`,
  questions: DEFAULT_CHANNEL_QUESTION_TEXTS,
};

/**
 * Brazilian Portuguese channel texts — the default when the agent's `actionProposalText` is
 * `ptBrActionProposalText`, so the reply words and what the channel says agree.
 */
export const ptBrChannelTexts: ChannelTexts = {
  approve: 'Confirmar',
  reject: 'Cancelar',
  proposal: ({ confirmation, toolName }) =>
    confirmation
      ? `*${confirmation.title}*${confirmation.detail ? `\n${confirmation.detail}` : ''}`
      : `*Executar ${toolName}?*`,
  instruction: ({ approve, reject }) =>
    `Responda *${approve}* para confirmar ou *${reject}* para cancelar.`,
  blockingApproval: 'Esta ação precisa de uma aprovação que só pode ser dada no app.',
  failed: 'Desculpe, algo deu errado. Tente de novo, por favor.',
  actionSucceeded: 'Pronto.',
  actionFailed: 'Não foi possível concluir a ação.',
  mediaRefused: (reason, media, limits) =>
    reason === 'disabled'
      ? 'Por aqui eu só consigo ler mensagens de texto.'
      : reason === 'size'
        ? `Esse arquivo é grande demais${limits ? ` (o limite é ${readableSize(limits.maxBytes)})` : ''}.`
        : reason === 'failed'
          ? 'Não consegui baixar esse arquivo. Envie de novo, por favor.'
          : media.kind === 'audio'
            ? 'Não consigo ouvir mensagens de áudio. Escreva sua mensagem, por favor.'
            : `Não consigo ler esse tipo de arquivo${media.contentType ? ` (${media.contentType})` : ''}.`,
  questions: ptBrChannelQuestionTexts,
};

/**
 * The channel texts that speak the language of the agent's text-decision words: {@link
 * ptBrChannelTexts} for `ptBrActionProposalText` (or any vocabulary whose `language` is Portuguese),
 * else {@link DEFAULT_CHANNEL_TEXTS}.
 */
export function channelTextsFor(vocabulary?: TextActionProposalVocabulary | null): ChannelTexts {
  if (!vocabulary) return DEFAULT_CHANNEL_TEXTS;
  const portuguese =
    /^pt(-|$)/i.test(vocabulary.language ?? '') ||
    vocabulary.approve === ptBrActionProposalText.vocabulary.approve;
  return portuguese ? ptBrChannelTexts : DEFAULT_CHANNEL_TEXTS;
}

/**
 * `texts` as `channels.handle` takes it: any part, `questions` too — over the texts in the language of
 * the agent's `actionProposalText` (see {@link channelTextsFor}).
 */
export type ChannelTextsOverrides = Partial<Omit<ChannelTexts, 'questions'>> & {
  questions?: Partial<ChannelQuestionTexts>;
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
   * Where the channel's short-lived state lives: message ids already taken, questions waiting for an
   * answer, outcomes already relayed. Default: `lucidChannelStore()` over the agent store's database
   * when the agent store is Lucid, else this process's memory.
   */
  store?: ChannelStore;
  /** How long a message id is remembered. Default 24 h. */
  dedupeTtlMs?: number;
  /** Stop waiting for a turn after this long (and cancel it). Default 5 minutes. */
  timeoutMs?: number;
  /**
   * After a proposal is approved, wait this long for it to execute and relay its outcome. `0` → do
   * not wait (the decision reply is all the person gets; `channels.onSettled` can still relay it).
   * Default 60 s.
   */
  outcomeTimeoutMs?: number;
  /** How long a question waits for its answer before the agent proceeds without it. Default 30 min. */
  questionTimeoutMs?: number;
  /**
   * What the channel says on its own. Omitted parts come from {@link channelTextsFor}: Brazilian
   * Portuguese when the agent's `actionProposalText` is `ptBrActionProposalText`, else English.
   */
  texts?: ChannelTextsOverrides;
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
/** How long "this outcome was relayed" is remembered. */
const OUTCOME_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const buttonRef = (proposalId: string) => proposalId.slice(-BUTTON_REF_LENGTH);

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
  runId: string;
  toolCallId: string;
  preamble?: string;
  questions: ElicitationQuestion[];
  index: number;
  answers: Record<string, string[]>;
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

/**
 * A verified webhook that carried no message to answer: logged (debug; warn when it looked like a
 * person's message that could not be read) with the event and the reason — never the content — so a
 * silently dropped message can be diagnosed.
 */
function logIgnored(ctx: HttpContext, adapter: ChannelAdapter, body: unknown): void {
  const logger = (ctx as { logger?: ChannelLogger }).logger;
  if (!logger) return;
  const ignored = adapter.ignored?.(body) ?? null;
  const event =
    ignored?.event ??
    (typeof body === 'object' && body !== null ? (body as { event?: unknown }).event : undefined);
  const bindings = {
    channel: adapter.name,
    ...(typeof event === 'string' ? { event } : {}),
    reason: ignored?.reason ?? 'no message',
  };
  const log = ignored?.unexpected ? logger.warn : logger.debug;
  log?.call(logger, bindings, 'channels: webhook ignored');
}

/** `AgentService` from the app's container, for code that runs outside a request. */
async function containerService(): Promise<ChannelTurnService> {
  const { default: app } = await import('@adonisjs/core/services/app');
  return (await app.container.make(AgentService)) as unknown as ChannelTurnService;
}

/** One registered channel: what `channels.onSettled` sends an outcome through. */
interface Registration {
  adapter: ChannelAdapter;
  texts(service?: ChannelTurnService): Promise<ChannelTexts>;
  store(service?: ChannelTurnService): Promise<ChannelStore>;
}

const registry = new Map<string, Registration>();

const mergeTexts = (
  overrides: ChannelTextsOverrides = {},
  base: ChannelTexts = DEFAULT_CHANNEL_TEXTS,
): ChannelTexts => ({
  ...base,
  ...overrides,
  questions: { ...base.questions, ...overrides.questions },
});

/** Send `text` converted to the channel's markdown, split at its length limit. */
async function deliverText(adapter: ChannelAdapter, conversation: string, text: string) {
  const { markdown, maxLength } = adapter.capabilities;
  for (const piece of splitMessage(toChannelMarkdown(text, markdown), maxLength))
    await adapter.send(conversation, { text: piece });
}

/** What an executed proposal tells the person; `null` when it did not execute. */
function outcomeText(proposal: ActionProposal, texts: ChannelTexts): string | null {
  const status = proposal.execution?.status;
  if (status === 'failed') return texts.actionFailed;
  if (status !== 'succeeded') return null;
  // What its presentation said (`present` / `emitUi` text), else a plain confirmation.
  return proposal.outcome?.text?.trim() || texts.actionSucceeded;
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
  const name = typeof address?.name === 'string' ? address.name : undefined;
  const conversation = typeof address?.conversation === 'string' ? address.conversation : undefined;
  const registration = name === undefined ? undefined : registry.get(name);
  if (!registration || conversation === undefined) return false;
  return relayOnce(
    await registration.store(service),
    registration.adapter,
    await registration.texts(service),
    conversation,
    proposal,
  );
}

/** Send an executed proposal's outcome unless it was sent already (by this or another replica). */
async function relayOnce(
  store: ChannelStore,
  adapter: ChannelAdapter,
  texts: ChannelTexts,
  conversation: string,
  proposal: ActionProposal,
): Promise<boolean> {
  const text = outcomeText(proposal, texts);
  if (text === null) return false;
  if (!(await store.claim(`${adapter.name}:outcome:${proposal.id}`, OUTCOME_TTL_MS))) return false;
  await deliverText(adapter, conversation, text);
  return true;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `image/jpeg` → `jpeg`, for a file that arrives without a name. */
const extensionOf = (contentType: string) =>
  (contentType.split('/')[1] ?? 'bin').split(/[;+]/)[0] ?? 'bin';

/**
 * The webhook route for one channel. Each request is verified (`401` when it is not the provider's),
 * parsed, deduplicated by the provider's message id, and acknowledged with `200` at once; the turn
 * runs after the response, so a slow model never makes the provider retry. Then:
 *
 * - media are downloaded and attached (held to the attachment store's limits), or refused with a text;
 * - the message is sent with text-only capabilities (components arrive as their `fallbackText`);
 *   a text decision ("yes", "confirm #ID") is answered with its reply instead of starting a turn;
 * - a press on a proposal's button decides that proposal (`via` = the adapter's name);
 * - a question the turn asks is sent as text, one at a time, and the next messages answer it;
 * - the reply is converted to the channel's markdown, split at its length limit, and sent;
 * - a proposal the turn left pending is sent with Confirm/Cancel buttons — or, on a channel without
 *   them, with a text instruction in the configured `actionProposalText` vocabulary;
 * - an approved proposal's outcome is relayed once it executed (see `outcomeTimeoutMs`, and
 *   `channels.onSettled` for one that runs later).
 *
 * Wants `actionApprovalMode: 'independent'`: a blocking approval holds the turn open until someone
 * decides it in the app, so the channel sends what it has and `texts.blockingApproval`.
 *
 * Registers the adapter under its `name` for `channels.onSettled` — names must be unique.
 */
export function handleChannel(
  adapter: ChannelAdapter,
  options: ChannelHandleOptions,
): ChannelRouteHandler {
  let resolvedTexts: ChannelTexts | undefined;
  /** The texts, over the defaults in the language of the service's vocabulary — chosen once. */
  const textsFor = (service?: ChannelTurnService): ChannelTexts => {
    if (resolvedTexts) return resolvedTexts;
    const texts = mergeTexts(
      options.texts,
      channelTextsFor(service?.actionProposalVocabulary?.() ?? null),
    );
    if (service) resolvedTexts = texts;
    return texts;
  };
  const dedupeTtlMs = options.dedupeTtlMs ?? 24 * 60 * 60 * 1000;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const outcomeTimeoutMs = options.outcomeTimeoutMs ?? 60_000;
  const questionTimeoutMs = options.questionTimeoutMs ?? 30 * 60 * 1000;
  const { capabilities } = adapter;
  const buttons = (capabilities.buttons ?? 0) >= 2;
  const inFlight = new Set<Promise<void>>();

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
  registry.set(adapter.name, {
    adapter,
    texts: async (service) =>
      textsFor(options.service ?? service ?? (await containerService().catch(() => undefined))),
    store: storeFor,
  });

  const deliver = (conversation: string, text: string) => deliverText(adapter, conversation, text);
  const questionKey = (conversation: string) => `${adapter.name}:question:${conversation}`;

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
    const texts = textsFor(service);
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
      instruction: toChannelMarkdown(instruction, capabilities.markdown),
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
      const texts = textsFor(service);
      if (outcomeText(current, texts) !== null) {
        await relayOnce(await storeFor(service), adapter, texts, conversation, current);
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

  const askNext = (
    service: ChannelTurnService,
    conversation: string,
    pending: PendingQuestions,
  ) => {
    const question = pending.questions[pending.index];
    if (!question) return Promise.resolve();
    return deliver(
      conversation,
      formatChannelQuestion(
        question,
        {
          index: pending.index,
          total: pending.questions.length,
          ...(pending.preamble !== undefined ? { preamble: pending.preamble } : {}),
        },
        textsFor(service).questions,
      ),
    );
  };

  /** The person's message answers the question in front of them; the last one resumes the run. */
  const answerQuestion = async (
    service: ChannelTurnService,
    store: ChannelStore,
    actor: Actor,
    message: InboundMessage,
    pending: PendingQuestions,
  ) => {
    const question = pending.questions[pending.index];
    if (!question || !service.answer) return;
    const texts = textsFor(service);
    const parsed = parseChannelAnswer(question, message.text, texts.questions.skipWord);
    if (parsed.status === 'invalid') {
      await deliver(message.conversation, texts.questions.invalid(parsed.problem));
      await askNext(service, message.conversation, pending);
      return;
    }
    const next: PendingQuestions = {
      ...pending,
      index: pending.index + 1,
      answers:
        parsed.status === 'answer'
          ? { ...pending.answers, [question.id]: parsed.values }
          : pending.answers,
    };
    const key = questionKey(message.conversation);
    if (next.index < next.questions.length) {
      await store.set(key, JSON.stringify(next), questionTimeoutMs);
      await askNext(service, message.conversation, next);
      return;
    }
    await store.delete(key);
    // The turn that asked is still being read: what the agent says next reaches the person there.
    await service.answer({
      runId: next.runId,
      toolCallId: next.toolCallId,
      answers: next.answers,
      answeredByRef: actor.id,
      answeredVia: adapter.name,
    });
  };

  /** Download a message's files and stage them for the turn; refuse what cannot be attached. */
  const attachMedia = async (
    service: ChannelTurnService,
    actor: Actor,
    message: InboundMessage,
  ): Promise<AttachmentRef[]> => {
    const refs: AttachmentRef[] = [];
    const limits = service.attachmentLimits?.() ?? null;
    const texts = textsFor(service);
    for (const media of message.media ?? []) {
      const refuse = (reason: ChannelMediaRefusal) =>
        deliver(message.conversation, texts.mediaRefused(reason, media, limits));
      if (limits === null || !adapter.download || !service.stageAttachment) {
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
        const file = await adapter.download(media, { maxBytes: limits.maxBytes });
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
    return refs;
  };

  /** Read a run's frames until it ends (or parks on something a text channel cannot settle). */
  const readTurn = async (
    service: ChannelTurnService,
    store: ChannelStore,
    actor: Actor,
    runId: string,
    threadId: string | null,
    conversation: string,
  ) => {
    const parts: string[] = [];
    const proposals = new Map<string, ChannelProposal>();
    let failed = false;
    let blocked = false;
    let deadlineAt = Date.now() + timeoutMs;
    /** The question set this reader is waiting on, while it waits. */
    let asking: { runId: string; toolCallId: string } | null = null;
    const flush = async () => {
      const text = parts.join('').trim();
      parts.length = 0;
      if (text !== '') await deliver(conversation, text);
    };
    const stream = service.subscribe(runId)[Symbol.asyncIterator]();
    let reading: Promise<IteratorResult<StreamFrame>> | undefined;
    try {
      for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), Math.max(0, deadlineAt - Date.now()));
        });
        // A read that lost a race to the timer is still the next frame: keep it, never ask twice.
        reading ??= stream.next();
        const next = await Promise.race([reading, timeout]).finally(() => clearTimeout(timer));
        if (next !== 'timeout') reading = undefined;
        if (next === 'timeout') {
          if (asking !== null) {
            // Nobody answered: the agent goes on on its own assumptions.
            const { runId: parkedRun, toolCallId } = asking;
            asking = null;
            await store.delete(questionKey(conversation));
            await service
              .skip({
                runId: parkedRun,
                toolCallId,
                answeredByRef: actor.id,
                answeredVia: adapter.name,
              })
              .catch(() => {});
            deadlineAt = Date.now() + timeoutMs;
            continue;
          }
          failed = parts.length === 0;
          await service.cancel(runId).catch(() => {});
          break;
        }
        if (next.done) break;
        const frame: StreamFrame = next.value;
        if (asking !== null) {
          // The run moved on: the questions were answered (or skipped elsewhere).
          asking = null;
          deadlineAt = Date.now() + timeoutMs;
        }
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
          const questions = frame.request.questions;
          if (!service.answer || questions.length === 0) {
            await service
              .skip({
                runId: frame.runId,
                toolCallId: frame.id,
                answeredByRef: actor.id,
                answeredVia: adapter.name,
              })
              .catch(() => {});
            continue;
          }
          await flush();
          const pending: PendingQuestions = {
            threadId,
            runId: frame.runId,
            toolCallId: frame.id,
            ...(frame.request.preamble !== undefined ? { preamble: frame.request.preamble } : {}),
            questions,
            index: 0,
            answers: {},
          };
          await store.set(questionKey(conversation), JSON.stringify(pending), questionTimeoutMs);
          await askNext(service, conversation, pending);
          asking = { runId: frame.runId, toolCallId: frame.id };
          deadlineAt = Date.now() + questionTimeoutMs;
        } else if (frame.t === 'error') failed = true;
      }
    } finally {
      void stream.return?.();
    }
    return { text: parts.join('').trim(), proposals: [...proposals.values()], failed, blocked };
  };

  const handleMessage = async (service: ChannelTurnService, message: InboundMessage) => {
    await adapter.acknowledge?.(message).catch(() => {});
    const texts = textsFor(service);
    const store = await storeFor(service);
    const actor = await options.actor(message);
    if (actor === null) {
      if (texts.unknownSender !== undefined)
        await deliver(message.conversation, texts.unknownSender);
      return;
    }
    const threadId = (await options.thread(actor, message)) ?? null;
    const ours = message.buttonId !== undefined && BUTTON_ID.test(message.buttonId);
    if (!ours) {
      const waiting = await store.get(questionKey(message.conversation));
      const pending = waiting === null ? null : (JSON.parse(waiting) as PendingQuestions);
      if (pending !== null && (pending.threadId === null || pending.threadId === threadId)) {
        await answerQuestion(service, store, actor, message, pending);
        return;
      }
    }
    if (await pressButton(service, actor, threadId, message)) return;
    const attachments = await attachMedia(service, actor, message);
    // A file nobody could attach, and no caption: there is nothing left to answer.
    if (message.text === '' && attachments.length === 0) return;
    const pageContext =
      typeof options.pageContext === 'function'
        ? options.pageContext(message)
        : (options.pageContext ?? { kind: adapter.name });
    const channel: ChannelAddress = { name: adapter.name, conversation: message.conversation };
    const sent = await service.send({
      actor,
      message: message.text,
      ...(threadId !== null ? { threadId } : {}),
      ...(options.agentName !== undefined ? { agentName: options.agentName } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      // Nothing is drawn: every component arrives as its text.
      uiCapabilities: { components: [] },
      pageContext: { ...pageContext, channel },
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
    const turn = await readTurn(service, store, actor, runId, sent.threadId, message.conversation);
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
    if (messages.length === 0) logIgnored(ctx, adapter, request.body);
    if (messages.length > 0) {
      const service =
        options.service ??
        ((await ctx.containerResolver.make(AgentService)) as unknown as ChannelTurnService);
      const store = await storeFor(service);
      const fresh: InboundMessage[] = [];
      // Claimed before the 200: a store that is down answers 500, and the provider retries.
      for (const message of messages) {
        if (await store.claim(`${adapter.name}:${message.id}`, dedupeTtlMs)) fresh.push(message);
      }
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

/**
 * `actionProposalWorker.onSettled` for text channels: relays an executed proposal's outcome to the
 * conversation it was proposed in, through the adapter registered under the recorded channel name.
 * Proposals from other surfaces are ignored. Safe next to the handler's own wait: an outcome is
 * relayed once.
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
