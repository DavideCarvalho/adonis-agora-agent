import {
  BaseWorkflow,
  ContinueAsNew,
  type WorkflowCtx,
  WorkflowSuspended,
} from '@adonis-agora/durable';
import { utcDay } from '../agent-deps.js';
import { type AgentLoopHooks, delegatedRunHooks, runAgentLoop, settleAll } from '../agent-loop.js';
import type { HumanReply } from '../elicitation.js';
import { isReplayIntegrityError } from '../replay-integrity.js';
import type { SinkWriter } from '../spi/token-stream-sink.js';
import type { AgentRunInput, Decision } from '../types.js';
import { getDurableAgentContext } from './agent-run-context.js';

/**
 * The workflow input. A superset of {@link AgentRunInput} carrying the one field only the durable
 * runner threads: `sinkRunId`, the TOP-LEVEL run whose live stream this run writes into. A sub-agent
 * (child workflow) forwards its tokens into its ancestor's sink so the human watching the parent
 * sees the delegate's output; a top-level run leaves it unset (it owns its own sink, keyed by runId).
 */
export interface DurableAgentRunInput extends AgentRunInput {
  sinkRunId?: string;
}

/**
 * A control-flow signal (suspend / continue-as-new) the durable engine throws THROUGH the workflow
 * body to pause it — NOT a failure. `runAgentLoop` suspends by letting `ctx.waitForSignal` (HITL) or
 * `ctx.child` (delegation) throw here; the workflow's catch must re-throw it so the engine handles
 * it. Checked by `instanceof` AND by `name` so a duplicated copy of the durable module (whose class
 * identity differs) is still recognised.
 */
function isControlFlowSignal(error: unknown): boolean {
  if (error instanceof WorkflowSuspended || error instanceof ContinueAsNew) {
    return true;
  }
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'WorkflowSuspended' || name === 'ContinueAsNew';
}

/**
 * Identifies the loop shape to `ctx.patched`: a delegated child settles its own HITL waits and
 * therefore spends no signal position on them, where one recorded under the older shape holds a
 * `signal:tool:<runId>:<callId>` checkpoint it still has to replay against. Asked for only on a
 * child, so a top-level run's sequence is byte-identical either way.
 */
const DELEGATED_RUNS_SETTLE_HITL_PATCH = 'agent:delegated-runs-settle-hitl';

/**
 * Wrap a {@link SinkWriter} so a CHILD run forwards tokens into the top-level stream but never closes
 * it: the top-level run owns the stream's lifecycle across however many delegations it spans, so a
 * child's `end()` must be a no-op (ending the shared stream mid-parent-run would cut the human off).
 */
function childSinkWriter(inner: SinkWriter): SinkWriter {
  return {
    write: (chunk) => inner.write(chunk),
    end: () => {
      /* the top-level run owns end() */
    },
  };
}

/**
 * The agent turn AS a durable workflow — the replay-safe counterpart of `InlineAgentRunner`. The
 * shared `runAgentLoop` body drives model→tools→model exactly as inline; the durable hooks make it
 * suspend-and-resume:
 *  - `step(name, fn)` → `ctx.localStep` — every LLM turn, tool execution, and persist/quota write is a
 *    checkpoint, so a replay returns the cached result instead of re-running it (stable ids, no
 *    double-write, no re-streamed tokens). The run-tracing SPANS (`agora:agent:llm.turn` /
 *    `tool.execution` / `retrieval`) are emitted from INSIDE these step bodies, so a replay — which
 *    skips the bodies — never re-emits them. Unlike the inline runner, the durable workflow does NOT
 *    emit a body-level root `turn` span (the body replays, which would duplicate it); the trace is
 *    rooted implicitly by `traceId = runId`, which every child span already carries.
 *  - `awaitApproval(call)` / `awaitAnswers(request)` → `ctx.waitForSignal('tool:<runId>:<callId>')` —
 *    an action tool or a question set suspends the run with zero compute until an approve/reject or
 *    answers signal arrives (namespaced by run, so one run's reply can never satisfy another's).
 *    A DELEGATED run is the exception: nobody is watching a sub-agent's turn, so it settles its own
 *    waits through `delegatedRunHooks` instead of suspending on a signal nothing would send —
 *    the same behaviour the inline runner's nested loop has.
 *  - `runAgent(name, task)` → `ctx.child(AgentRunWorkflow, …)` — sub-agent delegation is a tracked,
 *    replay-safe CHILD run (a node in the durable dashboard) that streams into the top-level sink.
 *  - `openSink()` → the run's own sink writer (top-level) or a {@link childSinkWriter} (a child).
 *
 * Instantiated by the engine with no arguments; its deps come from {@link getDurableAgentContext}.
 */
export class AgentRunWorkflow extends BaseWorkflow {
  static override workflow = { name: 'agora.agent.run', version: '1' };

