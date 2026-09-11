/**
 * Is this the durable runtime refusing a checkpoint position, rather than anything the agent did?
 *
 * Matched by NAME, and by suffix, because `@adonis-agora/durable` raises the same contract under two
 * class names: the in-process engine throws `NonDeterminismError` and the remote replay context
 * throws `WorkflowNondeterminismError`. Same cross-runtime reasoning as the `isControlFlowError`
 * hook, and as `isControlFlowSignal`'s name check, which exist for exactly this reason on the
 * suspend path.
 *
 * Callers must let these through untouched. Every `catch` in a workflow body reacts by writing more
 * checkpoints (a toolfail, a run-end), and on a journal that has already diverged each of those asks
 * for a position the history cannot supply — so the recovery attempt raises its own refusal, and
 * THAT is the error the operator reads: a message pointing at the wrong seq, naming checkpoints from
 * the recovery path rather than the two that actually disagreed.
 */
export function isReplayIntegrityError(error: unknown): boolean {
  return error instanceof Error && error.name.toLowerCase().endsWith('nondeterminismerror');
}
