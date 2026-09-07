import type { HistoryWindow, HistoryWindowContext } from './spi/history-window.js';
import type { ModelMessage } from './types.js';

export interface SlidingWindowHistoryOptions {
  /**
   * Max messages kept, counting from the most recent. Undefined → 40. The just-appended user
   * message for this turn is always the last element of the array the loop hands in, so any
   * `maxMessages >= 1` keeps it.
   */
  maxMessages?: number;
}

/**
 * Default {@link HistoryWindow}: keeps only the most recent `maxMessages` messages, dropping the
 * rest with no summary. Each persisted message is self-contained (a tool call's result is never a
 * separate message the loop hands the model — see `agent-loop.ts`'s mapping of `StoredMessage` — so
 * there is no cross-message pairing to preserve), so a plain wholesale drop of the oldest messages
 * is always safe.
 *
 * A deployment that wants dropped history summarized instead of discarded should implement
 * {@link HistoryWindow} directly (e.g. call a model over the dropped slice and prepend the recap as
 * a synthetic message) rather than extend this class.
 */
export class SlidingWindowHistory implements HistoryWindow {
  private readonly maxMessages: number;

  constructor(options: SlidingWindowHistoryOptions = {}) {
    this.maxMessages = options.maxMessages ?? 40;
  }

  apply(messages: ModelMessage[], _ctx: HistoryWindowContext): ModelMessage[] {
    if (messages.length <= this.maxMessages) {
      return messages;
    }
    return messages.slice(messages.length - this.maxMessages);
  }
}
