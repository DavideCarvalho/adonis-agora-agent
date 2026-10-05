import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { coerceAnswer, validateAnswer } from '../../../src/react/core/elicitation/answers.js';
import {
  type AnyToolUIPart,
  buildTranscriptBlocks,
  type TranscriptElicitationBlock,
} from '../../../src/react/core/transcript/model.js';

describe('coerceAnswer — the canonical strings the answer route takes', () => {
  it.each([
    [{ input: { type: 'number' as const } }, 42, ['42']],
    [{ input: { type: 'number' as const } }, ' 7 ', ['7']],
    [{ input: { type: 'number' as const } }, Number.NaN, []],
    [{ input: { type: 'boolean' as const } }, true, ['true']],
    [{ input: { type: 'boolean' as const } }, 'on', ['true']],
    [{ input: { type: 'boolean' as const } }, false, ['false']],
    [{ input: { type: 'date' as const } }, new Date(2026, 9, 1, 23, 30), ['2026-10-01']],
    [{ input: { type: 'date' as const } }, '2026-10-01', ['2026-10-01']],
    [{ input: { type: 'text' as const } }, '  keep spaces ', ['  keep spaces ']],
    [{ input: { type: 'email' as const } }, ' a@b.co ', ['a@b.co']],
    [{ input: { type: 'text' as const } }, '', []],
    [{ input: { type: 'text' as const } }, null, []],
    [{ input: { type: 'text' as const } }, ['a', 'b'], ['a']],
    [{ multiple: true, input: { type: 'text' as const } }, ['a', '', 'b'], ['a', 'b']],
    [{}, 'opt', ['opt']],
  ])('%j with %j → %j', (question, raw, expected) => {
    expect(coerceAnswer(question, raw)).toEqual(expected);
  });

  it('validates with the server’s own rules', () => {
    const question = { id: 'n', prompt: 'N?', input: { type: 'number' as const, max: 3 } };
    expect(validateAnswer(question, coerceAnswer(question, 4))).toBe('must be at most 3');
    expect(validateAnswer(question, coerceAnswer(question, 2))).toBeNull();
  });
});

function askPart(questions: unknown[]): AnyToolUIPart {
  return {
    type: 'tool-ask',
    toolCallId: 'ask-1',
    state: 'input-available',
    input: { questions },
  } as AnyToolUIPart;
}

function elicitation(
  questions: unknown[],
  picked: Record<string, string[]> = {},
  pick = vi.fn(),
): TranscriptElicitationBlock {
  const message: UIMessage = { id: 'm1', role: 'assistant', parts: [askPart(questions)] };
  const block = buildTranscriptBlocks(message, {
    isReasoningOpen: () => false,
    toggleReasoning: () => undefined,
    elicitation: {
      picked: (_id, questionId) => picked[questionId],
      pick,
      canAnswer: true,
      canSkip: true,
      answer: () => undefined,
      skip: () => undefined,
      submitting: () => null,
      errorOf: () => null,
    },
  }).find((candidate) => candidate.kind === 'elicitation');
  if (block?.kind !== 'elicitation') throw new Error('no elicitation block');
  return block;
}

describe('typed questions in the transcript', () => {
  const questions = [
    {
      id: 'seats',
      prompt: 'How many seats?',
      description: 'One to nine.',
      input: { type: 'number', min: 1, max: 9, required: true, placeholder: 'e.g. 2' },
    },
    { id: 'when', prompt: 'When?', input: { type: 'date' }, defaults: ['2026-10-01'] },
  ];

  it('lifts a question set with no options into a form, carrying description and input', () => {
    const block = elicitation(questions);
    const [seats, when] = block.questions;
    expect(seats).toMatchObject({
      id: 'seats',
      description: 'One to nine.',
      input: { type: 'number', min: 1, max: 9, required: true, placeholder: 'e.g. 2' },
      options: [],
      value: '',
      error: 'requires an answer',
    });
    expect(when).toMatchObject({ value: '2026-10-01', error: null, isPristine: true });
    expect(block.isValid).toBe(false);
  });

  it('coerces what the control produced into the pick, and reports what the server would refuse', () => {
    const pick = vi.fn();
    const invalid = elicitation(questions, { seats: ['12'] }, pick);
    expect(invalid.questions[0]?.error).toBe('must be at most 9');

    invalid.questions[0]?.setValue(3);
    invalid.questions[1]?.setValue(new Date(2026, 11, 24));
    expect(pick.mock.calls).toEqual([
      ['ask-1', 'seats', ['3']],
      ['ask-1', 'when', ['2026-12-24']],
    ]);

    expect(elicitation(questions, { seats: ['3'] }).isValid).toBe(true);
  });
});
