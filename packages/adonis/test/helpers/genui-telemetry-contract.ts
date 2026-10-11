import type { AgentGovernanceQueries, AgentStore, RecordGenuiCallInput } from '../../src/index.js';

/**
 * A store under test: the store that records generative-UI telemetry, the governance queries over
 * the same data, and a thread the rows may hang off (`threadId`, created by the subject).
 */
export interface GenuiTelemetryStoreContractSubject {
  store: AgentStore;
  governance: AgentGovernanceQueries;
  threadId: string;
  actorRef: string;
}

/** One behaviour every store that records genui telemetry must have. `run` throws on the first mismatch. */
export interface GenuiTelemetryStoreContractCase {
  name: string;
  run: (subject: GenuiTelemetryStoreContractSubject) => Promise<void>;
}

function check(condition: boolean, message: string, actual?: unknown): void {
  if (!condition) {
    throw new Error(actual === undefined ? message : `${message} (got ${JSON.stringify(actual)})`);
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const range = () => ({ fromDay: today(), toDay: today() });

/** Overrides may set an optional field to `undefined`: it is then left out of the row. */
type CallOverrides = { [K in keyof RecordGenuiCallInput]?: RecordGenuiCallInput[K] | undefined };

function call(
  subject: GenuiTelemetryStoreContractSubject,
  overrides: CallOverrides = {},
): RecordGenuiCallInput {
  return withoutUndefined({
    toolCallId: 'call-1',
    runId: 'run-1',
    threadId: subject.threadId,
    actorRef: subject.actorRef,
    step: 0,
    toolName: 'ui__sandbox',
    channel: 'web',
    mode: 'sandbox',
    modelId: 'model-a',
    attempt: 1,
    outcome: 'ok',
    validity: 'first_try',
    inputTokens: 120,
    outputTokens: 40,
    costUsd: 0.0125,
    costSource: 'provider',
    firstFrameMs: 300,
    completeFrameMs: 900,
    payloadBytes: 512,
    ...overrides,
  }) as RecordGenuiCallInput;
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * What a store owes the generative-UI telemetry (`AgentStore.recordGenuiCalls` and
 * `AgentGovernanceQueries.genuiStats`): every field round-trips into the stats, a call recorded
 * again replaces its row (a replayed turn does not double count), optional fields stay absent, and
 * a payload is kept only when one was given. Framework-agnostic:
 *
 * ```ts
 * for (const contractCase of GENUI_TELEMETRY_STORE_CONTRACT) {
 *   it(contractCase.name, async () => contractCase.run(await freshSubject()));
 * }
 * ```
 */
export const GENUI_TELEMETRY_STORE_CONTRACT: readonly GenuiTelemetryStoreContractCase[] = [
  {
    name: 'records UI calls and summarizes them by tool and model',
    async run(subject) {
      const { store, governance } = subject;
      check(typeof store.recordGenuiCalls === 'function', 'store.recordGenuiCalls exists');
      check(typeof governance.genuiStats === 'function', 'governance.genuiStats exists');
      await store.recordGenuiCalls?.([
        call(subject, {
          toolCallId: 'a-1',
          runId: 'run-a',
          outcome: 'error',
          validity: 'failed',
          errorCategory: 'bridge',
          errorMessage: 'jsx line 2:3: `flippy.send` — the bridge is `agent.send(payload)`',
          completeFrameMs: undefined,
        }),
        call(subject, {
          toolCallId: 'a-2',
          runId: 'run-a',
          step: 1,
          attempt: 2,
          validity: 'retried',
          firstFrameMs: 1500,
          completeFrameMs: 2100,
        }),
        call(subject, {
          toolCallId: 'b-1',
          runId: 'run-b',
          toolName: 'ui__render',
          mode: 'tree',
          modelId: 'model-b',
          costUsd: undefined,
          costSource: undefined,
          firstFrameMs: undefined,
          completeFrameMs: undefined,
        }),
      ]);
      const stats = await governance.genuiStats?.(range());
      check(stats !== undefined, 'stats');
      if (stats === undefined) return;
      check(stats.totals.calls === 3, 'calls', stats.totals);
      check(stats.totals.turns === 2, 'turns', stats.totals);
      check(stats.totals.firstAttempts === 2, 'first attempts', stats.totals);
      check(stats.totals.firstTrySuccesses === 1, 'first-try successes', stats.totals);
      check(
        stats.totals.retried === 1 && stats.totals.failed === 1,
        'retried/failed',
        stats.totals,
      );
      check(stats.totals.inputTokens === 360, 'input tokens', stats.totals);
      check(Math.abs((stats.totals.costUsd ?? 0) - 0.025) < 1e-9, 'cost', stats.totals);
      const sandbox = stats.byToolModel.find((row) => row.toolName === 'ui__sandbox');
      check(sandbox?.modelId === 'model-a' && sandbox.firstTryRate === 0, 'sandbox row', sandbox);
      const tree = stats.byToolModel.find((row) => row.toolName === 'ui__render');
      check(tree?.firstTryRate === 1 && tree.costUsd === null, 'tree row', tree);
      check(stats.errors.length === 1, 'errors', stats.errors);
      check(
        stats.errors[0]?.category === 'bridge' &&
          stats.errors[0].message.includes('flippy.send') &&
          stats.errors[0].count === 1,
        'error row',
        stats.errors[0],
      );
      check(stats.byDay.length === 1 && stats.byDay[0]?.day === today(), 'by day', stats.byDay);
      check(stats.latency.firstFrame.samples === 1, 'first-frame samples', stats.latency);
      check(
        stats.latency.firstFrame.p50Ms === 300,
        'first frame (earliest of the turn)',
        stats.latency,
      );
      check(stats.latency.complete.p50Ms === 2100, 'complete frame', stats.latency);
    },
  },
  {
    name: 'a call recorded again replaces its row',
    async run(subject) {
      const { store, governance } = subject;
      await store.recordGenuiCalls?.([call(subject, { outputTokens: 10 })]);
      await store.recordGenuiCalls?.([call(subject, { outputTokens: 50 })]);
      const stats = await governance.genuiStats?.(range());
      check(stats?.totals.calls === 1, 'one row', stats?.totals);
      check(stats?.totals.outputTokens === 50, 'the latest values', stats?.totals);
    },
  },
  {
    name: 'nothing outside the range',
    async run(subject) {
      const { store, governance } = subject;
      await store.recordGenuiCalls?.([call(subject)]);
      const stats = await governance.genuiStats?.({ fromDay: '2000-01-01', toDay: '2000-01-02' });
      check(stats?.totals.calls === 0, 'no rows', stats?.totals);
      check(stats?.totals.firstTryRate === null, 'no rate', stats?.totals);
    },
  },
];
