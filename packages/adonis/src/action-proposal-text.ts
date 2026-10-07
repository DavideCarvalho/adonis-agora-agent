import type {
  ActionProposalDecision,
  ActionProposalMutationResult,
} from './spi/action-proposal-store.js';

export interface TextActionProposalCandidate {
  id: string;
  decision: ActionProposalDecision;
}
export type TextActionProposalResolution =
  | { status: 'unmatched' }
  | { status: 'ambiguous'; proposalIds: string[] }
  | {
      status: 'decision';
      proposalId: string;
      decision: 'approved' | 'rejected';
      remember: boolean;
    };

/**
 * Recognizes complete, explicit decision messages. This grants no authority: callers must
 * resolve the authenticated actor and use the normal scoped decision service with via=text.
 * Never feed model output here or consume an unmatched message as an approval.
 */
export function resolveTextActionProposalDecision(
  text: string,
  proposals: readonly TextActionProposalCandidate[],
  vocabulary?: TextActionProposalVocabulary,
): TextActionProposalResolution {
  const command = parseTextActionProposalCommand(text, vocabulary);
  if (command.status === 'unmatched') return command;
  const { decision, remember } = command;
  const pending = proposals.filter((proposal) => proposal.decision === 'pending');
  const explicitId = command.proposalId;
  if (explicitId !== undefined) {
    if (!pending.some((proposal) => proposal.id === explicitId)) return { status: 'unmatched' };
    return { status: 'decision', proposalId: explicitId, decision, remember };
  }
  if (pending.length === 0) return { status: 'unmatched' };
  if (pending.length > 1) return { status: 'ambiguous', proposalIds: pending.map(({ id }) => id) };
  const candidate = pending[0];
  if (!candidate) return { status: 'unmatched' };
  return { status: 'decision', proposalId: candidate.id, decision, remember };
}

export type TextActionProposalCommand =
  | { status: 'unmatched' }
  | {
      status: 'command';
      decision: 'approved' | 'rejected';
      remember: boolean;
      proposalId?: string;
    };

/**
 * The words a whole chat message must consist of to decide a proposal by text. Matched
 * case-insensitively, as the complete message (an optional trailing `.`/`!`, an optional `#ID`).
 */
export interface TextActionProposalVocabulary {
  /** Approve, e.g. `sim`, `yes`. */
  approve: readonly string[];
  /** Reject, e.g. `não`, `no`. */
  reject: readonly string[];
  /** The phrase after an approve word that also approves later calls of the tool in this thread. */
  remember: readonly string[];
}

/** Portuguese and English, side by side. */
export const DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY: TextActionProposalVocabulary = {
  approve: ['sim', 'confirmo', 'confirmar', 'aprovar', 'aprovo', 'yes', 'confirm', 'approve'],
  reject: ['cancelar', 'rejeitar', 'rejeito', 'não', 'nao', 'no', 'cancel', 'reject', 'deny'],
  remember: ['sempre nesta conversa', 'always in this conversation'],
};

/** What the agent answers to a text decision. Every field has a Portuguese default. */
export interface TextActionProposalReplies {
  approved: string;
  rejected: string;
  expired: string;
  /** The proposal could not change (already decided by someone else, superseded, …). */
  unchanged: string;
  /** More than one pending proposal could be meant: ask for the `#ID`. */
  ambiguous(proposalIds: readonly string[]): string;
  /** Too many pending proposals to pick one without an explicit `#ID`. */
  tooMany: string;
}

export const DEFAULT_TEXT_ACTION_PROPOSAL_REPLIES: TextActionProposalReplies = {
  approved: 'Proposta aprovada e enfileirada para execução.',
  rejected: 'Proposta rejeitada; nenhuma ação foi executada.',
  expired: 'A proposta expirou; nenhuma ação foi executada.',
  unchanged: 'Não foi possível alterar esta proposta; atualize a lista para consultar seu estado.',
  ambiguous: (ids) => `Qual proposta? Responda confirmar #ID ou cancelar #ID: ${ids.join(', ')}`,
  tooMany: 'Há várias propostas. Confirme ou rejeite usando #ID explícito.',
};

/** `config/agent.ts`'s `actionProposalText`: either part replaces the default it names. */
export interface TextActionProposalConfig {
  vocabulary?: Partial<TextActionProposalVocabulary>;
  replies?: Partial<TextActionProposalReplies>;
}

/** The reply to a decision the store answered with `result`. */
export function textActionProposalReply(
  result: ActionProposalMutationResult,
  decision: 'approved' | 'rejected',
  replies: TextActionProposalReplies = DEFAULT_TEXT_ACTION_PROPOSAL_REPLIES,
): string {
  return result.status === 'expired' || result.proposal?.decision === 'expired'
    ? replies.expired
    : result.status === 'applied' || result.status === 'unchanged'
      ? decision === 'approved'
        ? replies.approved
        : replies.rejected
      : replies.unchanged;
}

const escapeRegExp = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alternatives = (words: readonly string[]) =>
  words
    .map((word) => word.trim())
    .filter((word) => word.length > 0)
    .map((word) => escapeRegExp(word).replace(/\s+/g, '\\s+'))
    .join('|');
const fold = (word: string) => word.trim().toLowerCase();

/** Parse exact consent syntax only. Authentication and target lookup remain the caller's responsibility. */
export function parseTextActionProposalCommand(
  text: string,
  vocabulary: TextActionProposalVocabulary = DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY,
): TextActionProposalCommand {
  if (/[\r\n]/u.test(text)) return { status: 'unmatched' };
  const verbs = alternatives([...vocabulary.approve, ...vocabulary.reject]);
  if (verbs.length === 0) return { status: 'unmatched' };
  const remember = alternatives(vocabulary.remember);
  const match = new RegExp(
    `^(${verbs})${remember.length > 0 ? `(?: (${remember}))?` : '()'}(?: #([^\\s]+?))?[.!]?$`,
    'iu',
  ).exec(text.trim());
  if (!match) return { status: 'unmatched' };
  const verb = match[1] === undefined ? undefined : fold(match[1]);
  if (verb === undefined) return { status: 'unmatched' };
  // A word on both lists is read as a refusal: never infer consent from an ambiguous word.
  const decision = vocabulary.reject.some((word) => fold(word) === verb) ? 'rejected' : 'approved';
  const remembers = match[2] !== undefined && match[2] !== '';
  if (remembers && decision !== 'approved') return { status: 'unmatched' };
  return {
    status: 'command',
    decision,
    remember: remembers,
    ...(match[3] !== undefined ? { proposalId: match[3] } : {}),
  };
}