  async run(ctx: WorkflowCtx, input: DurableAgentRunInput): Promise<{ text: string }> {
    const { factory, store } = getDurableAgentContext();
    const day = input.day ?? utcDay();
    const deps = factory.forAgent(input.agentName);
    const isChild = input.sinkRunId !== undefined;
    const sinkRunId = input.sinkRunId ?? ctx.runId;
    // The chain this run sits on, with its own agent appended — what lets a child recognise a
    // delegation back to an agent the chain has already passed through. Derived from the workflow's
    // input, so it is the same on every replay and on every pod.
    const chainBelow = [
      ...(input.delegationPath ?? []),
      ...(input.agentName !== undefined ? [input.agentName] : []),
    ];
    // Whether this run's HITL waits reach a person. A DELEGATED run's do not — see
    // `delegatedRunHooks` — so it settles them itself, exactly as the inline runner's nested loop
    // does. The marker is only asked for on a child, so a top-level run's checkpoint sequence is
    // untouched; a child that suspended on a wait under the older shape answers `false` and keeps
    // replaying against the history it holds.
    const parkOnHuman = !isChild || !(await ctx.patched(DELEGATED_RUNS_SETTLE_HITL_PATCH));
    const humanHooks: Pick<AgentLoopHooks, 'awaitApproval' | 'awaitAnswers'> = parkOnHuman
      ? {
          // HITL: suspend until the run-namespaced signal arrives. This throw escapes the loop
          // cleanly — it happens BEFORE the loop's tool try/catch, so a suspend is never seen as a
          // tool failure.
          awaitApproval: (call) => ctx.waitForSignal<Decision>(`tool:${ctx.runId}:${call.id}`),
          // A question set parks on the SAME signal an approval does, under the tool call's own id
          // — so `POST /agent/tool-call/answer` and `/approve` are one delivery path, and a
          // deployment that only ever wired approval still settles an elicitation.
          awaitAnswers: (request) =>
            ctx.waitForSignal<HumanReply>(`tool:${ctx.runId}:${request.id}`),
        }
      : delegatedRunHooks();

    const hooks: AgentLoopHooks = {
      runId: ctx.runId,
      durable: true,
      ...humanHooks,
      // A child forwards into the top-level sink (so the human watching the parent sees it) but must
      // not end it; a top-level run opens and owns its own sink keyed by its runId.
      openSink: async () =>
        isChild ? childSinkWriter(await deps.sink.open(sinkRunId)) : deps.sink.open(ctx.runId),
      // Every side effect + control-flow read is a durable local step (memoized on replay).
      step: (name, fn) => ctx.localStep(name, fn),
      // Lets the tool transient-retry loop tell a real suspend/continue-as-new apart from a
      // retryable tool error, so a control-flow signal is never swallowed by a retry.
      isControlFlowError: isControlFlowSignal,
      // `ctx.localStep` takes its position on the CALL, before its first await, so a batch of tool
      // invocations launched in one tick occupies the positions in call order however they settle.
      // That is the whole precondition the loop asks for before overlapping anything.
      parallel: settleAll,
      // The version gate for in-place loop-shape changes, so a run that suspended under an older
      // shape replays against the shape its own history holds.
      patched: (id) => ctx.patched(id),
      // Delegation: a fresh transient subthread (checkpointed so its id is replay-stable), then a
      // tracked child run that streams into this run's own top-level sink.
      runAgent: async (agentName, task) => {
        const subThreadId = await ctx.localStep(`subthread:${agentName}`, async () => {
          const thread = await store.createThread({
            actor: input.actor,
            persona: 'default',
            transient: true,
          });
          return thread.id;
        });
        return ctx.child(AgentRunWorkflow, {
          agentName,
          threadId: subThreadId,
          actor: input.actor,
          userText: task,
          day,
          delegationDepth: (input.delegationDepth ?? 0) + 1,
          delegationPath: chainBelow,
          parentRunId: ctx.runId,
          sinkRunId,
        });
      },
    };

    try {
      return await runAgentLoop({ ...deps, day }, input, hooks);
    } catch (error) {
      // A suspend / continue-as-new is control flow, not a failure — let the engine handle it.
      if (isControlFlowSignal(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      // A replay-integrity failure gets the stream half of this path but NOT the checkpoint half.
      // The journal has already diverged, so `persist:run:fail` below would ask for a position the
      // history cannot supply and raise its own refusal — burying the one that names the checkpoints
      // that actually disagreed. The stream still has to be settled, or the subscriber hangs on a
      // run the engine is about to fail.
      if (isReplayIntegrityError(error)) {
        if (!isChild) {
          const writer = await deps.sink.open(ctx.runId);
          await writer.write({ t: 'text', v: `\n[error] ${message}` });
          await writer.end();
        }
        throw error;
      }
      // A real failure (e.g. quota exceeded, which throws before the sink is opened) would otherwise
      // leave an HTTP subscriber hanging on a stream that never ends. Surface it on the stream and
      // close it, then rethrow so the engine still records the run as failed. Only a top-level run
      // owns the stream — a child defers the surfaced error to its ancestor, which also unwinds.
      // Settle the run's persisted outcome (the loop only records completions — it can't catch its
      // own crash). A checkpointed step so a replay re-settles the ONE row idempotently; first-
      // terminal, so it can't clobber a completion. Each run (parent AND child) owns its own row.
      await ctx.localStep('persist:run:fail', () =>
        store.recordRunEnd({ runId: ctx.runId, status: 'failed', error: message }),
      );
      if (!isChild) {
        const writer = await deps.sink.open(ctx.runId);
        await writer.write({ t: 'text', v: `\n[error] ${message}` });
        await writer.end();
      }
      throw error;
    }
  }
}
