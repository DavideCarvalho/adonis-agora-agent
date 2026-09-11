import type { WorkflowEngine } from '@adonis-agora/durable';
import { utcDay } from '../agent-deps.js';
import type { HumanReply } from '../elicitation.js';
import type { AgentRunner } from '../spi/agent-runner.js';
import type { AgentStore } from '../spi/agent-store.js';
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
  ) {}

  async start(input: AgentRunInput): Promise<{ runId: string }> {
    const stamped: DurableAgentRunInput = { ...input, day: input.day ?? utcDay() };
    // Own the run id so we can still return it when the run suspends synchronously on start (below).
    const runId = crypto.randomUUID();
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

  async cancel(runId: string): Promise<void> {
    // Best-effort: cascade cancellation to children and broadcast to the owning worker. A run that
    // already settled is a no-op. Errors are swallowed — cancel is advisory, not a guarantee.
    await this.engine.cancel(runId).catch(() => undefined);
    // Settle the persisted run `cancelled` (first-terminal: a run that already completed stays put).
    await this.store?.recordRunEnd({ runId, status: 'cancelled' }).catch(() => undefined);
  }
}
