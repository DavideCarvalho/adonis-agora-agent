import diagnostics_channel from 'node:diagnostics_channel';
import { toRunScore } from './evaluate.js';
import type { RunSampleSource } from './sample-source.js';
import type { RunScore, ScoreStore } from './score-store.js';
import type { Scorer } from './types.js';

/**
 * The channel the agent loop publishes a settled run on. Subscribed over Node's builtin
 * `node:diagnostics_channel`, exactly as the media-ingestion bridge does — but the loop only PUBLISHES
 * when `@adonis-agora/diagnostics` is installed to fill the emit slot, so live scoring is silently
 * inert without it. The offline batch has no such dependency.
 */
const RUN_FINISHED_CHANNEL = 'agora:agent:run.finished';

/** Pull `.payload` off a diagnostics-channel message without an unguarded cast. */
function envelopePayload(message: unknown): unknown {
  if (typeof message === 'object' && message !== null && 'payload' in message) {
    return (message as { payload: unknown }).payload;
  }
  return undefined;
}

/** The `runId` a `run.finished` envelope carries, or `undefined` for anything else. */
function finishedRunId(message: unknown): string | undefined {
  const payload = envelopePayload(message);
  if (typeof payload !== 'object' || payload === null || !('runId' in payload)) {
    return undefined;
  }
  const runId = (payload as { runId: unknown }).runId;
  return typeof runId === 'string' ? runId : undefined;
}

export interface LiveScoringOptions {
  source: RunSampleSource;
  scorers: Scorer[];
  store: ScoreStore;
  /**
   * Fraction of finished runs to score, `0..1`. Default `1`. Turn it down for a scorer that costs
   * money per run — a trend needs a representative sample, not every row.
   */
  sampleRate?: number;
  /** Sampler; injectable so a test can pin the decision. */
  random?: () => number;
  now?: () => Date;
  /** Told about anything that went wrong. Default: swallowed — a score is never worth a log storm. */
  onError?: (error: unknown) => void;
}

/** The handle {@link attachLiveScoring} returns. */
export interface LiveScoring {
  /** Detach the subscription. In-flight scoring already started still settles. */
  dispose(): void;
  /** Resolves once every scoring started so far has settled — what a test awaits. */
  settled(): Promise<void>;
}

/**
 * Score runs as they finish, by listening to `agora:agent:run.finished`.
 *
 * Opt-in: nothing calls this for you. And deliberately NOT inline in the turn — a scorer wired into
 * the agent loop would add its latency to every message a user sends, and a model-graded one would
 * double the cost of the product. This runs AFTER the run has already finished and reported so, on a
 * diagnostics subscriber, in a detached promise. There is no code path from a scorer back into the
 * turn: the run has settled and its stream has closed before the first scorer is called, and every
 * failure below is caught and handed to `onError`. A scorer cannot fail a turn because by the time
 * it runs there is no turn left to fail.
 *
 * It still costs real work per run, so the offline {@link import('./evaluate.js').runEvaluation}
 * batch remains the default path — reach for this when you want a dashboard that moves within the
 * hour, and prefer the `rule`/`statistical` scorers here.
 */
export function attachLiveScoring(options: LiveScoringOptions): LiveScoring {
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const sampleRate = options.sampleRate ?? 1;
  const channel = diagnostics_channel.channel(RUN_FINISHED_CHANNEL);
  const inFlight = new Set<Promise<void>>();

  const onMessage = (message: unknown): void => {
    // The whole handler is guarded: this runs on the publisher's stack, so anything that escapes
    // here surfaces inside whoever emitted the event.
    try {
      const runId = finishedRunId(message);
      if (runId === undefined || (sampleRate < 1 && random() >= sampleRate)) {
        return;
      }
      const task = scoreFinishedRun({ runId, options, now }).catch(options.onError ?? (() => {}));
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    } catch (error) {
      options.onError?.(error);
    }
  };

  channel.subscribe(onMessage);
  return {
    dispose: () => channel.unsubscribe(onMessage),
    settled: async () => {
      await Promise.all([...inFlight]);
    },
  };
}

/** Load the finished run and persist whatever the scorers had to say about it. */
async function scoreFinishedRun(args: {
  runId: string;
  options: LiveScoringOptions;
  now: () => Date;
}): Promise<void> {
  const { runId, options, now } = args;
  const run = await options.source.getRun(runId);
  if (run === null) {
    return;
  }
  const scores: RunScore[] = [];
  for (const scorer of options.scorers) {
    try {
      const result = await scorer.score(run);
      if (result !== null) {
        scores.push(toRunScore({ run, scorer, result, scoredAt: now() }));
      }
    } catch (error) {
      options.onError?.(error);
    }
  }
  if (scores.length > 0) {
    await recordQuietly({ store: options.store, scores, onError: options.onError });
  }
}

/** A store that rejects must not take the whole subscriber down with it. */
async function recordQuietly(args: {
  store: ScoreStore;
  scores: RunScore[];
  onError: ((error: unknown) => void) | undefined;
}): Promise<void> {
  try {
    await args.store.recordScores(args.scores);
  } catch (error) {
    args.onError?.(error);
  }
}
