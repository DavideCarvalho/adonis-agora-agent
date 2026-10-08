import { createHash } from 'node:crypto';
import type { Actor } from '../types.js';
import { ChannelDeliveryError } from './http.js';
import type { InboundMessage } from './types.js';

/**
 * How a channel's inbound messages are processed: one {@link ChannelJob} per message, in order per
 * conversation, each made of named phases ({@link ChannelStepRunner}).
 *
 * - {@link inlineExecutor}: in this process, after the `200`. A restart loses what was in flight.
 * - {@link durableExecutor}: as `@adonis-agora/durable` runs — persisted before the `200`, one at a
 *   time per conversation (a singleton key), each phase a checkpointed step, and resumed by the
 *   engine's recovery after a crash.
 */

/** What a channel processes: a message, the rest of a run after its question, a question timing out. */
export type ChannelJob =
  | { kind: 'message'; channel: string; conversation: string; message: InboundMessage }
  | {
      /** Read a run's stream (again) and deliver what was not delivered yet. */
      kind: 'resume';
      channel: string;
      conversation: string;
      runId: string;
      threadId: string | null;
      actor: Actor;
    }
  | {
      /** A question nobody answered in time: skip it, then resume the run. Runs outside the lock. */
      kind: 'timeout';
      channel: string;
      conversation: string;
      /** The run parked on the question (a delegate's, sometimes). */
      runId: string;
      toolCallId: string;
      /** The run whose stream the person reads. */
      streamRunId: string;
      threadId: string | null;
      actor: Actor;
    };

/** Runs one phase of a job: checkpointed (durable) or just called (inline). Results are JSON. */
export type ChannelStepRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/** What runs a job — the registered channel's processor. */
export type ChannelJobRunner = (job: ChannelJob, step: ChannelStepRunner) => Promise<void>;

export interface ChannelExecutor {
  readonly durable: boolean;
  /**
   * Take a job: persisted (durable) or queued (inline) when this resolves — what the webhook waits
   * for before its `200`. Jobs of one conversation run one at a time, in the order they were taken.
   */
  enqueue(job: ChannelJob, id: string): Promise<void>;
  /** Run a job at `at` (epoch ms), outside the conversation's order. */
  later(job: ChannelJob, id: string, at: number): Promise<void>;
  /** Resolves once every job taken by this executor so far has finished. */
  drain(): Promise<void>;
}

/** Ids a store / engine takes whatever the provider's message id looks like. */
export function jobId(...parts: string[]): string {
  const id = `agora.channel:${parts.join(':')}`;
  return id.length <= 160 ? id : `agora.channel:${createHash('sha256').update(id).digest('hex')}`;
}

/** The order key: one channel conversation. */
const lockKey = (job: Pick<ChannelJob, 'channel' | 'conversation'>) =>
  `${job.channel}:${job.conversation}`;

/** In this process: a promise chain per conversation. Nothing survives a restart. */
export function inlineExecutor(run: (job: ChannelJob) => Promise<void>): ChannelExecutor {
  const chains = new Map<string, Promise<void>>();
  const inFlight = new Set<Promise<void>>();
  const track = (work: Promise<void>) => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
    return work;
  };
  return {
    durable: false,
    async enqueue(job) {
      const key = lockKey(job);
      const previous = chains.get(key) ?? Promise.resolve();
      const next = track(previous.then(() => run(job)).catch(() => {}));
      chains.set(key, next);
      void next.finally(() => {
        if (chains.get(key) === next) chains.delete(key);
      });
    },
    async later(job, _id, at) {
      const timer = setTimeout(() => track(run(job).catch(() => {})), Math.max(0, at - Date.now()));
      timer.unref?.();
    },
    async drain() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}

/**
 * The slice of an `@adonis-agora/durable` `WorkflowEngine` the channels use — the engine itself
 * satisfies it (`channels.handle(adapter, { durable: engine })`).
 */
export interface ChannelWorkflowEngine {
  register(
    name: string,
    version: string,
    fn: (ctx: ChannelWorkflowCtx, input: unknown) => Promise<unknown>,
    opts?: { singleton?: { key: (input: unknown) => string; limit?: number } },
  ): void;
  start(
    workflow: string,
    input: unknown,
    runId: string,
    opts?: { startAt?: number | Date },
  ): Promise<unknown>;
  waitForRun?(runId: string, opts?: { timeoutMs?: number; terminal?: boolean }): Promise<unknown>;
}

/** The slice of a durable `WorkflowCtx` a channel job uses. */
export interface ChannelWorkflowCtx {
  localStep<T>(
    name: string,
    fn: () => Promise<T>,
    options?: { retries?: number; backoff?: 'fixed' | 'exp'; backoffMs?: number },
  ): Promise<T>;
}

