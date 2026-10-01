import * as durable from '@adonis-agora/durable';
import {
  BaseWorkflow,
  ContinueAsNew,
  type WorkflowCtx,
  WorkflowSuspended,
} from '@adonis-agora/durable';
import { utcDay } from '../agent-deps.js';
import {
  type AgentLoopHooks,
  RunCancelledError,
  runAgentLoop,
  settleAll,
  streamErrorFrame,
} from '../agent-loop.js';
import type { QueuePlan, QueueSettleOutcome } from '../chat-queue-service.js';
import { RUN_ENDED_BEFORE_TOOL_CALL } from '../dangling-tool-calls.js';
import { settleDeadRun } from '../dead-run.js';
import { settleUnsettledDelegation } from '../delegation.js';
import type { HumanReply } from '../elicitation.js';
import { isReplayIntegrityError } from '../replay-integrity.js';
import { isChatQueueStore, releaseThreadRun } from '../spi/chat-queue.js';
import { childSinkWriter } from '../spi/token-stream-sink.js';
import type { AgentStreamEvent } from '../stream-events.js';
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
/**
 * The runtime's `SignalTimeoutError`, recognized by NAME: the class can differ between a bundled and
 * a hoisted copy of `@adonis-agora/durable`, so `instanceof` against one import would miss the other.
 */
function isSignalTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'SignalTimeoutError';
}

function isControlFlowSignal(error: unknown): boolean {
  if (error instanceof WorkflowSuspended || error instanceof ContinueAsNew) {
    return true;
  }
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'WorkflowSuspended' || name === 'ContinueAsNew';
}

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
const ambientWorkflowCtx = (durable as { workflowAls?: { exit<T>(fn: () => T): T } }).workflowAls;

