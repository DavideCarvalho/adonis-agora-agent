import type { WorkflowEngine } from '@adonis-agora/durable';
import { utcDay } from '../agent-deps.js';
import { type ChatQueueService, isThreadTurn } from '../chat-queue-service.js';
import type { HumanReply } from '../elicitation.js';
import type { AgentRunner, AgentRunStartOptions } from '../spi/agent-runner.js';
import type { AgentStore } from '../spi/agent-store.js';
import { releaseThreadRun } from '../spi/chat-queue.js';
import type { TokenStreamSink } from '../spi/token-stream-sink.js';
import type { AgentRunInput } from '../types.js';
import { AgentRunWorkflow, type DurableAgentRunInput } from './agent-run-workflow.js';

/**
 * A control-flow signal surfaced out of `engine.start`. With the default in-process dispatcher the
 * body runs on a microtask AFTER `start` returns, so this never fires; but an app that configures a
 * DRIVING dispatcher (a durable worker/tenant) can surface the engine's internal suspend synchronously
 * here — expected control flow, NOT a start failure. Recognised by `name` so it survives a duplicated
 * durable module copy (whose class identity would differ).
 */
function isControlFlowSignal(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'WorkflowSuspended' || name === 'ContinueAsNew';
}

/**
 * Runs the agent turn as an `@adonis-agora/durable` workflow ({@link AgentRunWorkflow}) — the opt-in
 * runner (`durable: true`). `start` enqueues the run and returns its id immediately (a worker runs the
 * body and streams to the sink meanwhile); HITL approval is delivered as a durable signal namespaced
 * by run, so it can never cross-resolve another run. Mirrors the {@link InlineAgentRunner} interface.
 */
export class DurableAgentRunner implements AgentRunner {
  /**
   * `store` is optional so a bare `new DurableAgentRunner(engine)` still works; when passed (the
   * provider does), {@link cancel} settles the `agent_run` row `cancelled` for governance.
   */
  constructor(
    private readonly engine: WorkflowEngine,
    private readonly store?: AgentStore,
    /** The thread message queue — what a cancel hands the thread to. */
    private readonly queue?: ChatQueueService,
    /** Where a cancelled thread turn's stream is ended (`cancelled` frame, then the end). */
    private readonly sink?: TokenStreamSink,
  ) {}

  async start(
    input: AgentRunInput,
    options: AgentRunStartOptions = {},
  ): Promise<{ runId: string }> {
    const stamped: DurableAgentRunInput = { ...input, day: input.day ?? utcDay() };
    // Own the run id so we can still return it when the run suspends synchronously on start (below).
    // A caller-chosen id (a queued message's) makes the start idempotent: the engine answers a start
    // under an id it already has with that run, instead of starting a second one.
    const runId = options.runId ?? crypto.randomUUID();
    // Before the engine starts it: a run the engine drives synchronously could otherwise end (and
    // clear it) before it was set. The workflow clears it when the run ends.
    await this.store?.setActiveStream(input.threadId, runId);
    try {
      await this.engine.start(AgentRunWorkflow, stamped, runId);
    } catch (error) {
      // A run that suspends on its first step under a driving dispatcher surfaces a control-flow
      // signal here — the run is already persisted and a worker resumes it, so swallow it and return
      // the id; any other error is a real start failure and propagates.
      if (!isControlFlowSignal(error)) {
        throw error;
      }
    }
    return { runId };
  }

  async signal(runId: string, toolCallId: string, reply: HumanReply): Promise<void> {
    await this.engine.signal(`tool:${runId}:${toolCallId}`, reply);
  }

  /**
   * From the engine's own run row. A run it does not know yet counts as running — a queued turn is
   * claimed before its start lands — and so does one it cannot be asked about: only a run the engine
   * reports settled (`completed`/`failed`/`cancelled`/`dead`) is stale.
   */
  async isRunActive(runId: string): Promise<boolean> {
    try {
      const status = (await this.engine.getRun(runId))?.status;
      return !(
        status === 'completed' ||
        status === 'failed' ||
        status === 'cancelled' ||
        status === 'dead'
      );
    } catch {
      return true;
    }
  }

  async cancel(runId: string): Promise<void> {
    // What the run was started with, read before the cancel lands: which thread it holds.
    const input = await this.engine
      .getRun(runId)
      .then((run) => run?.input as Partial<DurableAgentRunInput> | undefined)
      .catch(() => undefined);
    // Best-effort: cascade cancellation to children and broadcast to the owning worker. A run that
    // already settled is a no-op. Errors are swallowed — cancel is advisory, not a guarantee.
    await this.engine.cancel(runId).catch(() => undefined);
    // Settle the persisted run `cancelled` (first-terminal: a run that already completed stays put).
    await this.store?.recordRunEnd({ runId, status: 'cancelled' }).catch(() => undefined);
    // A thread's own turn, cancelled from outside its body, never reaches its own settle: hand the
    // thread on here — an interrupt's message starts now, anything else queued pauses behind the
    // Stop — and free it. A sub-agent's run holds no thread of its own.
    const threadId = typeof input?.threadId === 'string' ? input.threadId : undefined;
    if (this.store === undefined || threadId === undefined || !isThreadTurn(input ?? {})) {
      return;
    }
    const writer = this.sink !== undefined ? await this.sink.open(runId) : undefined;
    if (this.queue?.supported === true) {
      try {
        const frame = await this.queue.handoff(
          { threadId, runId, outcome: 'cancelled' },
          (next, nextRunId) => this.start(next, { runId: nextRunId }),
        );
        if (frame !== undefined) {
          await writer?.write({ t: 'event', event: frame });
        }
      } catch (error) {
        console.error(
          `[@adonis-agora/agent] could not advance the queue of thread ${threadId} after cancelling ${runId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await releaseThreadRun(this.store, threadId, runId).catch(() => undefined);
    if (writer !== undefined) {
      // The last frame before the end: a reader can tell a stopped answer from a complete one.
      await writer.write({ t: 'event', event: { kind: 'cancelled' } });
      await writer.end();
    }
  }
}
