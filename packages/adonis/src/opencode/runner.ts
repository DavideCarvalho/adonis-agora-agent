import { RunCancelledError } from '../agent-loop.js';
import { type HumanReply, HumanReplyMismatchError, isHumanDecision } from '../elicitation.js';
import type { AgentRunner, AgentRunStartOptions } from '../spi/agent-runner.js';
import type { AgentStore } from '../spi/agent-store.js';
import type { AgentRunInput, Decision } from '../types.js';
import { errorText } from './log.js';
import { addUsage, emptyUsage } from './turn.js';
import type { OpenCodeTurns } from './turns.js';

interface Parked {
  on: 'approval' | 'answers';
  resolve: (reply: HumanReply) => void;
  reject: (error: unknown) => void;
}

/**
 * Runs OpenCode turns in this process: `begin → prompt → [observe → wait for a person → reply]* →
 * settle`, with the waits on people held in memory. Like `InlineAgentRunner`, a run parked on a
 * person lives in this process, so deploy it single-replica — or use `openCodeDurable()`
 * (`@adonis-agora/agent/opencode/durable`), which checkpoints every step and waits on a durable
 * signal.
 */
export class OpenCodeAgentRunner implements AgentRunner {
  private readonly live = new Map<string, AgentRunInput>();
  private readonly cancelled = new Set<string>();
  private readonly pending = new Map<string, Parked>();

  constructor(
    private readonly turns: OpenCodeTurns,
    private readonly store: AgentStore,
  ) {
    turns.startNext = (next, runId) => this.start(next, { runId });
  }

  runIdFor(input: AgentRunInput): string {
    return this.turns.settings.runId?.(input) ?? crypto.randomUUID();
  }

  /** In-process, so exact: a run this process is not running is not running anywhere. */
  async isRunActive(runId: string): Promise<boolean> {
    if (this.live.has(runId)) return true;
    for (const key of this.pending.keys()) if (key.startsWith(`${runId}:`)) return true;
    return false;
  }

  async start(
    input: AgentRunInput,
    options: AgentRunStartOptions = {},
  ): Promise<{ runId: string }> {
    const runId = options.runId ?? this.runIdFor(input);
    // Before the turn starts: a fast turn could otherwise end (and clear it) before it was set.
    await this.store.setActiveStream(input.threadId, runId);
    this.live.set(runId, input);
    void this.run(runId, input).finally(() => {
      this.live.delete(runId);
      this.cancelled.delete(runId);
      for (const key of [...this.pending.keys()]) {
        if (key.startsWith(`${runId}:`)) this.pending.delete(key);
      }
    });
    return { runId };
  }

  /**
   * Deliver a person's reply. Answers addressed at an approval are refused, as the inline runner
   * refuses them: they say nothing about whether the action should run.
   */
  async signal(runId: string, toolCallId: string, reply: HumanReply): Promise<void> {
    const key = `${runId}:${toolCallId}`;
    const parked = this.pending.get(key);
    if (parked === undefined) return;
    if (parked.on === 'approval' && !isHumanDecision(reply)) {
      throw new HumanReplyMismatchError(runId, toolCallId);
    }
    this.pending.delete(key);
    parked.resolve(reply);
  }

  /**
   * Stop the run: what it waits on a person for is dropped, and OpenCode is interrupted — it answers
   * `session.execution.interrupted`, which settles the run as cancelled.
   */
  async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
    for (const [key, parked] of [...this.pending]) {
      if (!key.startsWith(`${runId}:`)) continue;
      this.pending.delete(key);
      parked.reject(new RunCancelledError());
    }
    const input = this.live.get(runId);
    if (input !== undefined) await this.turns.interrupt(input).catch(() => undefined);
  }

  private async run(runId: string, input: AgentRunInput): Promise<void> {
    const started = Date.now();
    // What the run spent, milestone by milestone.
    let spent = emptyUsage();
    try {
      let handle = await this.turns.begin(runId, input);
      if (this.cancelled.has(runId)) throw new RunCancelledError();
      await this.turns.prompt(runId, input, handle, spent);
      for (;;) {
        const milestone = await this.turns.observe(runId, input, handle, spent);
        spent = addUsage(spent, milestone.usage);
        if (milestone.kind === 'finished') {
          await this.turns.settle(runId, input, milestone.outcome, Date.now() - started, spent);
          return;
        }
        const reply = await this.park(
          runId,
          milestone.ask.id,
          milestone.ask.kind === 'approval' ? 'approval' : 'answers',
          milestone.timeoutMs,
        );
        handle = await this.turns.reply(runId, input, handle, milestone.ask, reply, spent);
      }
    } catch (error) {
      if (error instanceof RunCancelledError) {
        await this.turns.interrupt(input).catch(() => undefined);
        await this.turns.settle(runId, input, { status: 'interrupted' }, Date.now() - started);
        return;
      }
      await this.turns.settleFailed(
        runId,
        input,
        errorText(error, 'the turn failed'),
        Date.now() - started,
        spent,
      );
    }
  }

  /** Wait for a person's answer; a lapsed approval answers itself as expired. */
  private park(
    runId: string,
    toolCallId: string,
    on: Parked['on'],
    timeoutMs?: number,
  ): Promise<HumanReply> {
    const key = `${runId}:${toolCallId}`;
    const waiting = new Promise<HumanReply>((resolve, reject) => {
      this.pending.set(key, { on, resolve, reject });
    });
    if (timeoutMs === undefined) return waiting;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lapse = new Promise<Decision>((resolve) => {
      timer = setTimeout(() => {
        if (this.pending.delete(key)) resolve({ approved: false, expired: true });
      }, timeoutMs);
      timer.unref?.();
    });
    return Promise.race([waiting, lapse]).finally(() => clearTimeout(timer));
  }
}
