import type { AgentUiComponent } from '../stream-events.js';
import type {
  ActionProposalDecision,
  ActionProposalLease,
  ActionProposalScope,
} from './action-proposal-store.js';

export interface ActionProposalOutcome extends ActionProposalScope {
  id: string;
  proposalId: string;
  outcomeVersion: 1;
  originRunId: string;
  originToolCallId: string;
  toolName: string;
  decision: ActionProposalDecision;
  executionStatus?: 'succeeded' | 'failed';
  result?: unknown;
  error?: string;
  ui: AgentUiComponent[];
  text?: string;
  createdAt: number;
}
export interface ActionProposalOutcomeDelivery {
  status: 'pending' | 'admitted' | 'discarded';
  generation: number;
  lease: ActionProposalLease | null;
  messageId?: string;
}
export interface ActionProposalOutcomeLease {
  outcomeId: string;
  token: string;
  generation: number;
}
export interface ActionProposalOutcomeStore {
  getThreadActionProposalScope(threadId: string): Promise<ActionProposalScope | null>;
  claimNextActionProposalOutcome(command: {
    workerId: string;
    leaseMs: number;
  }): Promise<{ outcome: ActionProposalOutcome; lease: ActionProposalOutcomeLease } | null>;
  admitActionProposalOutcome(command: ActionProposalOutcomeLease): Promise<{
    status: 'applied' | 'unchanged' | 'busy' | 'conflict' | 'not_found' | 'discarded';
    messageId?: string;
  }>;
}
