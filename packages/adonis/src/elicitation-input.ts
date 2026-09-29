/**
 * Typed answers for a question set: a question that asks for a number, a date, an email or a
 * sentence instead of offering options to pick.
 *
 * Answers stay `string[]` on the wire whatever the type — the signal that carries them, the row that
 * records them and the model that reads them back all see strings — so this module fixes ONE
 * canonical string per type and validates against it:
 *
 * | `type`     | canonical value                              |
 * |------------|----------------------------------------------|
 * | `text`     | the text                                      |
 * | `textarea` | the text (newlines kept)                      |
 * | `number`   | a finite decimal, e.g. `"42"`, `"-1.5"`       |
 * | `boolean`  | `"true"` or `"false"`                         |
 * | `date`     | `YYYY-MM-DD`                                  |
 * | `email`    | an address with one `@` and a dotted domain   |
 * | `url`      | an absolute `http:`/`https:` URL              |
 * | `select`   | one of the question's `options[].value`       |
 *
 * Pure and dependency-free, so the loop (which filters what it settles on), the HTTP surface (which
 * refuses what it cannot settle) and a client (which says so before sending) all agree.
 */
import type { ElicitationOption, ElicitationQuestion } from './elicitation.js';

export const ELICITATION_INPUT_TYPES = [
  'text',
  'textarea',
  'number',
  'boolean',
  'date',
  'email',
  'url',
  'select',
] as const;

export type ElicitationInputType = (typeof ELICITATION_INPUT_TYPES)[number];

/** How a question takes its answer when it is not (only) a pick from `options`. */
export interface ElicitationInput {
  type: ElicitationInputType;
  /** Hint shown in an empty field. Advisory. */
  placeholder?: string;
  /** Submitting without a value is refused. Skipping the whole set is still allowed. */
  required?: boolean;
  /**
   * Lower bound: the smallest number for `number`, the shortest length for `text`/`textarea`, the
   * earliest `YYYY-MM-DD` for `date`. Ignored for the other types.
   */
  min?: number | string;
  /** Upper bound, read like {@link min}. */
  max?: number | string;
  /** A regular expression the WHOLE value must match (`text`, `textarea`, `email`, `url`). */
  pattern?: string;
}

/** The question's options, or none — `options` may be omitted on a typed question. */
export function questionOptions(question: ElicitationQuestion): ElicitationOption[] {
  return question.options ?? [];
}

