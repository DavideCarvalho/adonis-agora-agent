/**
 * Asking the USER a structured question, and waiting for the answer.
 *
 * `awaitApproval` collects a yes/no about work already proposed; this collects the scope BEFORE the
 * work. Two surfaces produce it — a configured intake (`AgentLoopDeps.intake`) and the model-callable
 * `ask` tool (`AgentLoopDeps.ask`) — and they deliberately produce the SAME {@link
 * ElicitationRequest}, persist through the same tool-call row, and resume through the same
 * `tool:<runId>:<callId>` signal. A consumer cannot tell which one asked, and should not have to.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Decision, ToolDefinition } from './types.js';

/**
 * Whatever a human sent into a parked run. One channel carries both, because a question set is
 * persisted as a `pending_approval` action so it lands in the approvals inbox a deployment already
 * has — which means an operator pressing Approve there delivers a {@link Decision} to a run that is
 * waiting on answers. The loop reduces one to the other; see {@link normalizeElicitationReply}.
 */
export type HumanReply = Decision | ElicitationReply;

/**
 * Thrown when a reply is the wrong shape for the wait it was delivered to: answers to a question
 * set, addressed to a tool call that is waiting on an approve/reject.
 *
 * Refused rather than reduced, because there is no honest reduction in that direction. A yes/no can
 * be read as "confirmed the pre-picked answers" (see {@link normalizeElicitationReply}); a set of
 * answers says nothing at all about whether the proposed work should go ahead, and reading its
 * absent `approved` as `false` would record a rejection the person never made.
 */
export class HumanReplyMismatchError extends Error {
  constructor(
    public readonly runId: string,
    public readonly toolCallId: string,
  ) {
    super(
      `Tool call "${toolCallId}" on run "${runId}" is waiting for an approve/reject, not for answers`,
    );
    this.name = 'HumanReplyMismatchError';
  }
}

/**
 * Is this a human's yes/no {@link Decision}, rather than answers to a question set? Structural
 * rather than by class: both shapes are plain JSON off an HTTP body by the time they arrive, and
 * `approved` is the only field a `Decision` carries.
 */
export function isHumanDecision(reply: HumanReply): reply is Decision {
  return (
    typeof reply === 'object' &&
    reply !== null &&
    typeof (reply as Partial<Decision>).approved === 'boolean'
  );
}

/** One choice a question offers. */
export interface ElicitationOption {
  /** Stable identifier submitted back. Never shown to the user. */
  value: string;
  /** What the user reads. */
  label: string;
  /**
   * A single character a UI may bind as a keyboard shortcut for this option. Advisory — nothing in
   * the library reads it, and a client is free to render its own.
   */
  hotkey?: string;
}

/** One question in a set. */
export interface ElicitationQuestion {
  /** Unique within its request; the key answers come back under. */
  id: string;
  prompt: string;
  options: ElicitationOption[];
  /** More than one option may be chosen. Omit → single choice. */
  multiple?: boolean;
  /**
   * The options already picked for the user. The claim this whole surface makes is that confirming
   * is enough, so a question with no defaults is a question the user must stop and think about —
   * which is the case the design is trying to avoid. Empty/omitted is allowed and means exactly
   * that: submitting without answering leaves this question unanswered.
   */
  defaults?: string[];
  /** Accept values that are not among `options` (a typed-in answer). Omit → options only. */
  allowFreeText?: boolean;
}

/**
 * A question set awaiting a human. Identical in shape whether an `@Agent`'s configured intake or
 * the model's `ask` tool authored it — `source` records which, for audit, not for control flow.
 *
 * `questions.length` is known when the request is written, which is what lets a client render
 * "Question 1 of 3" without guessing whether a fourth is coming.
 */
export interface ElicitationRequest {
  /** The tool-call id this request is persisted under, and the signal it is answered through. */
  id: string;
  source: 'intake' | 'ask';
  /** What the assistant says above the form. */
  preamble?: string;
  questions: ElicitationQuestion[];
}

/** What a human sent back for an {@link ElicitationRequest}. */
export interface ElicitationReply {
  /**
   * questionId → chosen values. A question whose id is ABSENT takes the request's own `defaults` —
   * that is what makes "just submit" mean "yes, your pre-picked answers". A present-but-empty array
   * is an explicit "none of these" and does NOT fall back.
   */
  answers: Record<string, string[]>;
  /**
   * The user declined to answer and told the agent to proceed on its own assumptions. Distinct from
   * confirming the defaults even though the resulting values are the same: one is a decision the
   * user made, the other is one they refused to make, and only the first is evidence of intent.
   */
  skipped?: boolean;
  /** Opaque ref of WHO answered, when it wasn't the run's own actor. */
  answeredByRef?: string;
}

