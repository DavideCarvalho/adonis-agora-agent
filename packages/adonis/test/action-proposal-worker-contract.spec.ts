import { describe, it } from 'vitest';
import { InMemoryActionProposalStore } from '../src/testing/in-memory-action-proposal-store.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';
import { ACTION_PROPOSAL_WORKER_STORE_CONTRACT } from './helpers/action-proposal-worker-store-contract.js';

describe.each([InMemoryActionProposalStore, InMemoryAgentStore])(
  'proposal worker contract: %s',
  (Store) => {
    for (const contract of ACTION_PROPOSAL_WORKER_STORE_CONTRACT) {
      it(contract.name, async () => {
        let now = 1000;
        await contract.run({
          store: new Store({ clock: () => now }),
          setNow: (value) => {
            now = value;
          },
        });
      });
    }
  },
);
