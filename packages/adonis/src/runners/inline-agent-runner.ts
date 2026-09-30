import { type AgentDeps, utcDay } from '../agent-deps.js';
import type { AgentDepsFactory } from '../agent-deps-factory.js';
import {
  type AgentLoopHooks,
  RunCancelledError,
  runAgentLoop,
  settleAll,
  streamErrorFrame,
} from '../agent-loop.js';
import {
  type ChatQueueService,
  isThreadTurn,
  type QueueSettleOutcome,
} from '../chat-queue-service.js';
import { spannedAgent } from '../diagnostics.js';
import {
  type ElicitationRequest,
  type HumanReply,
  HumanReplyMismatchError,
  isHumanDecision,
} from '../elicitation.js';
import type { AgentRunner, AgentRunStartOptions } from '../spi/agent-runner.js';
import type { AgentStore } from '../spi/agent-store.js';
import { releaseThreadRun } from '../spi/chat-queue.js';
import { childSinkWriter, type SinkWriter } from '../spi/token-stream-sink.js';
import type { Actor, AgentRunInput, Decision } from '../types.js';

/**
 * A run held at one wait, and WHICH wait — an `action`'s approve/reject, or a question set's
 * answers. Both arrive through `signal`, so the kind is what lets a reply of the wrong shape be
 * refused instead of settling a wait it says nothing about.
 */
interface ParkedWait {
  on: 'approval' | 'answers';
  resolve: (reply: HumanReply) => void;
  /** Unwind the parked turn (a cancel). */
  reject: (error: Error) => void;
}

/**
 * Runs the agent turn in-process — the default runner (`durable: false`). A HITL wait resolves a
 * pending promise keyed run-namespaced by `${runId}:${toolCallId}`, so one run's reply can never
 * satisfy another's pending action.
 *
 * Sub-agent delegation runs a nested loop on a transient sub-thread, and that nested run parks on a
 * human exactly as a top-level one does — under its OWN runId, which is what makes it answerable:
 * the pending row it writes carries that runId, and its frames are forwarded into the top-level
 * ancestor's stream (the only stream anyone subscribed to) carrying it too. The mirror of the
 * durable runner's `sinkRunId`.
 *
 * Single-replica only — durable is the scaled path (deferred).
 */