/** A settled elicitation: what the agent proceeds on, and how it got there. */
export interface ElicitationOutcome {
  /** One entry per question, in request order — always present, so a caller never re-applies defaults. */
  answers: Record<string, string[]>;
  skipped: boolean;
  /** Question ids filled from the request's `defaults` rather than by the human. */
  defaulted: string[];
}

function optionValues(question: ElicitationQuestion): Set<string> {
  return new Set(question.options.map((option) => option.value));
}

/**
 * Read whatever the human channel delivered as an {@link ElicitationReply}.
 *
 * A question set is persisted as an `action` tool call in `pending_approval` — that is what puts it
 * in the approvals inbox a deployment already has, instead of needing one of its own. The cost of
 * that choice is that the thing which comes back may be a {@link Decision} someone pressed
 * Approve/Reject on rather than a set of answers, and a `Decision` carries no `answers` at all.
 *
 * Approve means every question keeps its own pre-picked `defaults`, which is exactly what "just
 * submit" already means on this surface; Reject is the same declining-to-answer a skip is. Neither
 * reading is a guess — a yes/no channel cannot say more than that, and saying it here is what lets
 * one inbox settle both kinds of pending work.
 *
 * Returns the reply UNCHANGED when it already carries answers, so the common path allocates nothing
 * and a caller can identity-compare.
 */
export function normalizeElicitationReply(reply: HumanReply): ElicitationReply {
  if (typeof reply !== 'object' || reply === null) {
    return { answers: {} };
  }
  const candidate = reply as Partial<ElicitationReply> & Partial<Decision>;
  if (typeof candidate.answers === 'object' && candidate.answers !== null) {
    return reply as ElicitationReply;
  }
  const answeredByRef = candidate.answeredByRef ?? candidate.executedByRef;
  return {
    answers: {},
    ...(candidate.approved === false || candidate.skipped === true ? { skipped: true } : {}),
    ...(answeredByRef !== undefined ? { answeredByRef } : {}),
  };
}

/**
 * Settle a reply against the request it answers: fill every unanswered question from its own
 * `defaults`, drop submitted values that aren't on offer, and collapse a single-choice question to
 * one value.
 *
 * PURE, and deliberately so. Both of its inputs are already journaled by the time the loop calls it
 * — the request came from module config or from an `llm:<i>` checkpoint, the reply from the signal
 * checkpoint — so every process replaying the turn reaches the same values without a checkpoint of
 * its own. Resolving defaults in the HTTP layer instead would put them behind a store read that a
 * replay would have to repeat.
 */
export function resolveElicitation(args: {
  request: ElicitationRequest;
  reply: HumanReply;
}): ElicitationOutcome {
  const { request } = args;
  const reply = normalizeElicitationReply(args.reply);
  const answers: Record<string, string[]> = {};
  const defaulted: string[] = [];
  for (const question of request.questions) {
    const submitted = reply.skipped === true ? undefined : reply.answers[question.id];
    if (submitted === undefined) {
      answers[question.id] = [...(question.defaults ?? [])];
      defaulted.push(question.id);
      continue;
    }
    const allowed = optionValues(question);
    const valid =
      question.allowFreeText === true ? submitted : submitted.filter((value) => allowed.has(value));
    answers[question.id] = question.multiple === true ? valid : valid.slice(0, 1);
  }
  return { answers, skipped: reply.skipped === true, defaulted };
}

/**
 * What a settled elicitation looks like to everyone downstream: the model reading it back as a tool
 * result, the thread reader rendering it, the auditor asking what the agent was told to do. One
 * shape for both surfaces — nothing here records which of them asked.
 */
export interface ElicitationResult extends ElicitationOutcome {
  /** The questions against the chosen LABELS, so a reader (and a model) can act on it. */
  summary: string;
}

/** {@link resolveElicitation} plus its human-readable rendering. Pure, for the same reason. */
export function settleElicitation(args: {
  request: ElicitationRequest;
  reply: HumanReply;
}): ElicitationResult {
  const outcome = resolveElicitation(args);
  return { ...outcome, summary: renderElicitationAnswers({ request: args.request, outcome }) };
}

