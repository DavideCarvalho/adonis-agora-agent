import type { StoredMessage } from './client-wire.js';

/**
 * A sub-agent the conversation started and did not wait for. The chat is free while it works, so a
 * client has to be able to say what is still running and to show the answer when it lands — neither
 * of which the turn that started it can report, because that turn is over.
 */
export interface BackgroundRun {
  /** The run doing the work. Also what stamps the message it eventually posts. */
  runId: string;
  /** The agent working on it. */
  agent: string;
  /** The `agent`-kind call that started it — what a UI keys its card off. */
  toolCallId: string;
  toolName: string;
  /**
   * `delivered` the moment the thread holds a message stamped with this run. A run that FAILED
   * reads as delivered too: it posts a message saying so, which is the point — there is no third
   * state a reader could act on differently, and "running" for ever is the state to avoid.
   */
  status: 'running' | 'delivered';
  /** The message it posted, once it did. */
  message?: StoredMessage;
}

/** A detached delegation's receipt, as it appears in a message's `toolResults`. */
interface Receipt {
  detached: true;
  status: 'started';
  agent: string;
  runId: string;
}

function asReceipt(output: unknown): Receipt | null {
  if (typeof output !== 'object' || output === null) {
    return null;
  }
  const candidate = output as Partial<Receipt>;
  if (
    candidate.detached !== true ||
    candidate.status !== 'started' ||
    typeof candidate.agent !== 'string' ||
    typeof candidate.runId !== 'string'
  ) {
    return null;
  }
  return { detached: true, status: 'started', agent: candidate.agent, runId: candidate.runId };
}

/**
 * Every sub-agent this thread started in the background, and whether each has reported back.
 *
 * Derived from the transcript rather than tracked in session state, so it survives a reload and a
 * second tab: the receipt is a persisted tool result, and the answer is a persisted message stamped
 * with the run that wrote it. Nothing here needs a live connection to be true.
 */
export function backgroundRunsFromThread(messages: readonly StoredMessage[]): BackgroundRun[] {
  const byRun = new Map<string, BackgroundRun>();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      const receipt = asReceipt(result.output);
      if (receipt === null || byRun.has(receipt.runId)) {
        continue;
      }
      byRun.set(receipt.runId, {
        runId: receipt.runId,
        agent: receipt.agent,
        toolCallId: result.id,
        toolName: result.name,
        status: 'running',
      });
    }
  }
  for (const message of messages) {
    const run = message.runId === undefined ? undefined : byRun.get(message.runId);
    if (run !== undefined) {
      run.status = 'delivered';
      run.message = message;
    }
  }
  return [...byRun.values()];
}
