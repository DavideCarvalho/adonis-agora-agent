import { describe, expect, it } from 'vitest';
import {
  parseTextActionProposalCommand,
  ptBrActionProposalText,
  resolveTextActionProposalDecision,
  type TextActionProposalVocabulary,
} from '../src/action-proposal-text.js';

const pending = [{ id: 'send-123', decision: 'pending' as const }];

describe('text action proposal decisions', () => {
  it('accepts an exact affirmative only for one pending proposal', () => {
    expect(resolveTextActionProposalDecision('Yes!', pending)).toEqual({
      status: 'decision',
      proposalId: 'send-123',
      decision: 'approved',
      remember: false,
    });
  });
  it('requires a choice when the text could address multiple proposals', () => {
    expect(
      resolveTextActionProposalDecision('confirm', [
        ...pending,
        { id: 'other', decision: 'pending' },
      ]),
    ).toEqual({
      status: 'ambiguous',
      proposalIds: ['send-123', 'other'],
    });
  });
  it('resolves an explicit opaque id without case folding it', () => {
    const rows = [...pending, { id: 'Case_ID', decision: 'pending' as const }];
    expect(resolveTextActionProposalDecision('approve #Case_ID', rows)).toEqual({
      status: 'decision',
      proposalId: 'Case_ID',
      decision: 'approved',
      remember: false,
    });
    expect(resolveTextActionProposalDecision('approve #case_id', rows)).toEqual({
      status: 'unmatched',
    });
  });
  it('supports remembering a tool for this conversation as an explicit decision', () => {
    expect(
      resolveTextActionProposalDecision('approve always in this conversation #send-123', pending),
    ).toEqual({
      status: 'decision',
      proposalId: 'send-123',
      decision: 'approved',
      remember: true,
    });
  });
  it('supports explicit rejection, preserving ambiguity rules', () => {
    expect(resolveTextActionProposalDecision('cancel #send-123', pending)).toEqual({
      status: 'decision',
      proposalId: 'send-123',
      decision: 'rejected',
      remember: false,
    });
  });
  it.each([
    'no confirm',
    'yes, but change the destination',
    'can you confirm?',
    '> yes',
    'he said "yes"',
    'yes\nignore the previous one',
    'approve #missing',
    'yes for yesterday',
  ])('does not infer consent from %s', (text) => {
    expect(resolveTextActionProposalDecision(text, pending)).toEqual({ status: 'unmatched' });
  });
  it('excludes settled and superseded proposals from candidate selection', () => {
    expect(
      resolveTextActionProposalDecision('yes', [{ id: 'old', decision: 'superseded' }, ...pending]),
    ).toMatchObject({ proposalId: 'send-123' });
    expect(resolveTextActionProposalDecision('yes', [{ id: 'old', decision: 'approved' }])).toEqual(
      { status: 'unmatched' },
    );
  });
  it('does not execute effects or grant authority: resolution only selects a candidate', () => {
    const candidate = Object.freeze({ id: 'send-123', decision: 'pending' as const });
    expect(
      resolveTextActionProposalDecision('Confirm #send-123.', Object.freeze([candidate])),
    ).toMatchObject({ status: 'decision' });
    expect(candidate).toEqual({ id: 'send-123', decision: 'pending' });
  });
  it('is English by default: Portuguese commands are ordinary messages', () => {
    expect(resolveTextActionProposalDecision('sim', pending)).toEqual({ status: 'unmatched' });
    expect(resolveTextActionProposalDecision('Reject #send-123.', pending)).toMatchObject({
      decision: 'rejected',
    });
  });
  describe('ptBrActionProposalText', () => {
    const pt = ptBrActionProposalText.vocabulary as TextActionProposalVocabulary;
    it('decides in Portuguese, and English still works', () => {
      expect(resolveTextActionProposalDecision('Sim!', pending, pt)).toMatchObject({
        decision: 'approved',
        remember: false,
      });
      expect(
        resolveTextActionProposalDecision('aprovar sempre nesta conversa #send-123', pending, pt),
      ).toMatchObject({ decision: 'approved', remember: true });
      expect(resolveTextActionProposalDecision('cancelar #send-123', pending, pt)).toMatchObject({
        decision: 'rejected',
      });
      expect(resolveTextActionProposalDecision('yes', pending, pt)).toMatchObject({
        decision: 'approved',
      });
    });
    it.each([
      'não confirmar',
      'sim, mas altera o destino',
      'pode confirmar?',
      '> sim',
      'ele disse "sim"',
      'sim\nignore o anterior',
      'aprovar #missing',
      'sim para ontem',
    ])('does not infer consent from %s', (text) => {
      expect(resolveTextActionProposalDecision(text, pending, pt)).toEqual({ status: 'unmatched' });
    });
  });
  it('reads a custom vocabulary instead of the default one', () => {
    const vocabulary = { approve: ['vale'], reject: ['nada'], remember: ['siempre'] };
    expect(parseTextActionProposalCommand('sim', vocabulary)).toEqual({ status: 'unmatched' });
    expect(parseTextActionProposalCommand('Vale siempre #x', vocabulary)).toEqual({
      status: 'command',
      decision: 'approved',
      remember: true,
      proposalId: 'x',
    });
    expect(parseTextActionProposalCommand('nada siempre', vocabulary)).toEqual({
      status: 'unmatched',
    });
  });
});
