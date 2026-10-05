import type { UIMessage } from 'ai';
import type React from 'react';
import type { ChatQueue } from '../queue/model.js';
import type { ChatStatus, MessageUsageInfo } from '../transcript/model.js';
import {
  type EditSubmitInput,
  type MessageActionInput,
  useChatTranscript,
} from '../transcript/use-chat-transcript.js';
import {
  type MessageItemClassNames,
  MessageItemView,
  type RenderFilesFn,
  type RenderReasoningFn,
  type RenderTextFn,
  type RenderToolGroupFn,
  type RenderToolPartFn,
  type RenderUiFn,
} from './message-item.js';

export type { ChatStatus } from '../transcript/model.js';

export interface MessageListClassNames {
  root?: string;
  empty?: string;
  loadEarlier?: string;
  typing?: string;
  error?: string;
  errorRetry?: string;
  followUps?: string;
  followUpChip?: string;
  /** The block of waiting (queued) messages after the transcript. */
  queue?: string;
  /** One waiting message; it also carries `data-state="sending|queued|paused"`. */
  queuedItem?: string;
  queuedRemove?: string;
  /** The "queue paused" line and its resume button. */
  queuePaused?: string;
  queueResume?: string;
  message?: MessageItemClassNames;
}

export interface MessageListProps {
  messages: UIMessage[];
  status: ChatStatus;
  renderToolPart?: RenderToolPartFn;
  renderToolGroup?: RenderToolGroupFn;
  renderText?: RenderTextFn;
  /** Render the body of a reasoning run; the disclosure toggle is the list's. */
  renderReasoning?: RenderReasoningFn;
  /** Draw a message's files yourself. Omitted → images inline, everything else a link. */
  renderFiles?: RenderFilesFn;
  /** Draw a server-pushed component (a `ui` stream frame). Omitted → not drawn. */
  renderUi?: RenderUiFn;
  reasoningLabel?: React.ReactNode;
  /** Extra content for one message's action row — e.g. a badge naming which agent answered. */
  getMeta?: (message: UIMessage) => React.ReactNode;
  /**
   * Nobody acts on this list (an audit or shared view): parked approvals and question sets render
   * without their actions, and no fork / edit / regenerate — see `useChatTranscript({ readOnly })`.
   */
  readOnly?: boolean;
  /** When set, every message gets a "Fork" affordance calling back with its id. */
  onFork?: (input: MessageActionInput) => void | Promise<void>;
  /** User messages get an inline edit-and-resubmit affordance. */
  editable?: boolean;
  onEditSubmit?: (input: EditSubmitInput) => void | Promise<void>;
  /** The last assistant message gets a "Regenerate" affordance. */
  regeneratable?: boolean;
  onRegenerate?: (input: MessageActionInput) => void | Promise<void>;
  /** Per-message resolvers for the usage line and the persisted timestamp. */
  getUsage?: (message: UIMessage) => MessageUsageInfo | null;
  getCreatedAt?: (message: UIMessage) => string | null;
  /** Shown (with example/follow-up chips) when idle and empty. */
  emptyState?: React.ReactNode;
  /** Node rendered while waiting for the first assistant token. */
  typingIndicator?: React.ReactNode;
  /** AI-generated follow-up prompts under the last assistant message. */
  followUps?: string[] | null;
  onFollowUpClick?: (text: string) => void;
  /** Last turn's error — paired with `onRetry`, renders a retry banner. */
  error?: Error | null;
  onRetry?: () => void | Promise<void>;
  /**
   * `chat.queue` — messages sent while a turn was running, drawn after the transcript as pending
   * user messages (with a remove button), and a resume button while the queue is paused.
   */
  queue?: ChatQueue;
  classNames?: MessageListClassNames;
}

/**
 * Styling-agnostic message list. Keeps the proven UX — windowed render
 * with "load earlier", a typing indicator, an inline error+retry banner,
 * and follow-up chips — but ships no styles: drive everything through
 * `classNames` and the `emptyState`/`typingIndicator` slots.
 *
 * Every decision here comes from `useChatTranscript`; the file below it is markup. A host that
 * wants a different layout drives that hook directly and never imports this component.
 */
