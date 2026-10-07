import { BaseWorkflow, type WorkflowCtx, type WorkflowEngine } from '@adonis-agora/durable';
import type { HumanReply } from '../../elicitation.js';
import type { AgentRunInput, Decision } from '../../types.js';
import { errorText } from '../log.js';
import type { Milestone } from '../turn.js';
import type { OpenCodeTurns, SessionHandle } from '../turns.js';

export const OPENCODE_RUN_WORKFLOW = 'agora.agent.opencode.run';

/** The token a person's answer to `toolCallId` is signalled under — the library's own convention. */
export function decisionToken(runId: string, toolCallId: string): string {
  return `tool:${runId}:${toolCallId}`;
}

/**
 * A suspend / continue-as-new the runtime throws THROUGH the body — control flow, not a failure.
 * Recognised by name, so a second copy of `@adonis-agora/durable` (another class identity) still is.
 */
export function isControlFlowSignal(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'WorkflowSuspended' || name === 'ContinueAsNew';
}

/** The runtime's `SignalTimeoutError`, recognised by name for the same reason. */
function isSignalTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'SignalTimeoutError';
}

/**
 * An OpenCode turn as a durable workflow:
 *
 *   begin → prompt → observe:0 → [ wait for a person (signal `tool:<run>:<call>`) → reply:n → observe:n+1 ]* → finish
 *
 * Every step is checkpointed. A turn parked on a person is a suspended run with a signal waiter: an
 * app restart loses nothing, and the decision resumes it on whichever process takes it — replaying
 * the steps from their checkpoints and replying to OpenCode from there (`OpenCodeTurns` rebuilds the
 * live turn, and re-prompts a fresh session when OpenCode itself restarted meanwhile). A process
 * that dies while OpenCode works re-runs that `observe` step, which catches up on what OpenCode
 * asked while nobody listened.
 *
 * Built by the engine's factory with the turn steps (see `registerOpenCodeWorkflow`), not by the
 * container.
 */
export class OpenCodeRunWorkflow extends BaseWorkflow {
  static override workflow = { name: OPENCODE_RUN_WORKFLOW, version: '1' };

  constructor(
    private readonly turns: OpenCodeTurns,
    private readonly engine?: WorkflowEngine,
  ) {
    super();
  }

  async run(ctx: WorkflowCtx, input: AgentRunInput): Promise<{ outcome: string }> {
    const turns = this.turns;
    // `@adonis-agora/durable` >= 0.43.3 never runs one run twice at once in a process, so a step
    // that talks to OpenCode (a `reply`, an `observe`) runs once per execution of the run.
    const step = <T>(name: string, body: () => Promise<T>): Promise<T> => ctx.localStep(name, body);
    try {
      const begun = await step('begin', async () => ({
        handle: await turns.begin(ctx.runId, input, true),
        startedAt: Date.now(),
      }));
      let handle: SessionHandle = begun.handle;
      await step('prompt', async () => {
        await turns.prompt(ctx.runId, input, handle);
        return true;
      });
      for (let n = 0; ; n += 1) {
        const milestone: Milestone = await step(`observe:${n}`, () =>
          turns.observe(ctx.runId, input, handle),
        );
        if (milestone.kind === 'finished') {
          await step('finish', async () => {
            // A cancel settles the run itself (it may be parked where no step runs again).
            if (await this.cancelled(ctx.runId)) turns.drop(ctx.runId);
            else {
              await turns.settle(ctx.runId, input, milestone.outcome, Date.now() - begun.startedAt);
            }
            return true;
          });
          return { outcome: milestone.outcome.status };
        }
        let reply: HumanReply;
        try {
          reply = await ctx.waitForSignal<HumanReply>(
            decisionToken(ctx.runId, milestone.ask.id),
            milestone.timeoutMs !== undefined ? { timeoutMs: milestone.timeoutMs } : undefined,
          );
        } catch (error) {
          if (!isSignalTimeout(error)) throw error;
          reply = { approved: false, expired: true } satisfies Decision;
        }
        const ask = milestone.ask;
        handle = await step(`reply:${n}`, () => turns.reply(ctx.runId, input, handle, ask, reply));
      }
    } catch (error) {
      if (isControlFlowSignal(error)) throw error;
      await step('fail', async () => {
        await turns.settleFailed(ctx.runId, input, errorText(error, 'the turn failed'));
        return true;
      });
      return { outcome: 'failed' };
    }
  }

  private async cancelled(runId: string): Promise<boolean> {
    try {
      const status = (await this.engine?.getRun(runId))?.status as string | undefined;
      return status === 'cancelling' || status === 'cancelled';
    } catch {
      return false;
    }
  }
}
