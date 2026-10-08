import type { WorkflowEngine } from '@adonis-agora/durable';
import { outsideWorkflowCtx } from './outside-workflow-ctx.js';

/**
 * Set going, in this process, what of `runId`'s tree waits for a worker: the run itself while it is
 * `pending`, and — while it is suspended on a delegation — the children it waits on, the same way.
 * Each through `engine.runOne`, which takes the run's lease first: a run another worker holds is left
 * to it, so a run still has exactly one executor. Returns once they are set going, not once they end;
 * an execution's failure is the run's own (`failed` on its row) and only logged here.
 *
 * `driving` holds the runs this process set going and has not seen end — one set per runner, so two
 * readers of one run do not both start it.
 *
 * Under a dispatcher that only persists a started run (a no-op one, with `durable:work` polling), a
 * caller that is itself a run of that worker — a channel job reading the turn it started — holds the
 * worker's tick: the turn would wait for the next tick, which waits for the caller.
 */
export async function drivePendingRuns(
  engine: WorkflowEngine,
  runId: string,
  driving: Set<string>,
  seen = new Set<string>(),
): Promise<void> {
  if (seen.has(runId)) return;
  seen.add(runId);
  const run = await engine.getRun(runId);
  if (run === null) return;
  if (run.status === 'pending') {
    if (driving.has(runId)) return;
    driving.add(runId);
    // The run executes as itself, not inside whatever run the caller is a step of.
    void outsideWorkflowCtx(() => engine.runOne(runId))
      .catch((error: unknown) => {
        console.error(
          `[@adonis-agora/agent] could not run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => driving.delete(runId));
    return;
  }
  // A run waiting on a delegate: the delegate (or one of its own) may be what is waiting.
  if (run.status !== 'suspended') return;
  for (const child of await engine.getRunChildren(runId))
    await drivePendingRuns(engine, child, driving, seen);
}