/**
 * The answers as the model reads them: the question's own prompt against the chosen options' LABELS,
 * not their opaque `value`s — a model shown `{"scope":["b"]}` has been told nothing.
 */
export function renderElicitationAnswers(args: {
  request: ElicitationRequest;
  outcome: ElicitationOutcome;
}): string {
  const { request, outcome } = args;
  const lines = request.questions.map((question) => {
    const chosen = outcome.answers[question.id] ?? [];
    const labels = chosen.map(
      (value) => question.options.find((option) => option.value === value)?.label ?? value,
    );
    return `${question.prompt} → ${labels.length > 0 ? labels.join(', ') : '(no answer)'}`;
  });
  const preface = outcome.skipped
    ? 'The user declined to answer and asked you to proceed on these assumptions:'
    : 'The user answered:';
  return `${preface}\n${lines.join('\n')}`;
}

/** The reserved tool name the model calls to ask the user something. */
export const ASK_TOOL_NAME = 'ask';

/** What the model must supply when it calls `ask`. */
export interface AskToolInput {
  preamble?: string;
  questions: ElicitationQuestion[];
}

/** How many questions one `ask` may carry. A form the user has to scroll is a form they skip. */
export const MAX_ASK_QUESTIONS = 5;

function issue(path: (string | number)[], message: string): StandardSchemaV1.Issue {
  return { message, path };
}

function parseOption(
  raw: unknown,
  path: (string | number)[],
  issues: StandardSchemaV1.Issue[],
): ElicitationOption | undefined {
  if (typeof raw !== 'object' || raw === null) {
    issues.push(issue(path, 'must be an object'));
    return undefined;
  }
  const candidate = raw as Partial<ElicitationOption>;
  if (typeof candidate.value !== 'string' || candidate.value.length === 0) {
    issues.push(issue([...path, 'value'], 'must be a non-empty string'));
    return undefined;
  }
  if (typeof candidate.label !== 'string' || candidate.label.length === 0) {
    issues.push(issue([...path, 'label'], 'must be a non-empty string'));
    return undefined;
  }
  return {
    value: candidate.value,
    label: candidate.label,
    ...(typeof candidate.hotkey === 'string' ? { hotkey: candidate.hotkey } : {}),
  };
}

function parseQuestion(
  raw: unknown,
  path: (string | number)[],
  issues: StandardSchemaV1.Issue[],
): ElicitationQuestion | undefined {
  if (typeof raw !== 'object' || raw === null) {
    issues.push(issue(path, 'must be an object'));
    return undefined;
  }
  const candidate = raw as Partial<ElicitationQuestion>;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    issues.push(issue([...path, 'id'], 'must be a non-empty string'));
    return undefined;
  }
  if (typeof candidate.prompt !== 'string' || candidate.prompt.length === 0) {
    issues.push(issue([...path, 'prompt'], 'must be a non-empty string'));
    return undefined;
  }
  if (!Array.isArray(candidate.options) || candidate.options.length === 0) {
    issues.push(issue([...path, 'options'], 'must be a non-empty array'));
    return undefined;
  }
  const options: ElicitationOption[] = [];
  for (const [index, rawOption] of candidate.options.entries()) {
    const option = parseOption(rawOption, [...path, 'options', index], issues);
    if (option !== undefined) {
      options.push(option);
    }
  }
  // The one rule that carries the design: a question with no pre-picked answer is a question the
  // user has to stop and think about, and this surface exists to avoid that.
  if (!Array.isArray(candidate.defaults) || candidate.defaults.length === 0) {
    issues.push(
      issue(
        [...path, 'defaults'],
        'must pre-pick at least one option — say what you would choose so the user can just confirm',
      ),
    );
    return undefined;
  }
  const offered = new Set(options.map((option) => option.value));
  const defaults = candidate.defaults.filter(
    (value): value is string => typeof value === 'string' && offered.has(value),
  );
  if (defaults.length === 0) {
    issues.push(
      issue([...path, 'defaults'], "must name values that appear in this question's options"),
    );
    return undefined;
  }
  return {
    id: candidate.id,
    prompt: candidate.prompt,
    options,
    defaults,
    ...(candidate.multiple === true ? { multiple: true } : {}),
    ...(candidate.allowFreeText === true ? { allowFreeText: true } : {}),
  };
}