/** A question answered by a typed value rather than by picking one of its options. */
export function isTypedQuestion(question: ElicitationQuestion): boolean {
  return question.input !== undefined && question.input.type !== 'select';
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUMBER_PATTERN = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

function isDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function fullMatch(pattern: string, value: string): boolean | undefined {
  try {
    return new RegExp(`^(?:${pattern})$`, 'u').test(value);
  } catch {
    // An author's unreadable pattern constrains nothing rather than refusing every answer.
    return undefined;
  }
}

function asNumber(bound: number | string | undefined): number | undefined {
  if (typeof bound === 'number' && Number.isFinite(bound)) {
    return bound;
  }
  if (typeof bound === 'string' && NUMBER_PATTERN.test(bound.trim())) {
    return Number(bound);
  }
  return undefined;
}

/**
 * Why `value` is not an acceptable answer to `question`, or `null` when it is. Checks ONE value;
 * {@link validateElicitationAnswer} checks the list (required, single choice).
 */
export function validateElicitationValue(
  question: ElicitationQuestion,
  value: string,
): string | null {
  const input = question.input;
  if (input === undefined || input.type === 'select') {
    if (question.allowFreeText === true) {
      return null;
    }
    return questionOptions(question).some((option) => option.value === value)
      ? null
      : 'must be one of the offered options';
  }
  switch (input.type) {
    case 'number': {
      if (!NUMBER_PATTERN.test(value.trim()) || !Number.isFinite(Number(value))) {
        return 'must be a number';
      }
      const number = Number(value);
      const min = asNumber(input.min);
      const max = asNumber(input.max);
      if (min !== undefined && number < min) {
        return `must be at least ${min}`;
      }
      if (max !== undefined && number > max) {
        return `must be at most ${max}`;
      }
      return null;
    }
    case 'boolean':
      return value === 'true' || value === 'false' ? null : 'must be "true" or "false"';
    case 'date': {
      if (!isDate(value)) {
        return 'must be a date as YYYY-MM-DD';
      }
      if (typeof input.min === 'string' && isDate(input.min) && value < input.min) {
        return `must be on or after ${input.min}`;
      }
      if (typeof input.max === 'string' && isDate(input.max) && value > input.max) {
        return `must be on or before ${input.max}`;
      }
      return null;
    }
    case 'email':
      if (!EMAIL_PATTERN.test(value)) {
        return 'must be an email address';
      }
      break;
    case 'url':
      if (!isHttpUrl(value)) {
        return 'must be an http(s) URL';
      }
      break;
    case 'text':
    case 'textarea': {
      const min = asNumber(input.min);
      const max = asNumber(input.max);
      if (min !== undefined && value.length < min) {
        return `must be at least ${min} characters`;
      }
      if (max !== undefined && value.length > max) {
        return `must be at most ${max} characters`;
      }
      break;
    }
  }
  if (input.pattern !== undefined && fullMatch(input.pattern, value) === false) {
    return 'does not match the expected format';
  }
  return null;
}

/**
 * Why `values` is not an acceptable answer to `question`, or `null` when it is: a `required`
 * question left empty, more than one value for a single-choice question, or any value
 * {@link validateElicitationValue} refuses. An empty string counts as no value.
 */
export function validateElicitationAnswer(
  question: ElicitationQuestion,
  values: readonly string[],
): string | null {
  const present = values.filter((value) => value !== '');
  if (present.length === 0) {
    return question.input?.required === true ? 'requires an answer' : null;
  }
  if (question.multiple !== true && present.length > 1) {
    return 'takes a single value';
  }
  for (const value of present) {
    const problem = validateElicitationValue(question, value);
    if (problem !== null) {
      return problem;
    }
  }
  return null;
}

/**
 * Read an {@link ElicitationInput} from untrusted JSON, or `undefined` when it is not one. Unknown
 * keys are dropped; a malformed optional field is dropped rather than failing the input.
 */
export function readElicitationInput(raw: unknown): ElicitationInput | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const candidate = raw as Record<string, unknown>;
  const type = candidate.type;
  if (typeof type !== 'string' || !(ELICITATION_INPUT_TYPES as readonly string[]).includes(type)) {
    return undefined;
  }
  const bound = (value: unknown) =>
    (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string'
      ? (value as number | string)
      : undefined;
  const min = bound(candidate.min);
  const max = bound(candidate.max);
  return {
    type: type as ElicitationInputType,
    ...(typeof candidate.placeholder === 'string' ? { placeholder: candidate.placeholder } : {}),
    ...(candidate.required === true ? { required: true } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(typeof candidate.pattern === 'string' ? { pattern: candidate.pattern } : {}),
  };
}

/**
 * The questions a parked call carries, read leniently from its recorded input (`{ questions }` —
 * what both an intake and an `ask` persist). Used where a reply is checked against the questions it
 * answers; a question that cannot be read is left out rather than failing the rest.
 */
export function readElicitationQuestions(input: unknown): ElicitationQuestion[] {
  if (typeof input !== 'object' || input === null) {
    return [];
  }
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) {
    return [];
  }
  const questions: ElicitationQuestion[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.id !== 'string' || typeof candidate.prompt !== 'string') {
      continue;
    }
    const options: ElicitationOption[] = Array.isArray(candidate.options)
      ? candidate.options.flatMap((option: unknown) => {
          if (typeof option !== 'object' || option === null) {
            return [];
          }
          const { value, label } = option as Record<string, unknown>;
          return typeof value === 'string' && typeof label === 'string' ? [{ value, label }] : [];
        })
      : [];
    const typed = readElicitationInput(candidate.input);
    const defaults = Array.isArray(candidate.defaults)
      ? candidate.defaults.filter((value): value is string => typeof value === 'string')
      : [];
    questions.push({
      id: candidate.id,
      prompt: candidate.prompt,
      options,
      ...(typed !== undefined ? { input: typed } : {}),
      ...(defaults.length > 0 ? { defaults } : {}),
      ...(candidate.multiple === true ? { multiple: true } : {}),
      ...(candidate.allowFreeText === true ? { allowFreeText: true } : {}),
    });
  }
  return questions;
}
