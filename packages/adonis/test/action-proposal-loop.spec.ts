import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DefaultRolesPolicy,
  PENDING_ACTION_PROPOSAL_NOTE,
  runAgentLoop,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';

describe('independent action turns', () => {
  it('words a proposal with the shared filler: templates over the trusted input, else the label', async () => {
    const actor = { id: 'actor', roles: ['ADMIN'] };
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor });
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'refund_order',
        kind: 'action',
        description: 'refund',
        inputSchema: z.object({ order: z.object({ id: z.number() }), note: z.string().optional() }),
        presentation: {
          label: 'Refund',
          running: 'Refunding',
          done: 'Refunded',
          confirm: { title: 'Refund order #{order.id} {note}?', verb: 'Refund' },
        },
      },
      { execute: async () => 'refunded' },
    );
    registry.register(
      {
        name: 'archive_note',
        kind: 'action',
        description: 'archive',
        inputSchema: z.object({}),
        presentation: { label: 'Note archive', running: 'Archiving', done: 'Archived' },
      },
      { execute: async () => 'archived' },
    );
    registry.register(
      { name: 'purge_cache', kind: 'action', description: 'purge', inputSchema: z.object({}) },
      { execute: async () => 'purged' },
    );
    const model = new FakeModelProvider((_args, turn) =>
      turn === 0
        ? {
            text: '',
            toolCalls: [
              { id: 'c-refund', name: 'refund_order', input: { order: { id: 1002 } } },
              { id: 'c-archive', name: 'archive_note', input: {} },
              { id: 'c-purge', name: 'purge_cache', input: {} },
            ],
          }
        : { text: 'ok' },
    );
    const sink = new InMemoryTokenStreamSink();
    await runAgentLoop(
      {
        model,
        registry,
        store,
        rolesPolicy: new DefaultRolesPolicy(),
        systemPrompt: 'Test',
        day: '2026-10-01',
        actionApprovalMode: 'independent',
      },
      { actor, threadId: thread.id, userText: 'Run' },
      {
        runId: 'run-words',
        openSink: () => sink.open('run-words'),
        step: (_, fn) => fn(),
        awaitApproval: async () => {
          throw new Error('Independent action must not await');
        },
      },
    );
    const proposals = await store.listActionProposals({
      tenantRef: null,
      actorRef: actor.id,
      threadId: thread.id,
    });
    const byTool = Object.fromEntries(proposals.map((p) => [p.toolName, p.confirmation]));
    expect(byTool).toEqual({
      // The empty `{note}` collapses with its space, as every other surface's filler does.
      refund_order: { title: 'Refund order #1002?', verb: 'Refund' },
      archive_note: { title: 'Note archive?', verb: 'Approve' },
      purge_cache: { title: 'Purge cache?', verb: 'Approve' },
    });
  });

  it('captures trusted raw and normalized input, finishes batch and ends without awaiting or false terminal success', async () => {
    const actor = { id: 'actor', roles: ['ADMIN'] };
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor });
    const registry = new ToolRegistry();
    let actions = 0;
    let reads = 0;
    let prepares = 0;
    let models = 0;
    registry.register(
      {
        name: 'action',
        kind: 'action',
        description: 'action',
        terminal: true,
        inputSchema: z.object({ amount: z.number().transform((n) => n + 1) }),
      },
      {
        preflight: async (input) => {
          prepares++;
          return {
            status: 'ready',
            confirmation: { title: `Amount ${(input as { amount: number }).amount}`, verb: 'Run' },
          };
        },
        execute: async () => {
          actions++;
          return 'executed';
        },
      },
    );
    registry.register(
      { name: 'read', kind: 'read', description: 'read', inputSchema: z.object({}) },
      {
        execute: async () => {
          reads++;
          return 'read';
        },
      },
    );
    const sink = new InMemoryTokenStreamSink();
    const model = new FakeModelProvider(() => {
      models++;
      return {
        text: '',
        toolCalls: [
          {
            id: 'call-0-action',
            name: 'action',
            input: { amount: 1 },
            preparation: { input: { amount: 999 } },
          },
          { id: 'call-0-read', name: 'read', input: {} },
        ],
      };
    });
    const produce = model.runTurn.bind(model);
    model.runTurn = async (args) => {
      const turn = await produce(args);
      return {
        ...turn,
        toolCalls: turn.toolCalls.map((call) => ({
          ...call,
          prepared: {
            preparationInput: { amount: 999 },
            input: { amount: 999 },
            preflight: { status: 'ready' as const },
          },
        })),
      };
    };
    await runAgentLoop(
      {
        model,
        registry,
        store,
        rolesPolicy: new DefaultRolesPolicy(),
        systemPrompt: 'Test',
        day: '2026-10-01',
        actionApprovalMode: 'independent',
      },
      { actor, threadId: thread.id, userText: 'Run' },
      {
        runId: 'run',
        openSink: () => sink.open('run'),
        step: (_, fn) => fn(),
        awaitApproval: async () => {
          throw new Error('Independent action must not await');
        },
      },
    );
    expect({ actions, reads, prepares, models }).toEqual({
      actions: 0,
      reads: 1,
      prepares: 1,
      models: 1,
    });
    const proposal = (
      await store.listActionProposals({ tenantRef: null, actorRef: actor.id, threadId: thread.id })
    )[0];
    expect(proposal).toMatchObject({
      input: { amount: 2 },
      preparationInput: { amount: 1 },
      confirmation: { title: 'Amount 2' },
      decision: 'pending',
    });
    const message = (await store.getThread(thread.id))!.messages.find((m) =>
      m.toolCalls?.some((call) => call.id === 'call-0-action'),
    );
    expect(message?.approvals?.[0]).toMatchObject({
      status: 'pending',
      target: { kind: 'proposal', proposalId: proposal?.id },
    });
    // The model is told plainly that nothing happened yet (it must not say "done" before the tap).
    expect(message?.toolResults?.find((r) => r.id === 'call-0-action')?.output).toEqual({
      proposalId: proposal?.id,
      status: 'pending',
      executed: false,
      note: PENDING_ACTION_PROPOSAL_NOTE,
    });
    expect(PENDING_ACTION_PROPOSAL_NOTE).toMatch(/NOT done yet.*awaiting their confirmation/);
  });
});