const ASK_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    preamble: {
      type: 'string',
      description:
        'One sentence shown above the form, e.g. "Three questions before I start. I have pre-picked what I would choose, so confirming is enough."',
    },
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_ASK_QUESTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'prompt', 'options', 'defaults'],
        properties: {
          id: {
            type: 'string',
            description: 'Unique within this call; answers come back under it.',
          },
          prompt: { type: 'string' },
          multiple: { type: 'boolean', description: 'Allow more than one option to be chosen.' },
          allowFreeText: {
            type: 'boolean',
            description: 'Accept an answer that is not an option.',
          },
          defaults: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
            description:
              'REQUIRED. The option values you would pick yourself, so the user can confirm rather than decide.',
          },
          options: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['value', 'label'],
              properties: {
                value: { type: 'string' },
                label: { type: 'string' },
                hotkey: { type: 'string', maxLength: 1 },
              },
            },
          },
        },
      },
    },
  },
  required: ['questions'],
} as const;

/**
 * The `ask` tool's input schema, hand-written rather than borrowed from a validation library: core
 * depends on no validator, and the schema has to carry a JSON Schema a provider can constrain
 * generation against. It publishes one through the Standard JSON Schema extension
 * (`~standard.jsonSchema.input`), which is the path the AI SDK adapter already recognises for
 * Valibot / ArkType / Zod 4.
 */
export const askInputSchema: StandardSchemaV1<unknown, AskToolInput> = {
  '~standard': {
    version: 1,
    vendor: 'adonis-agora-agent',
    validate: (value: unknown) => {
      const issues: StandardSchemaV1.Issue[] = [];
      if (typeof value !== 'object' || value === null) {
        return { issues: [issue([], 'must be an object')] };
      }
      const candidate = value as Partial<AskToolInput>;
      if (!Array.isArray(candidate.questions) || candidate.questions.length === 0) {
        return { issues: [issue(['questions'], 'must be a non-empty array')] };
      }
      if (candidate.questions.length > MAX_ASK_QUESTIONS) {
        return {
          issues: [issue(['questions'], `must hold at most ${MAX_ASK_QUESTIONS} questions`)],
        };
      }
      const questions: ElicitationQuestion[] = [];
      for (const [index, raw] of candidate.questions.entries()) {
        const question = parseQuestion(raw, ['questions', index], issues);
        if (question !== undefined) {
          questions.push(question);
        }
      }
      if (issues.length > 0) {
        return { issues };
      }
      return {
        value: {
          questions,
          ...(typeof candidate.preamble === 'string' ? { preamble: candidate.preamble } : {}),
        },
      };
    },
    jsonSchema: { input: () => ASK_JSON_SCHEMA },
  },
} as StandardSchemaV1<unknown, AskToolInput>;

/**
 * What the model is told the `ask` tool is for. Written to discourage the two failure modes that
 * make a clarifying question worse than a guess: asking about something the conversation already
 * settled, and asking without saying what you would have done.
 */
export const ASK_TOOL_DESCRIPTION =
  'Ask the user to settle the scope of the work before you do it. Use it when a reasonable person would produce a materially different result depending on the answer — not to confirm something the conversation already says. Every question must pre-pick the answer you would choose, so the user can confirm instead of deciding. The user may decline, in which case you proceed on those pre-picked answers.';

/**
 * The `ask` tool as the model sees it. NOT a `ToolSpec` and never registered: `ask` has no handler,
 * because the loop settles it against a human instead of invoking anything. Keeping it out of the
 * `ToolRegistry` is also what keeps the kind decision off a process-local lookup — see
 * `claimToolCall`.
 */
export function askToolDefinition(): ToolDefinition {
  return {
    name: ASK_TOOL_NAME,
    kind: 'ask',
    description: ASK_TOOL_DESCRIPTION,
    inputSchema: askInputSchema,
  };
}

/** A question set an `@Agent` asks before it starts working. See `AgentLoopDeps.intake`. */
export interface AgentIntake {
  questions: ElicitationQuestion[];
  /** What the assistant says above the form. Omit → {@link DEFAULT_INTAKE_PREAMBLE}. */
  preamble?: string;
  /**
   * `'thread-start'` (default) asks once, on the first turn of a thread; `'every-turn'` asks before
   * every turn. Both are decided from what `load:thread` recorded about the thread when the turn
   * began, never from anything this process happens to know — by the time a replay reaches the
   * question, the thread already holds the assistant message the first attempt wrote.
   */
  when?: 'thread-start' | 'every-turn';
}

export const DEFAULT_INTAKE_PREAMBLE =
  'A few questions before I start. I have pre-picked what I would choose, so confirming is enough.';
