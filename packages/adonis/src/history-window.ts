import type {
  HistorySelection,
  HistorySummary,
  HistoryWindow,
  HistoryWindowContext,
} from './spi/history-window.js';
import type { ModelProvider } from './spi/model-provider.js';
import type { SinkWriter } from './spi/token-stream-sink.js';
import type { ModelMessage } from './types.js';

/**
 * Rough token count for one message: ~4 characters per token over its content and its serialized
 * tool calls/results, plus a small per-message envelope allowance for the role and part framing.
 *
 * A heuristic on purpose. A real tokenizer is model-specific and would drag a provider dependency
 * into the package, while a budget only has to be approximately right to keep a thread clear of the
 * provider's hard limit — and it must be a PURE function, because it runs inside `select`. Pass
 * `estimate` to {@link SlidingWindowHistory} to substitute a real one.
 */
export function estimateMessageTokens(message: ModelMessage): number {
  const extras =
    (message.toolCalls !== undefined ? JSON.stringify(message.toolCalls).length : 0) +
    (message.toolResults !== undefined ? JSON.stringify(message.toolResults).length : 0);
  return Math.ceil((message.content.length + extras) / 4) + 4;
}

export interface SlidingWindowHistoryOptions {
  /**
   * Max messages kept, counting from the most recent. Undefined → 40. The just-appended user
   * message for this turn is always the last element of the array the loop hands in, so any
   * `maxMessages >= 1` keeps it.
   */
  maxMessages?: number;
  /**
   * Keep the newest messages whose estimated tokens fit this budget. Undefined → no token limit,
   * so the message count alone decides. Both limits apply when both are set.
   */
  maxTokens?: number;
  /** Substitute for {@link estimateMessageTokens}. Must be pure — it runs inside `select`. */
  estimate?: (message: ModelMessage) => number;
  /**
   * Folds the dropped messages into a leading summary instead of discarding them. Undefined → they
   * are simply gone. {@link summarizeWithModel} is the built-in.
   */
  summarize?: NonNullable<HistoryWindow['summarize']>;
}

/**
 * Default {@link HistoryWindow}: keeps the newest messages that fit a message count and/or a token
 * budget, and (optionally) folds the rest into a summary. Whichever limit cuts more wins.
 *
 * A naive slice is safe because each persisted message is self-contained: a tool call's result is
 * never a separate message the loop hands the model (see `agent-loop.ts`'s mapping of
 * `StoredMessage`), so a cut cannot orphan a tool result from its call.
 */
export class SlidingWindowHistory implements HistoryWindow {
  private readonly maxMessages: number;
  private readonly maxTokens: number | undefined;
  private readonly estimate: (message: ModelMessage) => number;
  readonly summarize?: NonNullable<HistoryWindow['summarize']>;

  constructor(options: SlidingWindowHistoryOptions = {}) {
    this.maxMessages = options.maxMessages ?? 40;
    this.maxTokens = options.maxTokens;
    this.estimate = options.estimate ?? estimateMessageTokens;
    if (options.summarize !== undefined) {
      this.summarize = options.summarize;
    }
  }

  select(messages: ModelMessage[], _ctx: HistoryWindowContext): HistorySelection {
    let cut = Math.max(0, messages.length - this.maxMessages);
    if (this.maxTokens !== undefined) {
      cut = Math.max(cut, tokenCut(messages, this.maxTokens, this.estimate));
    }
    // The newest message always rides, whatever the limits say — a turn with nothing to answer is
    // worse than a turn slightly over budget.
    cut = Math.min(cut, Math.max(0, messages.length - 1));
    return { keep: messages.slice(cut), drop: messages.slice(0, cut) };
  }
}

/** Index of the oldest message that still fits `maxTokens`, walking newest-first. */
function tokenCut(
  messages: ModelMessage[],
  maxTokens: number,
  estimate: (message: ModelMessage) => number,
): number {
  let index = messages.length;
  let total = 0;
  while (index > 0) {
    const message = messages[index - 1];
    if (message === undefined) {
      break;
    }
    const cost = estimate(message);
    if (index < messages.length && total + cost > maxTokens) {
      break;
    }
    total += cost;
    index -= 1;
  }
  return index;
}

/**
 * What a summarizer is told to produce when none is supplied. Written for a reader who will continue
 * the conversation without seeing the messages themselves, so it asks for the parts a later turn
 * still has to act on rather than a readable recap.
 */
export const DEFAULT_HISTORY_SUMMARY_INSTRUCTION =
  'Summarize this conversation for an assistant that will continue it without seeing these messages. Preserve decisions made, facts and constraints the user stated, identifiers and names mentioned, and anything left unresolved. Omit pleasantries. Reply with the summary only — no preamble, no headings.';

/**
 * A {@link HistoryWindow.summarize} backed by one extra, non-streamed model call. Writes to a
 * discarding sink so the summary's tokens never reach the user's live stream, and reports its usage
 * so the call lands in the ledger (and against the quota) like any other.
 */
export function summarizeWithModel(
  model: ModelProvider,
  instruction: string = DEFAULT_HISTORY_SUMMARY_INSTRUCTION,
): NonNullable<HistoryWindow['summarize']> {
  return async (dropped: ModelMessage[]): Promise<HistorySummary> => {
    const discard: SinkWriter = { write: () => {}, end: () => {} };
    const turn = await model.runTurn({
      system: instruction,
      messages: dropped,
      tools: [],
      sink: discard,
    });
    return {
      text: turn.text,
      usage: turn.usage,
      ...(turn.modelId !== undefined ? { modelId: turn.modelId } : {}),
    };
  };
}
