import type { ActionApprovalMode } from './action-proposal-receipt.js';
import type { ActionProposalOutcomeStore } from './spi/action-proposal-outcome-store.js';
import type {
  ActionProposalStore,
  ActionProposalSupersessionStore,
} from './spi/action-proposal-store.js';
import type { ActionProposalWorkerStore } from './spi/action-proposal-worker-store.js';
import type { AgentStore } from './spi/agent-store.js';
import type { BackgroundActorResolver } from './spi/background-actor-resolver.js';
import { isChatQueueStore } from './spi/chat-queue.js';
export type IndependentActionStore = AgentStore &
  ActionProposalStore &
  ActionProposalWorkerStore &
  ActionProposalOutcomeStore &
  ActionProposalSupersessionStore;
export function assertIndependentActionRuntime(
  mode: ActionApprovalMode | undefined,
  store: unknown,
  resolver: BackgroundActorResolver | undefined,
  queuedAdmission: boolean,
): asserts store is IndependentActionStore {
  if (mode !== undefined && mode !== 'blocking' && mode !== 'independent')
    throw new TypeError('Invalid actionApprovalMode');
  if (mode !== 'independent') return;
  if (!resolver || typeof resolver.resolve !== 'function')
    throw new Error('Independent actions require a background actor resolver');
  const methods = [
    'createActionProposal',
    'getActionProposal',
    'listActionProposals',
    'decideActionProposal',
    'claimActionProposal',
    'extendActionProposalLease',
    'settleActionProposal',
    'claimNextActionProposal',
    'expireActionProposals',
    'claimNextActionProposalOutcome',
    'admitActionProposalOutcome',
    'getThreadActionProposalScope',
    'createReplacingActionProposal',
    'supersedeActionProposal',
  ];
  if (
    !store ||
    typeof store !== 'object' ||
    methods.some((method) => typeof Reflect.get(store, method) !== 'function')
  )
    throw new Error('Independent actions require atomic proposal/outcome capabilities');
  if (Reflect.get(store, 'actionProposalAdmissionSupported') === false)
    throw new Error('Independent actions require atomic outcome admission');
  if (!queuedAdmission || !isChatQueueStore(store as AgentStore))
    throw new Error('Independent actions require actual queued admission');
}
