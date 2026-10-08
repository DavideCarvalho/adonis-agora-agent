import * as durable from '@adonis-agora/durable';

/**
 * Run a checkpoint's BODY outside the ambient workflow ctx.
 *
 * The runtime keeps the running workflow's ctx in an `AsyncLocalStorage` for the whole turn, and a
 * `BaseWorkflow` static reads it to route: inside a workflow, `SomeWorkflow.dispatch(...)` becomes
 * `ctx.startChild` and `SomeWorkflow.start(...)` becomes `ctx.child` — each of which takes a
 * POSITION in the journal. That is right in a workflow body and wrong in a step body, and a step
 * body is where everything the application wrote runs: a tool's `execute`, a processor, a store. A
 * tool that starts a workflow of the app's own (directly, or through a service three calls down)
 * would record `spawn:<id>` at the position after its own `tool:<callId>`, from inside that step.
 * The first attempt then writes `persist:toolexec:<callId>` one position further on; a replay skips
 * the completed step's body, never asks for the spawn's position, and offers it to
 * `persist:toolexec:<callId>` instead — which the runtime refuses as non-determinism, failing a run
 * nothing had changed under. It only takes a resume after such a tool to get there: a second action
 * awaiting approval in the same step, or an approval in any later one.
 *
 * Outside the ambient ctx those statics go to the engine, as they do from a controller: the started
 * run is a run of its own, and the step memoizes the body's result so a replay never starts it
 * twice. Resolved off the namespace because `workflowAls` is not exported by every
 * `@adonis-agora/durable` this package accepts as a peer; a runtime without it has no ambient ctx
 * to leave.
 */
export const ambientWorkflowCtx = (durable as { workflowAls?: { exit<T>(fn: () => T): T } })
  .workflowAls;

export function outsideWorkflowCtx<T>(fn: () => Promise<T>): Promise<T> {
  return ambientWorkflowCtx === undefined ? fn() : ambientWorkflowCtx.exit(fn);
}
