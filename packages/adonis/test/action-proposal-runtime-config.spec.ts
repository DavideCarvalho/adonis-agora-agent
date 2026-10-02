import { expect, it } from 'vitest';
import { assertIndependentActionRuntime } from '../src/action-proposal-runtime.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';

it('requires current background authority, atomic store capability and real queue admission only for opt-in', () => {
  expect(() => assertIndependentActionRuntime('blocking', {}, undefined, false)).not.toThrow();
  const store = new InMemoryAgentStore();
  expect(() => assertIndependentActionRuntime('independent', store, undefined, true)).toThrow(
    'resolver',
  );
  const resolver = { resolve: async () => null };
  expect(() => assertIndependentActionRuntime('independent', {}, resolver, true)).toThrow(
    'capabilities',
  );
  expect(() => assertIndependentActionRuntime('independent', store, resolver, false)).toThrow(
    'queue',
  );
  expect(() => assertIndependentActionRuntime('independent', store, resolver, true)).not.toThrow();
});

it('refuses a store explicitly declaring atomic outcome admission unsupported', () => {
  const store = Object.assign(new InMemoryAgentStore(), {
    actionProposalAdmissionSupported: false,
  });
  expect(() =>
    assertIndependentActionRuntime('independent', store, { resolve: async () => null }, true),
  ).toThrow('admission');
});
it('requires atomic replacement capability before enabling independent mode', () => {
  const store = Object.assign(new InMemoryAgentStore(), {
    createReplacingActionProposal: undefined,
  });
  expect(() =>
    assertIndependentActionRuntime('independent', store, { resolve: async () => null }, true),
  ).toThrow('capabilities');
});
