import { createHash } from 'node:crypto';
import { PACKAGE_ORIGIN } from '../package-origin.js';
import type { Actor } from '../types.js';
import { ChannelDeliveryError } from './http.js';
import type { InboundMessage } from './types.js';

/**
 * How a channel's inbound messages are processed: one {@link ChannelJob} per message, in order per
 * conversation, each made of named phases.
 *
 * - {@link inlineExecutor}: in this process, after the `200`. A restart loses what was in flight.
 * - {@link durableExecutor}: as `@adonis-agora/durable` runs — persisted before the `200`, one at a
 *   time per conversation (a singleton key), each phase a checkpointed step (a dispatched one, when
 *   the engine has somewhere to serve it), and resumed by the engine's recovery after a crash.
 */

/** What a channel processes: a message, the rest of a run after its question, a question timing out. */
export type ChannelJob =
  | {
      kind: 'message';
      channel: string;
      conversation: string;
      message: InboundMessage;
      /** When the webhook took it (epoch ms) — what a turn's queue wait is measured from. */
      receivedAt?: number;
      /**
       * Recorded in the conversation's burst log when it was taken (`coalesce` on): the job first
       * looks for a burst to join, or to lead.
       */
      coalesce?: boolean;
    }
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

/**
 * The phases a job is made of. Each one is rebuilt from its (JSON) input — the job and what the
 * phases before it returned — so it can run in any process that registered the channel.
 */
export type ChannelPhase = 'gather' | 'prepare' | 'act' | 'read' | 'timeout';

/** What one phase is handed: the job, and what the phases before it came to (all JSON). */
export interface ChannelPhaseInput {
  job: ChannelJob;
  /** `gather`: which look at the burst this is (0, 1, …). */
  round?: number;
  /** The messages the turn is made of, when it groups several (a burst). */
  batch?: InboundMessage[];
  /** What `prepare` came to. */
  prepared?: unknown;
  /** What `act` came to. */
  turn?: unknown;
}

/** Runs one phase: checkpointed (durable — in this process, or dispatched) or just called (inline). */
export type ChannelPhaseRunner = <T>(phase: ChannelPhase, input: ChannelPhaseInput) => Promise<T>;

/** How a job runs its phases, and how it waits for a burst to end. */
export interface ChannelJobIo {
  phase: ChannelPhaseRunner;
  /** Wait until `at` (epoch ms): the durable engine's sleep, else a timer. */
  sleepUntil(at: number): Promise<void>;
}

/** What a registered channel gives the executors: its job, and each of its phases on its own. */
export interface ChannelRunner {
  run(job: ChannelJob, io: ChannelJobIo): Promise<void>;
  phase(phase: ChannelPhase, input: ChannelPhaseInput): Promise<unknown>;
  /** How long a dispatched phase may go without an answer before the engine gives up on it. */
  stepTimeoutMs(phase: ChannelPhase): number;
  /** `false` → this channel's phases always run as `localStep`s (`durableSteps: false`). */
  dispatched?: boolean;
}

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

/** The checkpoint name of a phase run in-process — `gather` takes one per look at the burst. */
const localStepName = (phase: ChannelPhase, input: ChannelPhaseInput) =>
  phase === 'gather' ? `gather:${input.round ?? 0}` : phase;

/** A timer, for a wait the durable engine cannot hold. */
const timerUntil = (at: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, at - Date.now()));
    (timer as { unref?: () => void }).unref?.();
  });

/** Each phase called right here, a wait a timer: what the inline executor runs a job with. */
export function inlineIo(runner: Pick<ChannelRunner, 'phase'>): ChannelJobIo {
  return {
    phase: <T>(phase: ChannelPhase, input: ChannelPhaseInput) =>
      runner.phase(phase, input) as Promise<T>,
    sleepUntil: timerUntil,
  };
}

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

/** What a dispatched step handler is given besides its input — a durable `StepLogger`'s slice. */
export interface ChannelStepLog {
  /** Tell the engine the step is alive (rearms its timeout, where the transport carries beats). */
  heartbeat?(progress?: unknown): void;
}

/**
 * Where dispatched steps are served BY NAME — a durable `Transport` with `handle` (every built-in
 * one has it: in-memory, BullMQ, database). A handler registered here runs in whatever process the
 * transport hands the step to.
 */
export interface ChannelStepServer {
  handle(name: string, fn: (input: unknown, log?: ChannelStepLog) => Promise<unknown>): void;
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
    opts?: {
      singleton?: { key: (input: unknown) => string; limit?: number };
      /** Package attribution stamped on every run (`WorkflowRun.origin`). */
      origin?: string;
    },
  ): void;
  start(
    workflow: string,
    input: unknown,
    runId: string,
    opts?: { startAt?: number | Date },
  ): Promise<unknown>;
  waitForRun?(runId: string, opts?: { timeoutMs?: number; terminal?: boolean }): Promise<unknown>;
  /**
   * Serve a dispatched step by name — for an engine that serves its own steps. `@adonis-agora/durable`'s
   * engine serves them on its transport instead: the channels find it in the app's container (or take
   * it as `channels.handle(…, { durableSteps: transport })`). Neither → the phases run in the process
   * that runs the workflow (`ctx.localStep`).
   */
  handleStep?(name: string, fn: (input: unknown, log?: ChannelStepLog) => Promise<unknown>): void;
}

