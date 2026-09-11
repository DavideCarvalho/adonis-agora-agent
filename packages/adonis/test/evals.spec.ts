import { describe, expect, it } from 'vitest';
import {
  AnswerRelevancyScorer,
  ApprovalOutcomeScorer,
  ApprovalRiskScorer,
  bucketScoreTrend,
  buildApprovalPrior,
  InMemoryScoreStore,
  JudgeVerdictError,
  parseJudgeVerdict,
  priorFromRuns,
  RunCompletionScorer,
  runEvaluation,
  type ScorableRun,
  type ScorableToolCall,
  type Scorer,
  StaticRunSampleSource,
  summarizeByAgent,
  summarizeByScorer,
  worstScoredRuns,
} from '../src/evals/index.js';
import { echoScript, FakeModelProvider } from '../src/testing/index.js';

function call(overrides: Partial<ScorableToolCall> = {}): ScorableToolCall {
  return {
    toolCallId: 'tc1',
    toolName: 'purge_cache',
    toolType: 'action',
    status: 'executed',
    executionMs: 12,
    error: null,
    ...overrides,
  };
}

function run(overrides: Partial<ScorableRun> = {}): ScorableRun {
  return {
    runId: 'r1',
    threadId: 't1',
    actorRef: 'u1',
    agentName: 'support',
    status: 'completed',
    input: 'why is the cache stale?',
    output: 'because nothing purged it',
    toolCalls: [],
    durationMs: 900,
    error: null,
    startedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('RunCompletionScorer', () => {
  const scorer = new RunCompletionScorer();

  it('leaves a still-running run unscored rather than freezing a verdict', async () => {
    expect(await scorer.score(run({ status: 'running', output: '' }))).toBeNull();
  });

  it('scores a failed run 0 and names the failure', async () => {
    const result = await scorer.score(run({ status: 'failed', error: 'quota_exceeded' }));
    expect(result?.score).toBe(0);
    expect(result?.reason).toContain('quota_exceeded');
  });

  it('scores a cancelled run 0 — a turn a human stopped did not deliver either', async () => {
    const result = await scorer.score(run({ status: 'cancelled' }));
    expect(result?.score).toBe(0);
    expect(result?.reason).toContain('cancelled');
  });

  it('scores a completed run that answered nothing 0, unlike the governance success rate', async () => {
    const result = await scorer.score(run({ output: '   ' }));
    expect(result?.score).toBe(0);
    expect(result?.reason).toContain('without answering');
  });

  it('scores an answer written while a tool was failing between the two', async () => {
    const result = await scorer.score(
      run({
        toolCalls: [call({ toolType: 'read', status: 'failed', toolName: 'search' }), call()],
      }),
    );
    expect(result?.score).toBe(0.5);
    expect(result?.reason).toContain('search');
  });

  it('scores a clean answered run 1', async () => {
    const result = await scorer.score(run({ toolCalls: [call()] }));
    expect(result?.score).toBe(1);
  });
});

describe('ApprovalOutcomeScorer', () => {
  const scorer = new ApprovalOutcomeScorer();

  it('says nothing about a run that proposed no action', async () => {
    expect(await scorer.score(run({ toolCalls: [call({ toolType: 'read' })] }))).toBeNull();
  });

  it('says nothing while every proposed action is still undecided', async () => {
    expect(
      await scorer.score(run({ toolCalls: [call({ status: 'pending_approval' })] })),
    ).toBeNull();
  });

  it('reads a human rejection as the negative label it is', async () => {
    const result = await scorer.score(
      run({
        toolCalls: [
          call({ toolCallId: 'a', status: 'executed' }),
          call({ toolCallId: 'b', status: 'rejected', toolName: 'drop_table' }),
        ],
      }),
    );
    expect(result?.score).toBe(0.5);
    expect(result?.reason).toContain('drop_table');
    expect(result?.metadata).toMatchObject({ approved: 1, rejected: 1, pending: 0 });
  });

  it('counts an approved action that then crashed as approved — the human still said yes', async () => {
    const result = await scorer.score(run({ toolCalls: [call({ status: 'failed' })] }));
    expect(result?.score).toBe(1);
  });

  it('ignores undecided actions when computing the fraction', async () => {
    const result = await scorer.score(
      run({
        toolCalls: [
          call({ toolCallId: 'a', status: 'rejected' }),
          call({ toolCallId: 'b', status: 'pending_approval' }),
        ],
      }),
    );
    expect(result?.score).toBe(0);
    expect(result?.metadata).toMatchObject({ pending: 1 });
  });
});

describe('approval prior', () => {
  it('puts a tool nobody ever decided on at exactly 0.5', async () => {
    const scorer = new ApprovalRiskScorer(new Map());
    const result = await scorer.score(run({ toolCalls: [call()] }));
    expect(result?.score).toBe(0.5);
    expect(result?.reason).toContain('no human has ever decided');
  });

  it('never reads a single rejection as certainty', () => {
    const prior = buildApprovalPrior([{ toolName: 'drop_table', status: 'rejected' }]);
    expect(prior.get('drop_table')).toEqual({ approved: 0, rejected: 1 });
  });

  it('ignores a call no human has decided on', () => {
    const prior = buildApprovalPrior([
      { toolName: 'drop_table', status: 'pending_approval' },
      { toolName: 'drop_table', status: 'auto_executed' },
    ]);
    expect(prior.has('drop_table')).toBe(false);
  });

  it('folds the action calls of runs already in hand, and only those', () => {
    const prior = priorFromRuns([
      run({
        toolCalls: [
          call({ toolName: 'drop_table', status: 'rejected' }),
          call({ toolName: 'search', toolType: 'read', status: 'executed' }),
        ],
      }),
    ]);
    expect([...prior.keys()]).toEqual(['drop_table']);
  });

  it('scores a run as its riskiest proposed action, not the average', async () => {
    const prior = buildApprovalPrior([
      { toolName: 'safe', status: 'executed' },
      { toolName: 'safe', status: 'executed' },
      { toolName: 'risky', status: 'rejected' },
      { toolName: 'risky', status: 'rejected' },
    ]);
    const scorer = new ApprovalRiskScorer(prior);
    const result = await scorer.score(
      run({
        toolCalls: [
          call({ toolCallId: 'a', toolName: 'safe', status: 'pending_approval' }),
          call({ toolCallId: 'b', toolName: 'risky', status: 'pending_approval' }),
        ],
      }),
    );
    expect(result?.score).toBeCloseTo(1 / 4);
    expect(result?.metadata).toMatchObject({ riskiestTool: 'risky' });
  });
});

describe('AnswerRelevancyScorer', () => {
  it('reads a SCORE/REASON verdict and normalizes it to 0..1', async () => {
    const model = new FakeModelProvider(echoScript('SCORE: 4\nREASON: mostly on topic'));
    const scorer = new AnswerRelevancyScorer({ model });
    const result = await scorer.score(run());
    expect(result?.score).toBeCloseTo(0.8);
    expect(result?.reason).toBe('mostly on topic');
  });

  it('grades nothing when there is no answer to compare', async () => {
    const model = new FakeModelProvider(echoScript('SCORE: 5'));
    expect(await new AnswerRelevancyScorer({ model }).score(run({ output: '' }))).toBeNull();
  });

  it('refuses a reply that carried no verdict rather than scoring the agent 0', () => {
    expect(() => parseJudgeVerdict('I think it was fine')).toThrow(JudgeVerdictError);
  });

  it('refuses a score outside the scale it asked for', () => {
    expect(() => parseJudgeVerdict('SCORE: 9\nREASON: x')).toThrow(JudgeVerdictError);
  });
});

describe('runEvaluation', () => {
  const scorers = [new RunCompletionScorer(), new ApprovalOutcomeScorer()];

  it('persists one row per (run, scorer) that had something to say', async () => {
    const source = new StaticRunSampleSource([run({ toolCalls: [call()] })]);
    const store = new InMemoryScoreStore();
    const summary = await runEvaluation({ source, scorers, store, query: { limit: 10 } });
    expect(summary).toMatchObject({ runsRead: 1, runsScored: 1, scoresRecorded: 2 });
    expect((await store.listScores({})).map((row) => row.scorer)).toEqual(
      expect.arrayContaining(['run-completion', 'approval-outcome']),
    );
  });

  it('does not count a scorer that abstained as a score', async () => {
    const source = new StaticRunSampleSource([run()]);
    const store = new InMemoryScoreStore();
    const summary = await runEvaluation({ source, scorers, store, query: { limit: 10 } });
    expect(summary.scoresRecorded).toBe(1);
  });

  it('skips a (run, scorer) pair the store already covered, so a backfill resumes free', async () => {
    const source = new StaticRunSampleSource([run()]);
    const store = new InMemoryScoreStore();
    await runEvaluation({ source, scorers, store, query: { limit: 10 } });
    const second = await runEvaluation({ source, scorers, store, query: { limit: 10 } });
    expect(second).toMatchObject({ pairsSkipped: 1, scoresRecorded: 0 });
  });

  it('rescores on demand', async () => {
    const source = new StaticRunSampleSource([run()]);
    const store = new InMemoryScoreStore();
    await runEvaluation({ source, scorers, store, query: { limit: 10 } });
    const second = await runEvaluation({
      source,
      scorers,
      store,
      query: { limit: 10 },
      rescore: true,
    });
    expect(second.scoresRecorded).toBe(1);
  });

  it('collects a throwing scorer as a failure and scores the rest of the batch', async () => {
    const boom: Scorer = {
      name: 'boom',
      kind: 'model',
      score: async () => {
        throw new Error('judge replied with prose');
      },
    };
    const source = new StaticRunSampleSource([run(), run({ runId: 'r2' })]);
    const store = new InMemoryScoreStore();
    const summary = await runEvaluation({
      source,
      scorers: [boom, new RunCompletionScorer()],
      store,
      query: { limit: 10 },
    });
    expect(summary.failures).toHaveLength(2);
    expect(summary.failures[0]?.message).toContain('prose');
    expect(summary.scoresRecorded).toBe(2);
  });

  it('buckets a score under the day the RUN started, not the day the batch ran', async () => {
    const source = new StaticRunSampleSource([run({ startedAt: '2026-01-05T23:30:00.000Z' })]);
    const store = new InMemoryScoreStore();
    await runEvaluation({
      source,
      scorers: [new RunCompletionScorer()],
      store,
      query: { limit: 10 },
      now: () => new Date('2026-09-01T00:00:00.000Z'),
    });
    expect((await store.listScores({}))[0]?.day).toBe('2026-01-05');
  });
});

describe('summaries', () => {
  const rows = [
    {
      runId: 'r1',
      threadId: 't1',
      agentName: 'support',
      scorer: 'run-completion',
      kind: 'rule' as const,
      score: 1,
      reason: 'ok',
      day: '2026-09-01',
      scoredAt: '2026-09-02T00:00:00.000Z',
    },
    {
      runId: 'r2',
      threadId: 't1',
      agentName: 'support',
      scorer: 'run-completion',
      kind: 'rule' as const,
      score: 0,
      reason: 'failed',
      day: '2026-09-02',
      scoredAt: '2026-09-02T00:00:01.000Z',
    },
    {
      runId: 'r3',
      threadId: 't2',
      agentName: null,
      scorer: 'approval-outcome',
      kind: 'rule' as const,
      score: 0.5,
      reason: 'half',
      day: '2026-09-01',
      scoredAt: '2026-09-02T00:00:02.000Z',
    },
  ];

  it('rolls up per scorer, worst mean first', () => {
    expect(summarizeByScorer(rows).map((row) => [row.scorer, row.meanScore, row.samples])).toEqual([
      ['approval-outcome', 0.5, 1],
      ['run-completion', 0.5, 2],
    ]);
  });

  it('buckets a run with no agent under (default)', () => {
    expect(summarizeByAgent(rows).map((row) => row.agentName)).toContain('(default)');
  });

  it('trends per day and scorer, oldest first', () => {
    expect(bucketScoreTrend(rows).map((point) => [point.day, point.scorer])).toEqual([
      ['2026-09-01', 'approval-outcome'],
      ['2026-09-01', 'run-completion'],
      ['2026-09-02', 'run-completion'],
    ]);
  });

  it('puts the worst runs at the top of the triage queue', () => {
    expect(worstScoredRuns(rows, 2).map((row) => row.runId)).toEqual(['r2', 'r3']);
  });
});

describe('InMemoryScoreStore', () => {
  it('appends rather than replacing, so a re-score leaves the history readable', async () => {
    const store = new InMemoryScoreStore();
    const row = {
      runId: 'r1',
      threadId: 't1',
      agentName: null,
      scorer: 's',
      kind: 'rule' as const,
      score: 1,
      reason: 'a',
      day: '2026-09-01',
      scoredAt: '2026-09-01T00:00:00.000Z',
    };
    await store.recordScores([row]);
    await store.recordScores([{ ...row, score: 0, scoredAt: '2026-09-02T00:00:00.000Z' }]);
    expect(await store.listScores({ runId: 'r1' })).toHaveLength(2);
  });

  it('filters by inclusive day bounds', async () => {
    const store = new InMemoryScoreStore();
    for (const day of ['2026-08-31', '2026-09-01', '2026-09-02']) {
      await store.recordScores([
        {
          runId: day,
          threadId: 't1',
          agentName: null,
          scorer: 's',
          kind: 'rule',
          score: 1,
          reason: 'a',
          day,
          scoredAt: `${day}T00:00:00.000Z`,
        },
      ]);
    }
    const rows = await store.listScores({ fromDay: '2026-09-01', toDay: '2026-09-02' });
    expect(rows.map((row) => row.day).sort()).toEqual(['2026-09-01', '2026-09-02']);
  });
});