export class InlineAgentRunner implements AgentRunner {
  private readonly pending = new Map<string, ParkedWait>();
  /**
   * The input of each top-level run this process is running — what {@link isRunActive} answers
   * from, and what a cancel settles the thread (and its queue) of.
   */
  private readonly live = new Map<string, AgentRunInput>();
  /** Runs someone asked to stop; the loop observes it at its next safe point. */
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly factory: AgentDepsFactory,
    private readonly store: AgentStore,
    /** The thread message queue this runner drains when a thread's own turn settles. */
    private readonly queue?: ChatQueueService,
  ) {}

  /**
   * In-process, so exact: a run this process is not running is not running anywhere — the process
   * that was running it is gone (a restart), and a thread it still holds is a stale claim.
   */
  async isRunActive(runId: string): Promise<boolean> {
    return this.live.has(runId);
  }

  async start(
    input: AgentRunInput,
    options: AgentRunStartOptions = {},
  ): Promise<{ runId: string }> {
    const runId = options.runId ?? crypto.randomUUID();
    const day = input.day ?? utcDay();
    const deps = this.factory.forAgent(input.agentName);
    const hooks = this.topLevelHooks({
      runId,
      input,
      deps,
      actor: input.actor,
      day,
      // The chain this run sits on with its OWN agent appended — what lets a child recognise a
      // delegation back to an agent the chain has already passed through.
      chainBelow: [
        ...(input.delegationPath ?? []),
        ...(input.agentName !== undefined ? [input.agentName] : []),
      ],
      depth: input.delegationDepth ?? 0,
    });

    // The root turn span — the trace's root, correlated to every child step span by traceId = runId.
    // Emitted by the runner (not the shared loop) because the inline runner executes the loop exactly
    // once; the durable runner's body replays, so it roots its trace by traceId instead. Zero-cost
    // when unobserved.
    // The thread's active run is set BEFORE the loop starts — a fast turn could otherwise end (and
    // clear it) before it was ever set — and cleared when the turn ends, however it ends.
    // (A run the queue claimed the thread for already holds it under this id; setting it again is a
    // no-op.)
    await this.store.setActiveStream(input.threadId, runId);
    this.live.set(runId, input);
    void spannedAgent(
      'turn',
      runId,
      { runId },
      () => runAgentLoop({ ...deps, day }, input, hooks),
      (result) => ({ textLength: result.text.length }),
    )
      // The drain already moved the thread on (or released it) before the stream ended; this only
      // catches a turn that ended without one. Conditional, so it never clears a successor's claim.
      .then(() => releaseThreadRun(this.store, input.threadId, runId))
      .catch(async (error) => {
        if (error instanceof RunCancelledError) {
          // `cancel` already settled the run, its thread and its stream; the loop only had to stop.
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[@adonis-agora/agent] run ${runId} failed: ${message}`);
        // Settle the run's persisted outcome — the loop only records completions (it can't catch its
        // own crash). First-terminal, so this can't clobber a completion that already landed.
        await this.store.recordRunEnd({ runId, status: 'failed', error: message });
        const writer = await deps.sink.open(runId);
        // The queue behind it pauses (a failed turn's next message would likely fail the same way),
        // told to the reader before the error frame.
        await this.settleQueue(writer, input, runId, 'failed', message);
        await releaseThreadRun(this.store, input.threadId, runId);
        // Surface the failure on the live stream and close it, so a subscriber isn't left hanging.
        await writer.write(streamErrorFrame(error));
        await writer.end();
      })
      .catch((error) => {
        console.error(
          `[@adonis-agora/agent] run ${runId} could not be settled: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        this.live.delete(runId);
        this.cancelled.delete(runId);
      });

    return { runId };
  }

  /**
   * Move the thread past a settling TOP-LEVEL run — to the next queued message, which starts here,
   * or to a paused/empty queue — and write the resulting `queue` frame into this run's stream. A
   * no-op without a queue-capable store, and for a run that is not a thread's own turn.
   *
   * Never throws: the run is settling either way, and a queue that could not be advanced is picked
   * up by the next send or resume on the thread.
   */
  private async settleQueue(
    writer: SinkWriter,
    input: AgentRunInput,
    runId: string,
    outcome: QueueSettleOutcome,
    error?: string,
  ): Promise<void> {
    const queue = this.queue;
    if (queue === undefined || !queue.supported || !isThreadTurn(input)) {
      return;
    }
    // A Stop that arrived too late to interrupt anything (the turn's last model call was already
    // answering) still means stop: the queue behind it pauses as it would after a cancel.
    const settled = outcome === 'completed' && this.cancelled.has(runId) ? 'cancelled' : outcome;
    try {
      const frame = await queue.handoff(
        {
          threadId: input.threadId,
          runId,
          outcome: settled,
          ...(error !== undefined ? { error } : {}),
        },
        (next, nextRunId) => this.start(next, { runId: nextRunId }),
      );
      if (frame !== undefined) {
        await writer.write({ t: 'event', event: frame });
      }
    } catch (failure) {
      console.error(
        `[@adonis-agora/agent] could not advance the queue of thread ${input.threadId} after run ${runId}: ${
          failure instanceof Error ? failure.message : String(failure)
        }`,
      );
    }
  }

  /**
   * Deliver a human's reply to whichever wait this run is parked on.
   *
   * An approval wait takes a {@link Decision} only. Answers addressed there are refused rather than
   * delivered: `approved` is absent on them, and the tool-call row would record a rejection the
   * person never made. The refusal leaves the wait intact, so the approval is still there to make.
   *
   * The other direction IS delivered — a question set parks as a `pending_approval` action, so an
   * operator pressing Approve on it is expected, and the loop reads that as "confirmed the
   * pre-picked answers".
   */
  async signal(runId: string, toolCallId: string, reply: HumanReply): Promise<void> {
    const key = `${runId}:${toolCallId}`;
    const parked = this.pending.get(key);
    if (parked === undefined) {
      return;
    }
    if (parked.on === 'approval' && !isHumanDecision(reply)) {
      throw new HumanReplyMismatchError(runId, toolCallId);
    }
    this.pending.delete(key);
    parked.resolve(reply);
  }

  async cancel(runId: string): Promise<void> {
    // The loop stops at its next safe point (between steps, or once the model call it is in has
    // answered); a turn parked on a human is unwound now.
    this.cancelled.add(runId);
    for (const [key, parked] of this.pending) {
      if (key.startsWith(`${runId}:`)) {
        this.pending.delete(key);
        parked.reject(new RunCancelledError());
      }
    }
    // Best-effort: settle the run `cancelled` (first-terminal, so a completed run stays completed),
    // then close the live stream so a subscriber isn't left hanging.
    await this.store.recordRunEnd({ runId, status: 'cancelled' });
    const deps = this.factory.forAgent();
    const writer = await deps.sink.open(runId);
    const input = this.live.get(runId);
    if (input !== undefined) {
      // An interrupt's message starts now; anything else queued pauses behind the Stop.
      await this.settleQueue(writer, input, runId, 'cancelled');
      await releaseThreadRun(this.store, input.threadId, runId);
    } else {
      this.cancelled.delete(runId);
    }
    // The last frame before a normal end: without it a reader cannot tell a truncated answer from
    // a complete one. Not an error — a client that retries a failed stream must not retry this.
    await writer.write({ t: 'event', event: { kind: 'cancelled' } });
    await writer.end();
  }

  private topLevelHooks(args: {
    runId: string;
    input: AgentRunInput;
    deps: AgentDeps;
    actor: Actor;
    day: string;
    /** This run's delegation chain with its own agent appended — see `AgentRunInput.delegationPath`. */
    chainBelow: readonly string[];
    /** How many delegations deep this run already is. */
    depth: number;
  }): AgentLoopHooks {
    const { runId, input, deps, actor, day, chainBelow, depth } = args;
    return {
      runId,
      durable: false,
      // The loop ends the stream when the turn completes. Just before, the thread passes to the next
      // queued message (or is released), and the reader is told which — so by the time a client sees
      // the run end, the thread is already free or already running what it queued.
      openSink: async () => {
        const writer = await deps.sink.open(runId);
        return this.queue === undefined
          ? writer
          : {
              write: (frame) => writer.write(frame),
              end: async () => {
                await this.settleQueue(writer, input, runId, 'completed');
                await writer.end();
              },
            };
      },
      cancelled: async () => this.cancelled.has(runId),
      ...this.humanHooks(runId),
      step: (_name, fn) => fn(),
      // Nothing here records a position, so a turn's read tools can simply overlap.
      parallel: settleAll,
      runAgent: (agentName, task) =>
        this.runNested({
          agentName,
          task,
          actor,
          day,
          depth: depth + 1,
          path: chainBelow,
          parentRunId: runId,
          // This run owns the stream a human subscribed to, so every delegation below it writes here.
          sinkRunId: runId,
        }),
    };
  }

  /**
   * The two waits a run parks on, keyed by the run that is parked. Identical for a top-level run and
   * for a delegated one: `signal(runId, …)` finds either, because the pending map belongs to the
   * runner rather than to a run.
   */
  private humanHooks(runId: string): Pick<AgentLoopHooks, 'awaitApproval' | 'awaitAnswers'> {
    return {
      awaitApproval: (call, _ctx, opts) =>
        // Run-namespaced key: `${runId}:${toolCallId}` — one run can't approve another's tool call.
        this.parkApproval(`${runId}:${call.id}`, opts?.timeoutMs),
      // An answer and an approval reach a parked run by the same channel, because a question set is
      // itself a `pending_approval` row: `POST /agent/tool-call/answer` and `/approve` both land here.
      awaitAnswers: (request: ElicitationRequest) => this.park(`${runId}:${request.id}`, 'answers'),
    };
  }

  /** Hold a run at `key` until a human's reply arrives through {@link InlineAgentRunner.signal}. */
  /**
   * {@link park} for an approval, bounded by the policy's time to live when it has one: the timer
   * settles the wait as `expired` — the same Decision the durable runner builds from its signal
   * timeout — and a decision that arrives first disarms it.
   */
  private parkApproval(key: string, timeoutMs?: number): Promise<Decision> {
    const waiting = this.park(key, 'approval') as Promise<Decision>;
    if (timeoutMs === undefined) {
      return waiting;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lapse = new Promise<Decision>((resolve) => {
      timer = setTimeout(() => {
        if (this.pending.delete(key)) {
          resolve({ approved: false, expired: true });
        }
      }, timeoutMs);
      // A parked request must not keep the process alive on its own.
      timer.unref?.();
    });
    return Promise.race([waiting, lapse]).finally(() => clearTimeout(timer));
  }

  private park(key: string, on: ParkedWait['on']): Promise<HumanReply> {
    return new Promise<HumanReply>((resolve, reject) => {
      this.pending.set(key, { on, resolve, reject });
    });
  }

  /** Delegate to another agent as a nested in-process run (a transient sub-thread). */
  private async runNested(args: {
    agentName: string;
    task: string;
    actor: Actor;
    day: string;
    /** How many delegations deep this child is. */
    depth: number;
    /** The chain that reached this child, root first — without its own name. */
    path: readonly string[];
    /** The run that asked for this one, recorded on its row so the delegation is not an orphan turn. */
    parentRunId: string;
    /** The TOP-LEVEL run whose live stream this one writes into — the only stream a human watches. */
    sinkRunId: string;
  }): Promise<{ text: string }> {
    const { agentName, task, actor, day, depth, path, parentRunId, sinkRunId } = args;
    const subThread = await this.store.createThread({ actor, persona: 'default', transient: true });
    const runId = crypto.randomUUID();
    const deps = this.factory.forAgent(agentName);
    const hooks: AgentLoopHooks = {
      runId,
      durable: false,
      // Forward into the ancestor's stream but never end it: the top-level run owns that lifecycle
      // across however many delegations it spans.
      openSink: async () => childSinkWriter(await deps.sink.open(sinkRunId)),
      // A delegated run parks on a human like any other, keyed by ITS OWN runId — which is the id
      // its pending row and its forwarded frames both carry, so the wait can be answered.
      ...this.humanHooks(runId),
      // A child stops when the run a human is actually watching is stopped.
      cancelled: async () => this.cancelled.has(sinkRunId),
      step: (_name, fn) => fn(),
      parallel: settleAll,
      runAgent: (childName, childTask) =>
        this.runNested({
          agentName: childName,
          task: childTask,
          actor,
          day,
          depth: depth + 1,
          path: [...path, agentName],
          parentRunId: runId,
          sinkRunId,
        }),
    };
    // A nested sub-agent run is its own trace (its own runId), rooted by the same turn span.
    return spannedAgent(
      'turn',
      runId,
      { runId },
      () =>
        runAgentLoop(
          { ...deps, day },
          {
            threadId: subThread.id,
            actor,
            userText: task,
            agentName,
            day,
            parentRunId,
            delegationDepth: depth,
            delegationPath: path,
          },
          hooks,
        ),
      (result) => ({ textLength: result.text.length }),
    );
  }
}
