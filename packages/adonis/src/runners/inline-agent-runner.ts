import { type AgentDeps, utcDay } from '../agent-deps.js';
import type { AgentDepsFactory } from '../agent-deps-factory.js';
import { type AgentLoopHooks, delegatedRunHooks, runAgentLoop, settleAll } from '../agent-loop.js';
import { spannedAgent } from '../diagnostics.js';
import {
  type ElicitationRequest,
  type HumanReply,
  HumanReplyMismatchError,
  isHumanDecision,
} from '../elicitation.js';
import type { AgentRunner } from '../spi/agent-runner.js';
import type { AgentStore } from '../spi/agent-store.js';
import type { Actor, AgentRunInput, Decision } from '../types.js';

/**
 * A run held at one wait, and WHICH wait — an `action`'s approve/reject, or a question set's
 * answers. Both arrive through `signal`, so the kind is what lets a reply of the wrong shape be
 * refused instead of settling a wait it says nothing about.
 */
interface ParkedWait {
  on: 'approval' | 'answers';
  resolve: (reply: HumanReply) => void;
}

/**
 * Runs the agent turn in-process — the default runner (`durable: false`). A HITL wait resolves a
 * pending promise keyed run-namespaced by `${runId}:${toolCallId}`, so one run's reply can never
 * satisfy another's pending action. Sub-agent delegation runs a nested loop under
 * {@link delegatedRunHooks}, because a nested sub-agent has no human to prompt. Single-replica only
 * — durable is the scaled path (deferred).
 */
export class InlineAgentRunner implements AgentRunner {
  private readonly pending = new Map<string, ParkedWait>();

  constructor(
    private readonly factory: AgentDepsFactory,
    private readonly store: AgentStore,
  ) {}

  async start(input: AgentRunInput): Promise<{ runId: string }> {
    const runId = crypto.randomUUID();
    const day = input.day ?? utcDay();
    const deps = this.factory.forAgent(input.agentName);
    const hooks = this.topLevelHooks({
      runId,
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
    void spannedAgent(
      'turn',
      runId,
      { runId },
      () => runAgentLoop({ ...deps, day }, input, hooks),
      (result) => ({ textLength: result.text.length }),
    ).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[@adonis-agora/agent] run ${runId} failed: ${message}`);
      // Settle the run's persisted outcome — the loop only records completions (it can't catch its
      // own crash). First-terminal, so this can't clobber a completion that already landed.
      await this.store.recordRunEnd({ runId, status: 'failed', error: message });
      // Surface the failure on the live stream and close it, so a subscriber isn't left hanging.
      const writer = await deps.sink.open(runId);
      await writer.write({ t: 'text', v: `\n[error] ${message}` });
      await writer.end();
    });

    return { runId };
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
    // Best-effort: settle the run `cancelled` (first-terminal, so a completed run stays completed),
    // then close the live stream so a subscriber isn't left hanging.
    await this.store.recordRunEnd({ runId, status: 'cancelled' });
    const deps = this.factory.forAgent();
    const writer = await deps.sink.open(runId);
    await writer.end();
  }

  private topLevelHooks(args: {
    runId: string;
    deps: AgentDeps;
    actor: Actor;
    day: string;
    /** This run's delegation chain with its own agent appended — see `AgentRunInput.delegationPath`. */
    chainBelow: readonly string[];
    /** How many delegations deep this run already is. */
    depth: number;
  }): AgentLoopHooks {
    const { runId, deps, actor, day, chainBelow, depth } = args;
    return {
      runId,
      durable: false,
      openSink: () => deps.sink.open(runId),
      awaitApproval: (call) =>
        // Run-namespaced key: `${runId}:${toolCallId}` — one run can't approve another's tool call.
        this.park(`${runId}:${call.id}`, 'approval') as Promise<Decision>,
      // An answer and an approval reach a parked run by the same channel, because a question set is
      // itself a `pending_approval` row: `POST /agent/tool-call/answer` and `/approve` both land here.
      awaitAnswers: (request: ElicitationRequest) => this.park(`${runId}:${request.id}`, 'answers'),
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
        }),
    };
  }

  /** Hold a run at `key` until a human's reply arrives through {@link InlineAgentRunner.signal}. */
  private park(key: string, on: ParkedWait['on']): Promise<HumanReply> {
    return new Promise<HumanReply>((resolve) => {
      this.pending.set(key, { on, resolve });
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
  }): Promise<{ text: string }> {
    const { agentName, task, actor, day, depth, path, parentRunId } = args;
    const subThread = await this.store.createThread({ actor, persona: 'default', transient: true });
    const runId = crypto.randomUUID();
    const deps = this.factory.forAgent(agentName);
    const hooks: AgentLoopHooks = {
      runId,
      durable: false,
      openSink: () => deps.sink.open(runId),
      ...delegatedRunHooks(),
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
