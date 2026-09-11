import diagnostics_channel from 'node:diagnostics_channel';
import { describe, expect, it } from 'vitest';
import {
  attachLiveScoring,
  GovernanceRunSampleSource,
  InMemoryScoreStore,
  loadApprovalPrior,
  RunCompletionScorer,
  runEvaluation,
} from '../src/evals/index.js';
import { InMemoryAgentStore, InMemoryGovernanceQueries } from '../src/testing/index.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };

/**
 * Two turns on one thread, each stamping its own messages — the shape that made the NestJS port
 * reach for a time-window heuristic, and that this read-model answers directly.
 */
async function seedThread(): Promise<InMemoryAgentStore> {
  const store = new InMemoryAgentStore();
  const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
  for (const [runId, question, answer] of [
    ['run-a', 'first question', 'first answer'],
    ['run-b', 'second question', 'second answer'],
  ] as const) {
    await store.recordRunStart({ runId, threadId: thread.id, actor: ACTOR, durable: false });
    await store.appendMessage({ threadId: thread.id, role: 'user', content: question, runId });
    const assistant = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: answer,
      runId,
    });
    await store.recordToolCall({
      toolCallId: `${runId}-tc`,
      messageId: assistant.id,
      toolName: 'purge_cache',
      toolType: 'action',
      input: {},
      status: 'pending_approval',
      runId,
    });
    await store.updateToolCall({
      toolCallId: `${runId}-tc`,
      status: runId === 'run-a' ? 'rejected' : 'executed',
    });
    // A read call alongside, so anything that folds tool history has to say which kind it counts.
    await store.recordToolCall({
      toolCallId: `${runId}-read`,
      messageId: assistant.id,
      toolName: 'search',
      toolType: 'read',
      input: {},
      status: 'auto_executed',
      runId,
    });
    await store.updateToolCall({ toolCallId: `${runId}-read`, status: 'executed' });
    await store.recordRunEnd({ runId, status: 'completed', finishedAt: Date.now(), stepCount: 1 });
  }
  return store;
}

describe('GovernanceRunSampleSource', () => {
  it('gives each run its own question and answer off the run stamp, never a neighbour turn’s', async () => {
    const store = await seedThread();
    const source = new GovernanceRunSampleSource(new InMemoryGovernanceQueries(store));
    const runs = await source.listRuns({ limit: 10 });
    expect(
      runs
        .map((run) => [run.runId, run.input, run.output])
        .sort((left, right) => left.join().localeCompare(right.join())),
    ).toEqual([
      ['run-a', 'first question', 'first answer'],
      ['run-b', 'second question', 'second answer'],
    ]);
  });

  it('carries the run’s tool calls and their human verdicts', async () => {
    const store = await seedThread();
    const source = new GovernanceRunSampleSource(new InMemoryGovernanceQueries(store));
    const run = await source.getRun('run-a');
    expect(run?.toolCalls).toEqual([
      expect.objectContaining({ toolName: 'purge_cache', toolType: 'action', status: 'rejected' }),
      expect.objectContaining({ toolName: 'search', toolType: 'read', status: 'executed' }),
    ]);
  });

  it('walks the cursor rather than taking the read-model’s clamped first page as the whole batch', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
    for (let index = 0; index < 205; index += 1) {
      const runId = `run-${String(index).padStart(3, '0')}`;
      await store.recordRunStart({ runId, threadId: thread.id, actor: ACTOR, durable: false });
      await store.appendMessage({ threadId: thread.id, role: 'assistant', content: 'a', runId });
    }
    const source = new GovernanceRunSampleSource(new InMemoryGovernanceQueries(store));
    expect(await source.listRuns({ limit: 205 })).toHaveLength(205);
  });

  it('scores what the read-model holds, end to end', async () => {
    const store = await seedThread();
    const scoreStore = new InMemoryScoreStore();
    const summary = await runEvaluation({
      source: new GovernanceRunSampleSource(new InMemoryGovernanceQueries(store)),
      scorers: [new RunCompletionScorer()],
      store: scoreStore,
      query: { limit: 10 },
    });
    expect(summary).toMatchObject({ runsRead: 2, scoresRecorded: 2 });
    expect((await scoreStore.listScores({})).every((row) => row.score === 1)).toBe(true);
  });
});

describe('loadApprovalPrior', () => {
  it('counts only action calls a human actually decided on', async () => {
    const store = await seedThread();
    const prior = await loadApprovalPrior({ queries: new InMemoryGovernanceQueries(store) });
    expect([...prior.entries()]).toEqual([['purge_cache', { approved: 1, rejected: 1 }]]);
  });

  it('honours the day bounds it was given', async () => {
    const store = await seedThread();
    const prior = await loadApprovalPrior({
      queries: new InMemoryGovernanceQueries(store),
      query: { fromDay: '2000-01-01', toDay: '2000-01-02' },
    });
    expect(prior.size).toBe(0);
  });
});

describe('attachLiveScoring', () => {
  it('scores a run off the finished event and persists it', async () => {
    const store = await seedThread();
    const scoreStore = new InMemoryScoreStore();
    const live = attachLiveScoring({
      source: new GovernanceRunSampleSource(new InMemoryGovernanceQueries(store)),
      scorers: [new RunCompletionScorer()],
      store: scoreStore,
    });
    diagnostics_channel
      .channel('agora:agent:run.finished')
      .publish({ payload: { runId: 'run-a' } });
    await live.settled();
    live.dispose();
    expect((await scoreStore.listScores({})).map((row) => row.runId)).toEqual(['run-a']);
  });

  it('sheds load at the configured sample rate', async () => {
    const store = await seedThread();
    const scoreStore = new InMemoryScoreStore();
    const live = attachLiveScoring({
      source: new GovernanceRunSampleSource(new InMemoryGovernanceQueries(store)),
      scorers: [new RunCompletionScorer()],
      store: scoreStore,
      sampleRate: 0.5,
      random: () => 0.9,
    });
    diagnostics_channel
      .channel('agora:agent:run.finished')
      .publish({ payload: { runId: 'run-a' } });
    await live.settled();
    live.dispose();
    expect(await scoreStore.listScores({})).toHaveLength(0);
  });

  it('hands a scorer’s failure to onError instead of throwing into the publisher', async () => {
    const store = await seedThread();
    const errors: unknown[] = [];
    const live = attachLiveScoring({
      source: new GovernanceRunSampleSource(new InMemoryGovernanceQueries(store)),
      scorers: [
        {
          name: 'boom',
          kind: 'model',
          score: async () => {
            throw new Error('judge is down');
          },
        },
      ],
      store: new InMemoryScoreStore(),
      onError: (error) => errors.push(error),
    });
    expect(() =>
      diagnostics_channel
        .channel('agora:agent:run.finished')
        .publish({ payload: { runId: 'run-a' } }),
    ).not.toThrow();
    await live.settled();
    live.dispose();
    expect((errors[0] as Error).message).toBe('judge is down');
  });

  it('ignores an envelope that carries no runId', async () => {
    const store = await seedThread();
    const scoreStore = new InMemoryScoreStore();
    const live = attachLiveScoring({
      source: new GovernanceRunSampleSource(new InMemoryGovernanceQueries(store)),
      scorers: [new RunCompletionScorer()],
      store: scoreStore,
    });
    diagnostics_channel.channel('agora:agent:run.finished').publish({ payload: { steps: 1 } });
    await live.settled();
    live.dispose();
    expect(await scoreStore.listScores({})).toHaveLength(0);
  });
});