it.each(['auto', 'remembered'] as const)(
  'keeps legacy nonJSON normalized Date values for %s',
  async (mode) => {
    const actor = { id: 'actor', roles: ['ADMIN'] };
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor });
    if (mode === 'remembered') {
      const message = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: '',
      });
      await store.recordToolCall({
        toolCallId: 'old',
        messageId: message.id,
        toolName: 'schedule',
        toolType: 'action',
        input: null,
        status: 'executed',
      });
      await store.updateToolCall({ toolCallId: 'old', status: 'executed', remember: true });
    }
    const registry = new ToolRegistry();
    let executed: unknown;
    let policies = 0;
    registry.register(
      {
        name: 'schedule',
        kind: 'action',
        terminal: true,
        description: 'schedule',
        inputSchema: z.object({ at: z.string().transform((value) => new Date(value)) }),
      },
      {
        execute: (input: { at: Date }) => {
          executed = input.at;
          return 'scheduled';
        },
      },
    );
    const model = new FakeModelProvider(() => ({
      text: '',
      toolCall: { name: 'schedule', input: { at: '2026-10-01T12:00:00Z' } },
    }));
    const sink = new InMemoryTokenStreamSink();
    await runAgentLoop(
      {
        store,
        registry,
        model,
        rolesPolicy: new DefaultRolesPolicy(),
        systemPrompt: 'test',
        day: '2026-10-01',
        actionApprovalMode: 'independent',
        approvalPolicy: {
          requirementFor: () => {
            policies++;
            return { required: mode !== 'auto', approver: 'requester' };
          },
        },
      },
      { actor, threadId: thread.id, userText: 'schedule' },
      {
        runId: 'run',
        step: (_, fn) => fn(),
        openSink: () => sink.open('run'),
        awaitApproval: async () => {
          throw new Error('must not wait');
        },
      },
    );
    expect(executed).toBeInstanceOf(Date);
    expect(policies).toBe(1);
    expect(
      await store.listActionProposals({ tenantRef: null, actorRef: actor.id, threadId: thread.id }),
    ).toEqual([]);
  },
);
