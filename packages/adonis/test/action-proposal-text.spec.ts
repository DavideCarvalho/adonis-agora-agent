import { describe, expect, it } from 'vitest';
import { resolveTextActionProposalDecision } from '../src/action-proposal-text.js';

const pending = [{ id: 'send-123', decision: 'pending' as const }];

describe('text action proposal decisions', () => {
  it('accepts an exact affirmative only for one pending proposal', () => {
    expect(resolveTextActionProposalDecision('Sim!', pending)).toEqual({
      status: 'decision',
      proposalId: 'send-123',
      decision: 'approved',
      remember: false,
    });
  });
  it('requires a choice when the text could address multiple proposals', () => {
    expect(
      resolveTextActionProposalDecision('confirmo', [
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
    expect(resolveTextActionProposalDecision('aprovar #Case_ID', rows)).toEqual({
      status: 'decision',
      proposalId: 'Case_ID',
      decision: 'approved',
      remember: false,
    });
    expect(resolveTextActionProposalDecision('aprovar #case_id', rows)).toEqual({
      status: 'unmatched',
    });
  });
  it('supports remembering a tool for this conversation as an explicit decision', () => {
    expect(
      resolveTextActionProposalDecision('aprovar sempre nesta conversa #send-123', pending),
    ).toEqual({
      status: 'decision',
      proposalId: 'send-123',
      decision: 'approved',
      remember: true,
    });
  });
  it('supports explicit rejection, preserving ambiguity rules', () => {
    expect(resolveTextActionProposalDecision('cancelar #send-123', pending)).toEqual({
      status: 'decision',
      proposalId: 'send-123',
      decision: 'rejected',
      remember: false,
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
    expect(resolveTextActionProposalDecision(text, pending)).toEqual({ status: 'unmatched' });
  });
  it('excludes settled and superseded proposals from candidate selection', () => {
    expect(
      resolveTextActionProposalDecision('sim', [{ id: 'old', decision: 'superseded' }, ...pending]),
    ).toMatchObject({ proposalId: 'send-123' });
    expect(resolveTextActionProposalDecision('sim', [{ id: 'old', decision: 'approved' }])).toEqual(
      { status: 'unmatched' },
    );
  });
  it('does not execute effects or grant authority: resolution only selects a candidate', () => {
    const candidate = Object.freeze({ id: 'send-123', decision: 'pending' as const });
    expect(
      resolveTextActionProposalDecision('Confirmar #send-123.', Object.freeze([candidate])),
    ).toMatchObject({ status: 'decision' });
    expect(candidate).toEqual({ id: 'send-123', decision: 'pending' });
  });
});
