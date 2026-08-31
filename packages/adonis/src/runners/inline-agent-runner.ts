import { type AgentDeps, utcDay } from '../agent-deps.js';
import type { AgentDepsFactory } from '../agent-deps-factory.js';
import { type AgentLoopHooks, runAgentLoop } from '../agent-loop.js';
import { spannedAgent } from '../diagnostics.js';
import type { AgentRunner } from '../spi/agent-runner.js';
import type { AgentStore } from '../spi/agent-store.js';
import type { Actor, AgentRunInput, Decision } from '../types.js';

/**
 * Runs the agent turn in-process — the default runner (`durable: false`). HITL approval resolves a
 * pending promise keyed run-namespaced by `${runId}:${toolCallId}`, so one run's decision can never
 * satisfy another's pending action. Sub-agent delegation runs a nested loop; a nested sub-agent has
 * no human to prompt, so its action tools are auto-declined rather than hang. Single-replica only —
 * durable is the scaled path (deferred).
 */
export class InlineAgentRunner implements AgentRunner {
  private readonly pending = new Map<string, (decision: Decision) => void>();

  constructor(
    private readonly factory: AgentDepsFactory,
    private readonly store: AgentStore,
  ) {}

  async start(input: AgentRunInput): Promise<{ runId: string }> {
    const runId = crypto.randomUUID();
    const day = input.day ?? utcDay();
    const deps = this.factory.forAgent(input.agentName);
    const hooks = this.topLevelHooks(runId, deps, input.actor, day);

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

  async signal(runId: string, toolCallId: string, decision: Decision): Promise<void> {
    const key = `${runId}:${toolCallId}`;
    const resolve = this.pending.get(key);
    if (resolve !== undefined) {
      this.pending.delete(key);
      resolve(decision);
    }
  }

  async cancel(runId: string): Promise<void> {
    // Best-effort: settle the run `cancelled` (first-terminal, so a completed run stays completed),
    // then close the live stream so a subscriber isn't left hanging.
    await this.store.recordRunEnd({ runId, status: 'cancelled' });
    const deps = this.factory.forAgent();
    const writer = await deps.sink.open(runId);
    await writer.end();
  }

  private topLevelHooks(runId: string, deps: AgentDeps, actor: Actor, day: string): AgentLoopHooks {
    return {
      runId,
      durable: false,
      openSink: () => deps.sink.open(runId),
      awaitApproval: (call) =>
        new Promise<Decision>((resolve) => {
          // Run-namespaced key: `${runId}:${toolCallId}` — one run can't approve another's tool call.
          this.pending.set(`${runId}:${call.id}`, resolve);
        }),
      step: (_name, fn) => fn(),
      runAgent: (agentName, task) => this.runNested(agentName, task, actor, day),
    };
  }

  /** Delegate to another agent as a nested in-process run (a transient sub-thread). */
  private async runNested(
    agentName: string,
    task: string,
    actor: Actor,
    day: string,
  ): Promise<{ text: string }> {
    const subThread = await this.store.createThread({ actor, persona: 'default', transient: true });
    const runId = crypto.randomUUID();
    const deps = this.factory.forAgent(agentName);
    const hooks: AgentLoopHooks = {
      runId,
      durable: false,
      openSink: () => deps.sink.open(runId),
      // A nested sub-agent has no human to ask — decline action tools rather than hang.
      awaitApproval: async () => ({
        approved: false,
        reason: 'nested sub-agent cannot request human approval',
      }),
      step: (_name, fn) => fn(),
      runAgent: (childName, childTask) => this.runNested(childName, childTask, actor, day),
    };
    // A nested sub-agent run is its own trace (its own runId), rooted by the same turn span.
    return spannedAgent(
      'turn',
      runId,
      { runId },
      () =>
        runAgentLoop(
          { ...deps, day },
          { threadId: subThread.id, actor, userText: task, agentName, day },
          hooks,
        ),
      (result) => ({ textLength: result.text.length }),
    );
  }
}
