import type { ElicitationQuestion } from '../elicitation.js';
import {
  isTypedQuestion,
  questionOptions,
  validateElicitationAnswer,
  validateElicitationValue,
} from '../elicitation-input.js';

/** How a text channel words a question. English defaults; override any (`texts.questions`). */
export interface ChannelQuestionTexts {
  /** Above the first question of a set with more than one: `(1/3)`. */
  counter(index: number, total: number): string;
  /** Under single-choice options. */
  pickOne: string;
  /** Under multiple-choice options. */
  pickMany: string;
  /** Under options a typed answer may replace. */
  orWrite: string;
  /** The word that keeps a question's pre-picked answers (or leaves it unanswered). */
  skipWord: string;
  /** How to keep the pre-picked answers, shown when a question has some. */
  keep(skipWord: string, labels: string): string;
  /** The answer could not be read; the question follows. */
  invalid(problem: string): string;
}

export const DEFAULT_CHANNEL_QUESTION_TEXTS: ChannelQuestionTexts = {
  counter: (index, total) => `(${index + 1}/${total})`,
  pickOne: 'Reply with the number of your choice.',
  pickMany: 'Reply with one or more numbers, separated by commas.',
  orWrite: 'Or write your own answer.',
  skipWord: 'skip',
  keep: (skipWord, labels) => `Reply *${skipWord}* to keep: ${labels}.`,
  invalid: (problem) => `I could not read that answer (${problem}).`,
};

const labelOf = (question: ElicitationQuestion, value: string) =>
  questionOptions(question).find((option) => option.value === value)?.label ?? value;

/** One question as a text message: its prompt, numbered options, and how to answer. */
export function formatChannelQuestion(
  question: ElicitationQuestion,
  position: { index: number; total: number; preamble?: string },
  texts: ChannelQuestionTexts = DEFAULT_CHANNEL_QUESTION_TEXTS,
): string {
  const lines: string[] = [];
  if (position.index === 0 && position.preamble) lines.push(position.preamble, '');
  const counter = position.total > 1 ? `${texts.counter(position.index, position.total)} ` : '';
  lines.push(`*${counter}${question.prompt}*`);
  if (question.description) lines.push(question.description);
  const options = isTypedQuestion(question) ? [] : questionOptions(question);
  if (options.length > 0) {
    lines.push('');
    for (const [index, option] of options.entries()) lines.push(`${index + 1}. ${option.label}`);
    lines.push('', question.multiple === true ? texts.pickMany : texts.pickOne);
    if (question.allowFreeText === true) lines.push(texts.orWrite);
  }
  const defaults = question.defaults ?? [];
  if (defaults.length > 0) {
    lines.push(
      texts.keep(texts.skipWord, defaults.map((value) => labelOf(question, value)).join(', ')),
    );
  }
  return lines.join('\n');
}

export type ChannelAnswer =
  | { status: 'answer'; values: string[] }
  /** Keep the question's defaults: its id is left out of the reply. */
  | { status: 'skip' }
  | { status: 'invalid'; problem: string };

const fold = (value: string) => value.trim().toLowerCase();

/**
 * Read a chat message as the answer to `question`: an option's number or label (several, separated
 * by commas, for a multiple choice), a typed value for a typed question or one that allows free
 * text, or the skip word. Checked against the question's own rules.
 */
export function parseChannelAnswer(
  question: ElicitationQuestion,
  text: string,
  skipWord: string = DEFAULT_CHANNEL_QUESTION_TEXTS.skipWord,
): ChannelAnswer {
  const answer = text.trim();
  if (fold(answer) === fold(skipWord)) return { status: 'skip' };
  if (answer === '') return { status: 'invalid', problem: 'empty answer' };
  let values: string[];
  if (isTypedQuestion(question)) {
    values = [answer];
  } else {
    const options = questionOptions(question);
    const pick = (token: string): string | null => {
      const bare = token.trim().replace(/[.)]$/, '');
      if (/^\d+$/.test(bare)) {
        const option = options[Number(bare) - 1];
        if (option) return option.value;
      }
      const match = options.find(
        (option) => fold(option.label) === fold(token) || fold(option.value) === fold(token),
      );
      return match?.value ?? null;
    };
    const whole = pick(answer);
    if (whole !== null) values = [whole];
    else if (question.multiple === true) {
      const tokens = answer.split(/\s*[,;]\s*|\s+/).filter((token) => token !== '');
      const picked = tokens.map(pick);
      if (picked.every((value): value is string => value !== null)) values = [...new Set(picked)];
      else if (question.allowFreeText === true) values = [answer];
      else return { status: 'invalid', problem: 'not one of the options' };
    } else if (question.allowFreeText === true || options.length === 0) values = [answer];
    else return { status: 'invalid', problem: 'not one of the options' };
  }
  for (const value of values) {
    const problem = validateElicitationValue(question, value);
    if (problem !== null) return { status: 'invalid', problem };
  }
  const problem = validateElicitationAnswer(question, values);
  return problem === null ? { status: 'answer', values } : { status: 'invalid', problem };
}