export function MessageList({
  messages,
  status,
  renderToolPart,
  renderToolGroup,
  renderText,
  renderReasoning,
  renderFiles,
  renderUi,
  reasoningLabel,
  getMeta,
  readOnly,
  onFork,
  editable,
  onEditSubmit,
  regeneratable,
  onRegenerate,
  getUsage,
  getCreatedAt,
  emptyState,
  typingIndicator,
  followUps,
  onFollowUpClick,
  error,
  onRetry,
  queue,
  classNames,
}: MessageListProps) {
  const transcript = useChatTranscript({
    messages,
    status,
    ...(readOnly !== undefined ? { readOnly } : {}),
    ...(onFork ? { onFork } : {}),
    ...(editable !== undefined ? { editable } : {}),
    ...(onEditSubmit ? { onEditSubmit } : {}),
    ...(regeneratable !== undefined ? { regeneratable } : {}),
    ...(onRegenerate ? { onRegenerate } : {}),
    ...(getUsage ? { getUsage } : {}),
    ...(getCreatedAt ? { getCreatedAt } : {}),
    ...(followUps !== undefined ? { followUps } : {}),
    ...(queue !== undefined
      ? { queue: { items: queue.items, paused: queue.paused, remove: queue.remove } }
      : {}),
  });

  if (transcript.showEmptyState && transcript.queued.length === 0) {
    return <div className={classNames?.empty}>{emptyState}</div>;
  }

  const slots = {
    ...(renderToolPart ? { renderToolPart } : {}),
    ...(renderToolGroup ? { renderToolGroup } : {}),
    ...(renderText ? { renderText } : {}),
    ...(renderReasoning ? { renderReasoning } : {}),
    ...(renderFiles ? { renderFiles } : {}),
    ...(renderUi ? { renderUi } : {}),
    ...(reasoningLabel !== undefined ? { reasoningLabel } : {}),
    ...(classNames?.message ? { classNames: classNames.message } : {}),
  };

  return (
    <div className={classNames?.root}>
      {transcript.window.canLoadEarlier ? (
        <button
          type="button"
          className={classNames?.loadEarlier}
          onClick={transcript.window.loadEarlier}
        >
          Load earlier ({transcript.window.hiddenCount} more)
        </button>
      ) : null}
      {transcript.items.map((item) => (
        <MessageItemView
          key={item.id}
          item={item}
          {...slots}
          {...(getMeta ? { meta: getMeta(item.message) } : {})}
        />
      ))}
      {transcript.queued.length > 0 ? (
        <div className={classNames?.queue}>
          {transcript.queued.map((item) => (
            <div key={item.id} className={classNames?.queuedItem} data-state={item.state}>
              <span>{item.text}</span>
              {item.remove.available ? (
                <button
                  type="button"
                  className={classNames?.queuedRemove}
                  onClick={item.remove.run}
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
          {transcript.queuePaused !== null && queue !== undefined ? (
            <div className={classNames?.queuePaused}>
              <span>Queue paused</span>
              <button
                type="button"
                className={classNames?.queueResume}
                onClick={() => void queue.resume()}
              >
                Resume
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {transcript.showTypingIndicator ? (
        <div className={classNames?.typing}>{typingIndicator ?? 'Thinking…'}</div>
      ) : null}
      {error && onRetry ? (
        <div className={classNames?.error}>
          <span>{error.message || "The assistant didn't respond."}</span>
          <button type="button" className={classNames?.errorRetry} onClick={() => void onRetry()}>
            Retry
          </button>
        </div>
      ) : null}
      {transcript.showFollowUps && onFollowUpClick && followUps ? (
        <div className={classNames?.followUps}>
          {followUps.map((text) => (
            <button
              key={text}
              type="button"
              className={classNames?.followUpChip}
              onClick={() => onFollowUpClick(text)}
            >
              {text}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