/** The slice of a durable `WorkflowCtx` a channel job uses. */
export interface ChannelWorkflowCtx {
  localStep<T>(
    name: string,
    fn: () => Promise<T>,
    options?: { retries?: number; backoff?: 'fixed' | 'exp'; backoffMs?: number },
  ): Promise<T>;
  /**
   * A dispatched step, routed to the handler served under `name` in any process. Absent → the
   * phases run as `localStep`s.
   */
  step?<T>(
    name: string,
    input: unknown,
    options?: { retries?: number; timeoutMs?: number; pickupTimeoutMs?: number },
  ): Promise<T>;
  /** Suspend the run until `when` (durable). Absent → {@link sleep}, else a timer in this process. */
  sleepUntil?(when: number | Date): Promise<void>;
  /** Suspend the run for `duration` ms (durable). */
  sleep?(duration: number): Promise<void>;
}

/** The workflow a message (or a resume) runs as: one at a time per channel conversation. */
export const CHANNEL_JOB_WORKFLOW = 'agora.channel.job';
/** A question's timeout: runs on its own, so it never waits behind the conversation. */
export const CHANNEL_TIMER_WORKFLOW = 'agora.channel.timer';
/** The dispatched step a phase runs as: `agora.channel.prepare`, `agora.channel.read`, … */
export const channelPhaseStep = (phase: ChannelPhase) => `agora.channel.${phase}`;
const PHASES: readonly ChannelPhase[] = ['gather', 'prepare', 'act', 'read', 'timeout'];

/** `@adonis-agora/durable`'s stamp on its control-flow signals (a global symbol). */
const CONTROL_FLOW = Symbol.for('@agora/durable:control-flow');

