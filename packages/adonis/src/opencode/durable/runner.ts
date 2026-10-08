import { randomUUID } from 'node:crypto';
import type { StartOptions, WorkflowEngine } from '@adonis-agora/durable';
import { drivePendingRuns } from '../../durable/drive-pending-runs.js';
import type { HumanReply } from '../../elicitation.js';
import type { AgentRunner, AgentRunStartOptions } from '../../spi/agent-runner.js';
import type { AgentStore } from '../../spi/agent-store.js';
import type { AgentRunInput } from '../../types.js';
import type { OpenCodeHost } from '../host.js';
import { openCodeLog } from '../log.js';
import type { OpenCodeTurns } from '../turns.js';
import { decisionToken, isControlFlowSignal, OpenCodeRunWorkflow } from './workflow.js';

function isRunInput(value: unknown): value is AgentRunInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AgentRunInput).threadId === 'string' &&
    typeof (value as AgentRunInput).actor === 'object'
  );
}

const SETTLED = new Set(['completed', 'failed', 'cancelled', 'dead']);

/**
 * Runs OpenCode turns as `@adonis-agora/durable` workflows ({@link OpenCodeRunWorkflow}): a person's
 * decision is a durable signal, so a turn waiting on one survives restarts and is resumed by
 * whichever process receives it. Needs a cross-process sink when more than one process serves the
 * agent (`tokenSinks.redis()` / `tokenSinks.lucid()`).
 */
export class DurableOpenCodeAgentRunner implements AgentRunner {
  constructor(
    private readonly engine: WorkflowEngine,
    private readonly turns: OpenCodeTurns,
    private readonly host: OpenCodeHost,
    private readonly store: AgentStore,
  ) {
    turns.startNext = (next, runId) => this.start(next, { runId });
  }

  runIdFor(input: AgentRunInput): string {
    return this.turns.settings.runId?.(input) ?? randomUUID();
  }

  async start(
    input: AgentRunInput,
    options: AgentRunStartOptions = {},
  ): Promise<{ runId: string }> {
    const runId = options.runId ?? this.runIdFor(input);
    const durable = this.turns.settings.durable;
    const startOptions = {
      ...((await durable?.start?.(input, runId)) ?? {}),
      ...((await this.host.startOptions?.(input, runId)) ?? {}),
    } as StartOptions;
    // Before the engine starts it: a run the engine drives synchronously could otherwise end (and
    // clear it) before it was set.
    await this.store.setActiveStream(input.threadId, runId);
    try {
      await this.engine.start(OpenCodeRunWorkflow, input, runId, startOptions);
    } catch (error) {
      // A run that suspends on its first step under a driving dispatcher surfaces the runtime's
      // suspend signal here: the run is persisted and will be resumed, not failed.
      if (isControlFlowSignal(error)) return { runId };
      throw this.host.startError?.(error, input) ?? durable?.startError?.(error, input) ?? error;
    }
    return { runId };
  }

  /**
   * From the engine's run row. A run it does not know yet counts as running (a queued turn is
   * claimed before its start lands), and so does one it cannot be asked about.
   */
  async isRunActive(runId: string): Promise<boolean> {
    try {
      const status = (await this.engine.getRun(runId))?.status;
      return status === undefined || !SETTLED.has(status);
    } catch {
      return true;
    }
  }

  async signal(runId: string, toolCallId: string, reply: HumanReply): Promise<void> {
    await this.engine.signal(decisionToken(runId, toolCallId), reply);
  }

  /** The runs {@link drive} set going that have not ended yet. */
  private readonly driving = new Set<string>();

  /** Lease and execute here what of `runId` is still pending — see `drivePendingRuns`. */
  async drive(runId: string): Promise<void> {
    await drivePendingRuns(this.engine, runId, this.driving);
  }

  /**
   * Interrupt OpenCode, cancel the run in the runtime (a run parked on a person never runs its body
   * again), and settle it here: the queue, the thread, the `cancelled` frame and the run row.
   */
  async cancel(runId: string): Promise<void> {
    const run = await this.engine.getRun(runId).catch(() => null);
    if (run === null || run === undefined || SETTLED.has(run.status)) return;
    const input = run.input;
    if (isRunInput(input)) await this.turns.interrupt(input).catch(() => undefined);
    await this.engine.cancel(runId).catch((error: unknown) => {
      openCodeLog.warn(`could not cancel run ${runId}: ${(error as Error).message}`);
    });
    if (isRunInput(input)) await this.turns.settle(runId, input, { status: 'interrupted' }, 0);
  }
}
