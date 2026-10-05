import type { ElicitationInputType, ElicitationQuestion } from '../../../index.js';

export {
  type ElicitationInput,
  type ElicitationInputType,
  validateElicitationAnswer as validateAnswer,
  validateElicitationValue as validateAnswerValue,
} from '../../../elicitation-input.js';

/** What a form control can hand over: a field's value, a checkbox's state, a picked date, a list. */
export type RawAnswer = string | number | boolean | Date | null | undefined | readonly RawAnswer[];

/** The question fields {@link coerceAnswer} reads. A transcript question and a core one both fit. */
export type CoercibleQuestion = Pick<ElicitationQuestion, 'multiple'> & {
  input?: { type: ElicitationInputType } | null;
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** A `Date` as the calendar day the person picked — local time, which is the day they saw. */
function toDay(date: Date): string | null {
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function coerceOne(type: ElicitationInputType | undefined, raw: RawAnswer): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (Array.isArray(raw)) {
    return null;
  }
  if (raw instanceof Date) {
    return type === 'date' || type === undefined ? toDay(raw) : raw.toISOString();
  }
  if (typeof raw === 'boolean') {
    return raw ? 'true' : 'false';
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? String(raw) : null;
  }
  const text = raw as string;
  switch (type) {
    case 'number':
    case 'email':
    case 'url':
    case 'date':
      return text.trim() === '' ? null : text.trim();
    case 'boolean': {
      const lowered = text.trim().toLowerCase();
      if (lowered === 'true' || lowered === 'on' || lowered === 'yes') return 'true';
      if (lowered === 'false' || lowered === 'off' || lowered === 'no') return 'false';
      return lowered === '' ? null : text;
    }
    default:
      return text === '' ? null : text;
  }
}

/**
 * Turn whatever a form control produced into the `string[]` the answer route takes, in the
 * question's canonical form: numbers as decimals, booleans as `"true"`/`"false"`, dates as
 * `YYYY-MM-DD` (a `Date` is read as the local calendar day), trimmed where whitespace means
 * nothing. An empty value becomes `[]` — no answer, not an empty string. A single-choice question
 * keeps the first value.
 *
 * Coercion never judges: pair it with {@link validateAnswer} (the same rules the server applies) to
 * say what is wrong before sending.
 */
export function coerceAnswer(question: CoercibleQuestion, raw: RawAnswer): string[] {
  const type = question.input?.type;
  const items: readonly RawAnswer[] = Array.isArray(raw) ? raw : [raw];
  const values = items
    .map((item) => coerceOne(type, item))
    .filter((value): value is string => value !== null);
  return question.multiple === true ? values : values.slice(0, 1);
}