function outsideWorkflowCtx<T>(fn: () => Promise<T>): Promise<T> {
  return ambientWorkflowCtx === undefined ? fn() : ambientWorkflowCtx.exit(fn);
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
 *    A DELEGATED run suspends the same way, on its own runId — which is what `sinkRunId` exists for:
 *    its frames land in the stream the human is already watching and carry that runId, so a
 *    sub-agent's own HITL wait can be seen, and therefore answered.
 *  - `runAgent(name, task)` → `ctx.child(AgentRunWorkflow, …)` — sub-agent delegation is a tracked,
 *    replay-safe CHILD run (a node in the durable dashboard) that streams into the top-level sink.
 *  - `startAgent(…)` → `ctx.startChild(AgentRunWorkflow, …)` — a DETACHED delegation: a `spawn:`
 *    position and no suspend, so the turn ends with a receipt; the child owns its own stream and
 *    posts its answer into the delegating thread (`deliverTo`).
 *  - `openSink()` → the run's own sink writer (top-level) or a {@link childSinkWriter} (a child).
 *
 * Instantiated by the engine with no arguments; its deps come from {@link getDurableAgentContext}.
 */
export class AgentRunWorkflow extends BaseWorkflow {
  static override workflow = { name: 'agora.agent.run', version: '1' };

  async run(ctx: WorkflowCtx, input: DurableAgentRunInput): Promise<{ text: string }> {
    const { factory, store, queue } = getDurableAgentContext();
    const day = input.day ?? utcDay();
    const deps = factory.forAgent(input.agentName);
    // Three shapes of run, told apart by their input alone (so every replay and every pod agrees):
    //   - a thread's own turn: owns its stream, its thread and the thread's queue;
    //   - an awaited delegate (`sinkRunId`): forwards into its ancestor's stream, owns none of it;
    //   - a DETACHED delegate (`deliverTo`): owns its stream (nobody is watching the turn that started
    //     it any more), but no thread turn of anyone's — it runs on a scratch thread and posts its
    //     answer into the delegating one (`deliver:detached`, in the loop).
    const isChild = input.sinkRunId !== undefined;
    const detached = !isChild && input.deliverTo !== undefined;
    const ownsThread = !isChild && !detached;
    const sinkRunId = input.sinkRunId ?? ctx.runId;
    // Every checkpoint this workflow writes. The body runs outside the ambient workflow ctx, so
    // nothing the application does in there — a tool dispatching a workflow of its own, a store, a
    // quota provider — can take a position in this run's journal (see {@link outsideWorkflowCtx}).
    const step = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
      ctx.localStep(name, () => outsideWorkflowCtx(fn));
    /**
     * Move the thread past this settling turn — to the next queued message, started here as a
     * fire-and-forget `ctx.startChild` under the message's own id, or to a paused/empty queue — and
     * answer the `queue` frame to write before the turn's terminal.
     *
     * Journaled: the decision (which message, claimed and popped) is one `localStep`, so a replay
     * reads it back instead of popping a second message, and the start is the runtime's own
     * replay-safe spawn. Gated by `ctx.patched`, so a run recorded before the queue existed replays
     * against the history it has. A no-op for a sub-agent's run and on a store without a queue.
     */
    const advanceQueue = async (
      outcome: QueueSettleOutcome,
      error?: string,
    ): Promise<AgentStreamEvent | undefined> => {
      if (queue === undefined || !queue.supported || !ownsThread) {
        return undefined;
      }
      if (!(await ctx.patched('agent:chat-queue'))) {
        return undefined;
      }
      const plan = await step(`queue:${outcome}`, async (): Promise<QueuePlan> => {
        try {
          return await queue.plan({
            threadId: input.threadId,
            runId: ctx.runId,
            outcome,
            ...(error !== undefined ? { error } : {}),
          });
        } catch {
          // Not worth failing a settling turn over: the queue is picked up by the next send or
          // resume on the thread.
          return {};
        }
      });
      const next = plan.next;
      if (next === undefined) {
        return plan.frame;
      }
      try {
        await ctx.startChild(AgentRunWorkflow, next.input, next.runId);
        return plan.frame;
      } catch (failure) {
        if (isControlFlowSignal(failure)) {
          throw failure;
        }
        const reason = failure instanceof Error ? failure.message : String(failure);
        return step('queue:restore', async () => {
          await queue.restore(input.threadId, next, 'start_failed', reason);
          return queue.pausedFrame(input.threadId);
        });
      }
    };
    // The chain this run sits on, with its own agent appended — what lets a child recognise a
    // delegation back to an agent the chain has already passed through. Derived from the workflow's
    // input, so it is the same on every replay and on every pod.
    const chainBelow = [
      ...(input.delegationPath ?? []),
      ...(input.agentName !== undefined ? [input.agentName] : []),
    ];
    const hooks: AgentLoopHooks = {
      runId: ctx.runId,
      durable: true,
      // HITL: suspend until the run-namespaced signal arrives. This throw escapes the loop cleanly —
      // it happens BEFORE the loop's tool try/catch, so a suspend is never seen as a tool failure.
      // A DELEGATED run suspends on its OWN runId, and that wait is answerable: the pending row it
      // writes carries that runId, and so does the `elicitation` frame it forwards into the stream
      // the human is already watching.
      // A policy's time to live becomes the signal wait's own timeout: the runtime journals the
      // deadline on the first call (reached only for a call the journal says has a ttl) and wakes
      // the run when it passes. The lapse comes back as a Decision rather than a throw, so the loop
      // settles the call `expired` on its ordinary rejection checkpoint.
      awaitApproval: (call, _toolCtx, opts) =>
        opts?.timeoutMs === undefined
          ? ctx.waitForSignal<Decision>(`tool:${ctx.runId}:${call.id}`)
          : ctx
              .waitForSignal<Decision>(`tool:${ctx.runId}:${call.id}`, {
                timeoutMs: opts.timeoutMs,
              })
              .catch((error: unknown) => {
                if (isSignalTimeout(error)) {
                  return { approved: false, expired: true } satisfies Decision;
                }
                throw error;
              }),
      // A question set parks on the SAME signal an approval does, under the tool call's own id — so
      // `POST /agent/tool-call/answer` and `/approve` are one delivery path, and a deployment that
      // only ever wired approval still settles an elicitation.
      awaitAnswers: (request) => ctx.waitForSignal<HumanReply>(`tool:${ctx.runId}:${request.id}`),
      // A child forwards into the top-level sink (so the human watching the parent sees it) but must
      // not end it; a top-level run opens and owns its own sink keyed by its runId.
      // A thread's own turn hands the thread to its queue just before the loop ends the stream, so
      // the reader learns what runs next from the `queue` frame, before the end.
      openSink: async () => {
        if (isChild) {
          return childSinkWriter(await deps.sink.open(sinkRunId));
        }
        const writer = await deps.sink.open(ctx.runId);
        return {
          write: (frame) => writer.write(frame),
          end: async () => {
            const frame = await advanceQueue('completed');
            if (frame !== undefined) {
              await writer.write({ t: 'event', event: frame });
            }
            await writer.end();
          },
        };
      },
      // Every side effect + control-flow read is a durable local step (memoized on replay).
      step,
      // A thread's own turn that no longer holds its thread was stopped from outside its body (a
      // Stop, or an interrupt that already started the next message): it must not write an answer
      // after whatever took its place. Asked live, only where the queue's compare-and-set admission
      // is in force — there a run holds its thread from its claim to its own settle, on every replay.
      ...(queue?.supported === true && ownsThread && isChatQueueStore(store)
        ? {
            cancelled: async () => (await store.activeRunForThread(input.threadId)) !== ctx.runId,
          }
        : {}),
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
        const subThreadId = await step(`subthread:${agentName}`, async () => {
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
      // The same delegation, not awaited: `ctx.startChild` records `spawn:<childRunId>` at this
      // position and returns, so THIS turn ends while the child is still working. It is reached from
      // the loop BODY (never inside a `step`), only for a call whose `persist:toolcall` journaled
      // `detached` — which no run recorded before this existed — so a parked run's positions are the
      // ones it always had. Two things the awaited form does are left off on purpose:
      //   - no `sinkRunId`: a detached run owns its own stream. Forwarding into the turn that started it
      //     would write tokens (and an approval card) into a stream whose reader already saw it end.
      //     Its approvals reach the inbox anyway: the call is persisted `pending_approval` under the
      //     child's OWN runId, which is what `tool-call/approve` resolves a decision to.
      //   - `deliverTo` instead: the parent's tool result is a receipt, so the answer needs an address
      //     of its own, and by the time it exists nobody else is holding one.
      startAgent: async ({ agentName, task, toolCallId }) => {
        const subThreadId = await step(`subthread:${agentName}`, async () => {
          const thread = await store.createThread({
            actor: input.actor,
            persona: 'default',
            transient: true,
          });
          return thread.id;
        });
        const childRunId = await ctx.startChild(AgentRunWorkflow, {
          agentName,
          threadId: subThreadId,
          actor: input.actor,
          userText: task,
          day,
          delegationDepth: (input.delegationDepth ?? 0) + 1,
          delegationPath: chainBelow,
          parentRunId: ctx.runId,
          deliverTo: { threadId: input.threadId, toolCallId },
        } satisfies DurableAgentRunInput);
        return { runId: childRunId };
      },
    };
    /**
     * Settle the delegation a DETACHED run was started for, when it ends without an answer. The loop
     * delivers its own success (`deliver:detached`) but cannot catch its own crash; left alone, the
     * card in the delegating conversation says "started" for ever. A checkpoint of its own, reached
     * only on a detached run's failure path — a position no other run has.
     */
    const settleDetached = async (error: string): Promise<void> => {
      const delivery = input.deliverTo;
      if (!detached || delivery === undefined) {
        return;
      }
      await step('deliver:detached:unsettled', () =>
        settleUnsettledDelegation({
          store,
          delivery,
          agent: input.agentName ?? 'default',
          runId: ctx.runId,
          status: 'failed',
          error,
        }),
      );
    };

    try {
      const result = await runAgentLoop({ ...deps, day }, input, hooks);
      // The top-level run owns the thread's active-run pointer (a child runs on a scratch thread).
      if (ownsThread) {
        // Conditional: a turn that handed the thread to the next queued message must not clear it.
        await step('deactivate', () => releaseThreadRun(store, input.threadId, ctx.runId));
      }
      return result;
    } catch (error) {
      // A suspend / continue-as-new is control flow, not a failure — let the engine handle it.
      if (isControlFlowSignal(error)) {
        throw error;
      }
      // Stopped from outside (see `cancelled` above): whoever stopped it already settled the run's
      // row, its thread and its stream. Nothing to record, and nothing of this turn to keep.
      if (error instanceof RunCancelledError) {
        return { text: '' };
      }
      const message = error instanceof Error ? error.message : String(error);
      // A replay-integrity failure gets the stream half of this path but NOT the checkpoint half.
      // The journal has already diverged, so `persist:run:fail` below would ask for a position the
      // history cannot supply and raise its own refusal — burying the one that names the checkpoints
      // that actually disagreed. The stream still has to be settled, or the subscriber hangs on a
      // run the engine is about to fail.
      if (isReplayIntegrityError(error)) {
        // What the checkpoints below would have settled, written straight to the store instead: the
        // run's row, the calls it left awaiting a decision, and — for a thread's own turn — the
        // thread, so the next message starts a turn instead of queueing behind a run that is gone.
        await settleDeadRun(store, {
          runId: ctx.runId,
          error: message,
          ...(ownsThread ? { threadId: input.threadId } : {}),
        });
        if (detached && input.deliverTo !== undefined) {
          // Straight to the store, like the rest of this branch: the journal has no room left.
          // Idempotent by itself (a thread already holding this run's message is left alone).
          await settleUnsettledDelegation({
            store,
            delivery: input.deliverTo,
            agent: input.agentName ?? 'default',
            runId: ctx.runId,
            status: 'failed',
            error: message,
          }).catch(() => undefined);
        }
        if (!isChild) {
          const writer = await deps.sink.open(ctx.runId);
          await writer.write(streamErrorFrame(error, ctx.runId));
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
      await step('persist:run:fail', async () => {
        await store.recordRunEnd({ runId: ctx.runId, status: 'failed', error: message });
        // A call this run had put to a person is not waiting for anything any more. Inside the same
        // checkpoint, so it adds no position to a failing run's journal.
        await store.failUnsettledToolCalls?.(ctx.runId, RUN_ENDED_BEFORE_TOOL_CALL).catch(() => 0);
      });
      if (ownsThread) {
        // The queue behind a failed turn pauses — its next message would likely fail the same way.
        const queueFrame = await advanceQueue('failed', message);
        await step('deactivate', () => releaseThreadRun(store, input.threadId, ctx.runId));
        const writer = await deps.sink.open(ctx.runId);
        if (queueFrame !== undefined) {
          await writer.write({ t: 'event', event: queueFrame });
        }
        await writer.write(streamErrorFrame(error, ctx.runId));
        await writer.end();
      } else if (detached) {
        // Tell the delegating thread, then end the run's own stream like a thread turn would.
        await settleDetached(message);
        const writer = await deps.sink.open(ctx.runId);
        await writer.write(streamErrorFrame(error, ctx.runId));
        await writer.end();
      }
      throw error;
    }
  }
}
