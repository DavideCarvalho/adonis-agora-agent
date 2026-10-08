import { describe, expect, it } from 'vitest';
import { actionProposalOutcomeText } from '../src/action-proposal-outcome.js';
import type { ActionProposalOutcome } from '../src/spi/action-proposal-outcome-store.js';

const outcome = (extra: Partial<ActionProposalOutcome>): ActionProposalOutcome => ({
  id: 'proposal-5d5c:outcome:1',
  proposalId: 'proposal-5d5c',
  outcomeVersion: 1,
  tenantRef: 't',
  actorRef: 'a',
  threadId: 'thread-1',
  originRunId: 'run-1',
  originToolCallId: 'call-1',
  toolName: 'registrar_mamada',
  decision: 'approved',
  ui: [],
  createdAt: 0,
  ...extra,
});

describe('actionProposalOutcomeText', () => {
  it('summarizes without the proposal id, the result kept for the model', () => {
    expect(
      actionProposalOutcomeText(
        outcome({ executionStatus: 'succeeded', result: { mamada: { fim: '10:00' } } }),
      ),
    ).toBe('Action "registrar_mamada" completed. Result: {"mamada":{"fim":"10:00"}}');
    expect(actionProposalOutcomeText(outcome({ executionStatus: 'failed', error: 'boom' }))).toBe(
      'Action "registrar_mamada" failed: "boom"',
    );
    expect(actionProposalOutcomeText(outcome({ decision: 'rejected' }))).toBe(
      'Action "registrar_mamada" was rejected and was not executed.',
    );
  });

  it("leads with the tool's own presentation text, for the person reading the history", () => {
    const text = actionProposalOutcomeText(
      outcome({ executionStatus: 'succeeded', result: { ok: true }, text: 'Mamada registrada.' }),
    );
    expect(text).toBe(
      'Mamada registrada.\n\nAction "registrar_mamada" completed. Result: {"ok":true}',
    );
    expect(text).not.toContain('proposal-5d5c');
  });
});