/** A control-flow signal a workflow body surfaces (a suspend for a sleep, say) — not a failure. */
export const isControlFlowSignal = (error: unknown) => {
  if (error === null || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return (
    name === 'WorkflowSuspended' ||
    name === 'ContinueAsNew' ||
    name === 'WorkflowBlocked' ||
    CONTROL_FLOW in error
  );
};

const registeredOn = new WeakSet<object>();
const servedOn = new WeakSet<object>();
/** The step server each engine's channel phases are dispatched to, once one is known. */
const stepServers = new WeakMap<object, ChannelStepServer>();

/** How often a dispatched phase tells the engine it is still running. */
const HEARTBEAT_MS = 10_000;
/** How long a phase waits for its channel to be registered in the process it landed on. */
const REGISTRATION_WAIT_MS = 60_000;

const notRegistered = (channel: string) =>
  new Error(
    `[@adonis-agora/agent] channel "${channel}" is not registered in this process — create its handler (channels.handle) at boot in every process that runs durable work`,
  );

/** The channel's runner, waiting a minute for a handler created lazily (on its first webhook). */
async function runnerIn(
  runnerFor: (channel: string) => ChannelRunner | undefined,
  channel: string,
): Promise<ChannelRunner> {
  const deadline = Date.now() + REGISTRATION_WAIT_MS;
  for (;;) {
    const runner = runnerFor(channel);
    if (runner !== undefined) return runner;
    if (Date.now() >= deadline) throw notRegistered(channel);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/**
 * Serve every channel phase on `server`, once: the handler finds the channel named in the input in
 * whatever process the step lands on, and runs that phase from its input alone.
 */
function servePhases(
  server: ChannelStepServer,
  runnerFor: (channel: string) => ChannelRunner | undefined,
): void {
  if (servedOn.has(server)) return;
  servedOn.add(server);
  for (const phase of PHASES) {
    server.handle(channelPhaseStep(phase), async (input, log) => {
      const { channel, ...rest } = input as ChannelPhaseInput & { channel: string };
      const runner = await runnerIn(runnerFor, channel);
      const beat = setInterval(() => log?.heartbeat?.(), HEARTBEAT_MS);
      (beat as { unref?: () => void }).unref?.();
      try {
        return (await runner.phase(phase, rest)) ?? null;
      } finally {
        clearInterval(beat);
      }
    });
  }
}

/** The durable wait: `sleepUntil`, else `sleep`, else (an engine without either) a timer. */
const durableSleep =
  (ctx: ChannelWorkflowCtx) =>
  (at: number): Promise<void> => {
    if (typeof ctx.sleepUntil === 'function') return ctx.sleepUntil(at);
    if (typeof ctx.sleep === 'function') return ctx.sleep(Math.max(1, at - Date.now()));
    return timerUntil(at);
  };

/**
 * Register the channel workflows on `engine`, once. Their body finds the job's channel with
 * `runnerFor` — the handler `channels.handle()` registered under that name IN THIS PROCESS. A
 * process that resumes channel jobs must have created the same handlers.
 *
 * - version `1`: every phase a `ctx.localStep`, in the process running the workflow — kept so runs
 *   started before an upgrade finish on the path they were recorded on;
 * - version `2` (new runs): each phase a DISPATCHED step (`agora.channel.<phase>`) when `server` (or
 *   `engine.handleStep`) serves them — any process that registered the channel runs it, any
 *   process continues the workflow — else a `localStep`; and a burst (`coalesce`) waited for with
 *   the engine's durable sleep. Which of the two a run uses is recorded in its first step.
 */
export function registerChannelWorkflows(
  engine: ChannelWorkflowEngine,
  runnerFor: (channel: string) => ChannelRunner | undefined,
  server?: ChannelStepServer,
): void {
  const given =
    server ??
    (typeof engine.handleStep === 'function'
      ? { handle: engine.handleStep.bind(engine) }
      : undefined);
  if (given !== undefined && !stepServers.has(engine)) {
    stepServers.set(engine, given);
    servePhases(given, runnerFor);
  }
  if (registeredOn.has(engine)) return;
  registeredOn.add(engine);

  /** The channel is registered here — given a minute for a handler created lazily. */
  const channelStep = <T>(ctx: ChannelWorkflowCtx, job: ChannelJob, value: () => T) =>
    ctx.localStep(
      'channel',
      async () => {
        if (runnerFor(job.channel) === undefined) throw notRegistered(job.channel);
        return value();
      },
      { retries: 30, backoff: 'fixed', backoffMs: 2000 },
    );

  const localIo = (ctx: ChannelWorkflowCtx, runner: ChannelRunner): ChannelJobIo => ({
    phase: <T>(phase: ChannelPhase, input: ChannelPhaseInput) =>
      ctx.localStep(localStepName(phase, input), () => runner.phase(phase, input) as Promise<T>),
    sleepUntil: durableSleep(ctx),
  });

  const dispatchedIo = (
    ctx: ChannelWorkflowCtx,
    runner: ChannelRunner,
    channel: string,
  ): ChannelJobIo => ({
    phase: <T>(phase: ChannelPhase, input: ChannelPhaseInput) => {
      const step = ctx.step;
      if (typeof step !== 'function') throw new Error('[@adonis-agora/agent] ctx.step is gone');
      // A liveness window per phase: a step whose job was lost (a worker gone, a broker that
      // dropped it) is dispatched once more after it, then fails the job — never `pending` forever.
      return step.call(
        ctx,
        channelPhaseStep(phase),
        { channel, ...input },
        { timeoutMs: runner.stepTimeoutMs(phase), retries: 2 },
      ) as Promise<T>;
    },
    sleepUntil: durableSleep(ctx),
  });

  const v1 = async (ctx: ChannelWorkflowCtx, input: unknown) => {
    const job = input as ChannelJob;
    await channelStep(ctx, job, () => true);
    const runner = runnerFor(job.channel);
    if (runner === undefined) return null;
    // As version 1 always ran: no burst to wait for (its jobs never recorded one), phases local.
    await runner.run(
      job.kind === 'message' ? { ...job, coalesce: false } : job,
      localIo(ctx, runner),
    );
    return null;
  };

  const v2 = async (ctx: ChannelWorkflowCtx, input: unknown) => {
    const job = input as ChannelJob;
    const mode = await channelStep(ctx, job, () => ({
      dispatched:
        stepServers.has(engine) &&
        typeof ctx.step === 'function' &&
        runnerFor(job.channel)?.dispatched !== false,
    }));
    const runner = runnerFor(job.channel);
    if (runner === undefined) return null;
    await runner.run(
      job,
      mode.dispatched === true ? dispatchedIo(ctx, runner, job.channel) : localIo(ctx, runner),
    );
    return null;
  };

  const origin = { origin: PACKAGE_ORIGIN };
  const singleton = {
    ...origin,
    singleton: { key: (input: unknown) => lockKey(input as ChannelJob), limit: 1 },
  };
  engine.register(CHANNEL_JOB_WORKFLOW, '1', v1, singleton);
  engine.register(CHANNEL_JOB_WORKFLOW, '2', v2, singleton);
  engine.register(CHANNEL_TIMER_WORKFLOW, '1', v1, origin);
  engine.register(CHANNEL_TIMER_WORKFLOW, '2', v2, origin);
}

/** As durable runs on `engine` — see {@link registerChannelWorkflows}. */
export function durableExecutor(engine: ChannelWorkflowEngine): ChannelExecutor {
  const started = new Set<string>();
  const start = async (workflow: string, job: ChannelJob, id: string, at?: number) => {
    try {
      await engine.start(workflow, job, id, at === undefined ? undefined : { startAt: at });
    } catch (error) {
      // A run a driving dispatcher suspended (or continued as new) while starting it: taken.
      const name = (error as { name?: unknown } | null)?.name;
      if (name !== 'WorkflowSuspended' && name !== 'ContinueAsNew') throw error;
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
