import {
  ptBrActionProposalText,
  type TextActionProposalVocabulary,
} from '../action-proposal-text.js';
import type { AttachmentLimits } from '../attachment-limits.js';
import type { ToolConfirmation } from '../tool-presentation.js';
import {
  type ChannelQuestionTexts,
  DEFAULT_CHANNEL_QUESTION_TEXTS,
  ptBrChannelQuestionTexts,
} from './questions.js';
import type { InboundMedia } from './types.js';

/** A proposal the turn left pending, as the channel puts it to the person. */
export interface ChannelProposal {
  id: string;
  toolName: string;
  confirmation?: ToolConfirmation;
}

/** Why a media message could not be attached. */
export type ChannelMediaRefusal = 'disabled' | 'type' | 'size' | 'failed';

/** A component the turn drew (`uiCapabilities` let it), as `renderComponent` gets it. */
export interface ChannelComponent {
  /** Stable per component: a later frame with the same id replaces it. */
  id: string;
  name: string;
  data: unknown;
  version: number;
  fallbackText?: string;
}

/**
 * Everything the channel says on its own (not the model). English by default, Brazilian Portuguese
 * ({@link ptBrChannelTexts}) when the agent's `actionProposalText` is `ptBrActionProposalText`;
 * override any — per message too (`texts` as a function).
 */
export interface ChannelTexts {
  /** The Confirm button's label. */
  approve: string;
  /** The Cancel button's label. */
  reject: string;
  /** What a proposal says above its buttons — default: its confirmation's bold title and detail. */
  proposal(proposal: ChannelProposal): string;
  /**
   * A short line under a proposal card ("Valid for 5 minutes."): the provider's footer where it has
   * one, else the card's last line. Omitted (or `undefined`) → none.
   */
  footer?: string | ((proposal: ChannelProposal) => string | undefined);
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
  /**
   * A decision ("yes", "no #ID", a button) with no confirmation of THIS conversation to decide: a
   * text channel only decides the cards it delivered itself.
   */
  noPendingConfirmation: string;
  /** A decision without `#ID` while several cards of this conversation are pending. */
  ambiguousDecision(
    proposalIds: readonly string[],
    commands: { approve: string; reject: string },
  ): string;
  /** "Always in this conversation" on a channel that does not take it (`allowRemember: false`). */
  rememberRefused: string;
  /** A file that could not be attached — no attachment store, a type or size it refuses, a failed download. */
  mediaRefused(
    reason: ChannelMediaRefusal,
    media: InboundMedia,
    limits: AttachmentLimits | null,
  ): string;
  /** How questions (the `ask` tool, intakes) are worded. */
  questions: ChannelQuestionTexts;
  /** Answer a sender `actor()` maps to nobody. Omitted → say nothing. See also `unknownSender`. */
  unknownSender?: string;
  /**
   * A turn that answered only with components `renderComponent` turned into files (no text): what
   * to say after them. Omitted → nothing.
   */
  componentsOnly?(components: readonly ChannelComponent[]): string | undefined;
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
  noPendingConfirmation: 'There is nothing waiting for your confirmation here.',
  ambiguousDecision: (ids, { approve, reject }) =>
    `Which one? Reply *${approve} #ID* or *${reject} #ID*: ${ids.map((id) => `#${id}`).join(', ')}`,
  rememberRefused: 'Here every action needs its own confirmation. Reply without "always".',
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
  noPendingConfirmation: 'Não há nenhuma confirmação pendente por aqui.',
  ambiguousDecision: (ids, { approve, reject }) =>
    `Qual delas? Responda *${approve} #ID* ou *${reject} #ID*: ${ids.map((id) => `#${id}`).join(', ')}`,
  rememberRefused:
    'Por aqui cada ação precisa da sua própria confirmação. Responda sem o "sempre".',
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

/** `overrides` over `base`, `questions` merged too. */
export const mergeTexts = (
  overrides: ChannelTextsOverrides = {},
  base: ChannelTexts = DEFAULT_CHANNEL_TEXTS,
): ChannelTexts => ({
  ...base,
  ...overrides,
  questions: { ...base.questions, ...overrides.questions },
});