/** The workflow a message (or a resume) runs as: one at a time per channel conversation. */
export const CHANNEL_JOB_WORKFLOW = 'agora.channel.job';
/** A question's timeout: runs on its own, so it never waits behind the conversation. */
export const CHANNEL_TIMER_WORKFLOW = 'agora.channel.timer';

/** A control-flow signal a driving dispatcher may surface out of `start` — not a failure. */
const isControlFlowSignal = (error: unknown) => {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'WorkflowSuspended' || name === 'ContinueAsNew';
};

const registeredOn = new WeakSet<object>();

/**
 * Register the channel workflows on `engine`, once. Their body finds the job's channel with
 * `runnerFor` — the handler `channels.handle()` registered under that name IN THIS PROCESS. A
 * process that resumes channel jobs must have created the same handlers.
 */
export function registerChannelWorkflows(
  engine: ChannelWorkflowEngine,
  runnerFor: (channel: string) => ChannelJobRunner | undefined,
): void {
  if (registeredOn.has(engine)) return;
  registeredOn.add(engine);
  const body = async (ctx: ChannelWorkflowCtx, input: unknown) => {
    const job = input as ChannelJob;
    // A handler created lazily (on its first webhook) may not exist yet in the process that
    // recovered this run: give it a minute before failing the job.
    await ctx.localStep(
      'channel',
      async () => {
        if (runnerFor(job.channel) === undefined)
          throw new Error(
            `[@adonis-agora/agent] channel "${job.channel}" is not registered in this process — create its handler (channels.handle) at boot in every process that runs durable work`,
          );
        return true;
      },
      { retries: 30, backoff: 'fixed', backoffMs: 2000 },
    );
    const run = runnerFor(job.channel);
    if (run === undefined) return null;
    await run(job, (name, fn) => ctx.localStep(name, fn));
    return null;
  };
  engine.register(CHANNEL_JOB_WORKFLOW, '1', body, {
    singleton: { key: (input) => lockKey(input as ChannelJob), limit: 1 },
  });
  engine.register(CHANNEL_TIMER_WORKFLOW, '1', body);
}

/** As durable runs on `engine` — see {@link registerChannelWorkflows}. */
export function durableExecutor(engine: ChannelWorkflowEngine): ChannelExecutor {
  const started = new Set<string>();
  const start = async (workflow: string, job: ChannelJob, id: string, at?: number) => {
    try {
      await engine.start(workflow, job, id, at === undefined ? undefined : { startAt: at });
    } catch (error) {
      if (!isControlFlowSignal(error)) throw error;
    }
  };
  return {
    durable: true,
    async enqueue(job, id) {
      await start(CHANNEL_JOB_WORKFLOW, job, id);
      started.add(id);
    },
    async later(job, id, at) {
      await start(CHANNEL_TIMER_WORKFLOW, job, id, at);
    },
    async drain() {
      while (started.size > 0) {
        const ids = [...started];
        started.clear();
        await Promise.allSettled(
          ids.map((id) => engine.waitForRun?.(id, { terminal: true }) ?? Promise.resolve()),
        );
      }
    },
  };
}

export interface ChannelRetryOptions {
  /** Attempts per phase (the first included). Default 3. */
  attempts?: number;
  /** Delay before the second attempt; doubles each time (with jitter). Default 1 s. */
  backoffMs?: number;
  /** The longest delay between two attempts. Default 30 s. */
  maxBackoffMs?: number;
  /**
   * Retry after this error? Default: not a refusal that retrying cannot change — a definite 4xx
   * from the provider (`ChannelDeliveryError.definite`), an error carrying a 4xx `status`, a
   * `QuotaBlockedError` — everything else yes.
   */
  retryable?(error: unknown): boolean;
}

/** {@link ChannelRetryOptions.retryable}'s default. */
export function retryableByDefault(error: unknown): boolean {
  if (error instanceof ChannelDeliveryError) return !error.definite;
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) return false;
  const name = (error as { name?: unknown } | null)?.name;
  return name !== 'QuotaBlockedError' && name !== 'AttachmentRefusedError';
}

/** Run `fn`, again after a growing delay while it fails with a retryable error. */
export async function withRetries<T>(
  fn: () => Promise<T>,
  options: ChannelRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const base = Math.max(0, options.backoffMs ?? 1000);
  const max = Math.max(base, options.maxBackoffMs ?? 30_000);
  const retryable = options.retryable ?? retryableByDefault;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !retryable(error)) throw error;
      const delay = Math.min(max, base * 2 ** (attempt - 1));
      await new Promise((resolve) => setTimeout(resolve, delay * (0.5 + Math.random() / 2)));
    }
  }
}
