import type { UIMessage } from 'ai';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { readUiActionText, uiActionSummary } from '../../../genui/actions.js';
import type { QueuePause } from '../../../index.js';
import type { ApprovalTarget } from '../approvals/proposals.js';
import { attachmentFile, type MessageFile } from '../attachments/files.js';
import { type AgentBackend, requireBackendMethod } from '../backend.js';
import { shareStructure } from '../genui/share-structure.js';
import type { ToolCatalog } from '../presentation/phrasing.js';
import { useAgentBackend } from '../provider.js';
import type { QueuedChatMessage } from '../queue/model.js';
import type { AgentMessageMetadata } from '../stored-thread-to-ui-messages.js';
import {
  type ApproveOptions,
  buildTranscriptBlocks,
  type ChatStatus,
  describeTimestamp,
  describeUsage,
  extractMessageText,
  type MessageUsageInfo,
  type SettleAction,
  type TimestampInfo,
  type TranscriptBlock,
  type TranscriptFile,
  type TranscriptUiAction,
  type UsageSummary,
} from './model.js';
import { type StickToBottom, useStickToBottom } from './use-stick-to-bottom.js';

/** Most-recent messages mounted up front; older ones wait behind `window.loadEarlier`. */
const DEFAULT_VISIBLE_COUNT = 50;
const DEFAULT_LOAD_EARLIER_STEP = 50;
const DEFAULT_COPY_RESET_MS = 1500;

export interface TranscriptCopyState {
  /** False when the message has no prose to put on the clipboard. */
  available: boolean;
  copied: boolean;
  copy: () => void;
}

export interface TranscriptEditState {
  available: boolean;
  isEditing: boolean;
  draft: string;
  /** Whitespace-only drafts are refused, so an empty resubmit can never be sent. */
  canSave: boolean;
  start: () => void;
  cancel: () => void;
  setDraft: (value: string) => void;
  save: () => void;
  /** Controlled-textarea wiring: focus with the caret at the end, Enter saves, Escape cancels. */
  getTextareaProps: () => {
    ref: (element: HTMLTextAreaElement | null) => void;
    value: string;
    onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  };
}

export interface TranscriptActionState {
  available: boolean;
  run: () => void;
}

export interface TranscriptItem {
  id: string;
  message: UIMessage;
  role: UIMessage['role'];
  /** Index in the FULL message array, not in the rendered window. */
  index: number;
  isUser: boolean;
  isAssistant: boolean;
  isLastAssistant: boolean;
  isStreaming: boolean;
  blocks: TranscriptBlock[];
  /** The prose alone — what `copy` puts on the clipboard and what an edit starts from. */
  text: string;
  /**
   * A user message that is a UI action: its parts (see `TranscriptTextBlock.uiAction`). `null` on
   * every other message.
   */
  uiAction: TranscriptUiAction | null;
  usage: UsageSummary | null;
  timestamp: TimestampInfo | null;
  copy: TranscriptCopyState;
  edit: TranscriptEditState;
  fork: TranscriptActionState;
  regenerate: TranscriptActionState;
}

/** What an edit-and-resubmit sends. */
export interface EditSubmitInput {
  messageId: string;
  text: string;
}

/** Names the message an action is about. */
export interface MessageActionInput {
  messageId: string;
}

/** Settling a parked question set. `answers` holds only the questions the user touched. */
export interface AnswerInput {
  toolCallId: string;
  answers?: Record<string, string[]>;
  /** The surface the answer came through; the server records `'web'` when omitted. */
  via?: string;
}

/** Declining a parked question set. */
export interface SkipInput {
  toolCallId: string;
  /** The surface the skip came through; the server records `'web'` when omitted. */
  via?: string;
}

/** Approving a tool call parked on a human. */
export interface ApproveInput extends ApproveOptions {
  target?: ApprovalTarget;
  toolCallId: string;
  /** The surface the decision came through; the server records `'web'` when omitted. */
  via?: string;
}

/** Rejecting a tool call parked on a human. */
export interface RejectInput {
  target?: ApprovalTarget;
  toolCallId: string;
  reason?: string;
  via?: string;
}

export interface TranscriptItemOptions {
  /**
   * A transcript nobody acts on (an audit view, a shared or archived conversation): no approve /
   * reject, answer / skip, edit, fork, regenerate or stop — whatever handlers or backend are in
   * scope. Parked approvals and question sets still render, with their actions unavailable.
   *
   * Without it the decision handlers DEFAULT to the in-scope backend (`<AgentProvider>`'s), so a
   * parked call is actionable with no wiring; a read-only surface would otherwise have to pass
   * `onApprove: null`, `onReject: null`, `onAnswer: null` and `onSkip: null` one by one.
   */
  readOnly?: boolean;
  /** User messages get an inline edit-and-resubmit machine. */
  editable?: boolean;
  onEditSubmit?: (input: EditSubmitInput) => void | Promise<void>;
  onFork?: (input: MessageActionInput) => void | Promise<void>;
  /** Only the LAST assistant message gets a regenerate machine. */
  regeneratable?: boolean;
  onRegenerate?: (input: MessageActionInput) => void | Promise<void>;
  /** Default: `metadata.usage` (replayed turns; see `AgentMessageMetadata`). */
  getUsage?: (message: UIMessage) => MessageUsageInfo | null;
  /** Default: `metadata.createdAt` (replayed and streamed messages). */
  getCreatedAt?: (message: UIMessage) => string | null;
  /** How long `copy.copied` stays true. Default 1500ms. */
  copyResetMs?: number;
  /** Clipboard writer; defaults to `navigator.clipboard.writeText`. */
  writeClipboard?: (text: string) => Promise<void>;
  /**
   * Lift retrieval tool parts into their own `sources` block instead of leaving them in the tool
   * run. Off by default, so a renderer already drawing tool cards keeps drawing them.
   */
  sources?: boolean;
  /**
   * Server-declared tool presentations (`useToolCatalog(...).catalog`). Given → each tool call's
   * `description` and each tool block's `activity` speak in the tool's own words; omitted → generic.
   */
  toolCatalog?: ToolCatalog;
  /**
   * Leave out a failed tool call the model retried at once with the same tool (`retriedCallIds`).
   * Default `true`; `false` keeps every attempt.
   */
  hideRetriedFailures?: boolean;
  /**
   * Settle a parked question set. Default: the in-scope backend's `answerToolCall` (the enclosing
   * `<AgentProvider>`'s), so a question set is an `elicitation` block the user can act on without
   * any wiring. `null` turns question sets back into plain tool calls.
   *
   * `answers` holds ONLY the questions the user touched. An omitted one takes its own pre-picked
   * default server-side, which is what keeps "just confirmed" and "picked exactly what was
   * pre-picked" distinguishable in the settled row.
   */
  onAnswer?: ((input: AnswerInput) => void | Promise<void>) | null;
  /** Decline the question set and let the agent proceed on its own picks. Default: the backend's. */
  onSkip?: ((input: SkipInput) => void | Promise<void>) | null;
  /**
   * Settle a tool call parked on a human. Default: the in-scope backend's `approveToolCall` /
   * `rejectToolCall`. `remember` is what `call.approve.run({ remember: true })` passed. `null`
   * leaves the call without the affordance.
   */
  onApprove?: ((input: ApproveInput) => void | Promise<void>) | null;
  onReject?: ((input: RejectInput) => void | Promise<void>) | null;
}

export interface TranscriptWindow {
  visibleCount: number;
  /** How many older messages are not mounted. */
  hiddenCount: number;
  canLoadEarlier: boolean;
  loadEarlier: () => void;
  showAll: () => void;
}

export interface TranscriptStopState {
  available: boolean;
  /** True from the click until the turn actually leaves a busy status. */
  isStopping: boolean;
  stop: () => void;
}

export interface UseChatTranscriptOptions extends TranscriptItemOptions {
  messages: UIMessage[];
  status: ChatStatus;
  initialVisibleCount?: number;
  loadEarlierStep?: number;
  /** Cancel the in-flight turn — wire to `useAgentChat`'s `cancel`. */
  onStop?: () => void | Promise<void>;
  /** Suggested follow-ups. The model only decides WHETHER they belong on screen. */
  followUps?: string[] | null;
  stickToBottomThreshold?: number;
  /**
   * Messages waiting in the thread's queue — `chat.queue` (`useAgentChat` wires it). They render
   * after the transcript as {@link ChatTranscript.queued}: pending user messages, not yet sent.
   */
  queue?: {
    /** `files` may be left out by a host that builds these itself: it is derived from `attachments`. */
    items: Array<Omit<QueuedChatMessage, 'files'> & { files?: MessageFile[] }>;
    paused: QueuePause | null;
    remove?: (id: string) => void | Promise<void>;
  } | null;
}

/** One file on a waiting message: a sent message's {@link MessageFile}, and a `TranscriptFile`. */
export type TranscriptQueuedFile = MessageFile & TranscriptFile;

/**
 * A message waiting in the thread's queue, as the transcript shows it: a user message that has not
 * been sent to the model yet. Render it after {@link ChatTranscript.items}, dimmed or tagged.
 */
export interface TranscriptQueuedItem {
  id: string;
  role: 'user';
  text: string;
  /**
   * The message's files, in the shape a sent message's have: a {@link MessageFile} (what
   * `messageFiles()` gives — `kind`, `extension`, `mediaId`) that is also a `TranscriptFile`
   * (`isImage`), so either renderer takes it as it is.
   */
  files: TranscriptQueuedFile[];
  /**
   * `'sending'` — on its way to the server. `'queued'` — waiting for the running turn.
   * `'paused'` — waiting, but the queue is paused (see {@link ChatTranscript.queuePaused}).
   */
  state: 'sending' | 'queued' | 'paused';
  /** 0-based place in the queue. */
  position: number;
  /** Runs next. */
  isNext: boolean;
  /** Queued by an interrupt — it runs as soon as the cancelled turn settles. */
  interrupt: boolean;
  remove: TranscriptActionState;
}

export interface ChatTranscript {
  /** The mounted window, oldest first. `window.hiddenCount` says what is held back. */
  items: TranscriptItem[];
  status: ChatStatus;
  isEmpty: boolean;
  /** A turn is in flight: sent but not settled. */
  isBusy: boolean;
  isStreaming: boolean;
  showEmptyState: boolean;
  /** Waiting on the first token of a turn that has no assistant message yet. */
  showTypingIndicator: boolean;
  showFollowUps: boolean;
  lastAssistantId: string | null;
  window: TranscriptWindow;
  scroll: StickToBottom;
  stop: TranscriptStopState;
  /** Messages waiting in the thread's queue, in run order — render after `items`. */
  queued: TranscriptQueuedItem[];
  /** Why the queue is not draining, or `null`. */
  queuePaused: QueuePause | null;
}

/**
 * The model behind a chat transcript: messages normalized into items with their parts grouped into
 * runs, per-message derived values (copyable text, usage labels, relative time), each action as a
 * state machine rather than a button, list windowing, and stick-to-bottom. It renders nothing and
 * names no class — `MessageList`/`MessageItem` are one renderer over it, and an app with its own
 * design system writes another without reimplementing any of this.
 */
export function useChatTranscript(options: UseChatTranscriptOptions): ChatTranscript {
  const {
    messages,
    status,
    initialVisibleCount = DEFAULT_VISIBLE_COUNT,
    followUps,
    stickToBottomThreshold,
  } = options;

  const latest = useRef(options);
  latest.current = options;

  const [visibleCount, setVisibleCount] = useState(initialVisibleCount);
  const [stopRequested, setStopRequested] = useState(false);

  // A reconnecting stream is still the turn in flight, and its message is still being written.
  const isStreaming = status === 'streaming' || status === 'reconnecting';
  const isBusy = status === 'submitted' || isStreaming;
  const isEmpty = messages.length === 0;

  // A settled turn clears a pending stop, so the next turn's button starts from rest.
  useEffect(() => {
    if (!isBusy) {
      setStopRequested(false);
    }
  }, [isBusy]);

  const lastMessage = messages.at(-1);
  const lastAssistant = findLastAssistant(messages);
  const streamingMessageId = isStreaming ? (lastAssistant?.id ?? null) : null;

  const visibleStart = Math.max(0, messages.length - visibleCount);
  const items = useTranscriptItems({
    messages,
    visibleStart,
    streamingMessageId,
    options,
  });

  const stop = useCallback(() => {
    const current = latest.current;
    if (
      current.status !== 'submitted' &&
      current.status !== 'streaming' &&
      current.status !== 'reconnecting'
    ) {
      return;
    }
    setStopRequested(true);
    void current.onStop?.();
  }, []);

  const loadEarlier = useCallback(
    () =>
      setVisibleCount(
        (count) => count + (latest.current.loadEarlierStep ?? DEFAULT_LOAD_EARLIER_STEP),
      ),
    [],
  );
  const showAll = useCallback(() => setVisibleCount(latest.current.messages.length), []);

  const scroll = useStickToBottom({
    contentKey: contentSignature(messages),
    ...(stickToBottomThreshold !== undefined ? { threshold: stickToBottomThreshold } : {}),
  });

  const showTypingIndicator = isBusy && lastMessage?.role !== 'assistant';
  const queued = useQueuedItems(options.queue ?? null, options.readOnly === true);

  return {
    items,
    status,
    isEmpty,
    isBusy,
    isStreaming,
    showEmptyState: isEmpty && status === 'ready',
    showTypingIndicator,
    showFollowUps:
      status === 'ready' &&
      !showTypingIndicator &&
      lastMessage?.role === 'assistant' &&
      !!followUps &&
      followUps.length > 0,
    lastAssistantId: lastAssistant?.id ?? null,
    window: {
      visibleCount,
      hiddenCount: visibleStart,
      canLoadEarlier: visibleStart > 0,
      loadEarlier,
      showAll,
    },
    scroll,
    stop: {
      available: isBusy && options.readOnly !== true && options.onStop !== undefined,
      isStopping: stopRequested,
      stop,
    },
    queued,
    queuePaused: options.queue?.paused ?? null,
  };
}

/** The queue as transcript items. `remove` is cached per id, like every other item action. */
function useQueuedItems(
  queue: UseChatTranscriptOptions['queue'],
  readOnly: boolean,
): TranscriptQueuedItem[] {
  const latestQueue = useRef(queue);
  latestQueue.current = queue;
  const removers = useRef(new Map<string, () => void>());
  const removerFor = useCallback((id: string) => {
    let remover = removers.current.get(id);
    if (remover === undefined) {
      remover = () => {
        void latestQueue.current?.remove?.(id);
      };
      removers.current.set(id, remover);
    }
    return remover;
  }, []);
  if (queue === null || queue === undefined) {
    return [];
  }
  return queue.items.map((message, position) => {
    const state: TranscriptQueuedItem['state'] =
      message.state === 'sending' ? 'sending' : queue.paused !== null ? 'paused' : 'queued';
    return {
      id: message.id,
      role: 'user',
      text: message.text,
      files: (message.files ?? message.attachments.map(attachmentFile)).map((file) => ({
        ...file,
        isImage: file.kind === 'image',
      })),
      state,
      position,
      isNext: position === 0,
      interrupt: message.interrupt,
      remove: {
        available: !readOnly && state !== 'sending' && queue.remove !== undefined,
        run: removerFor(message.id),
      },
    };
  });
}

export interface UseTranscriptItemOptions extends TranscriptItemOptions {
  message: UIMessage;
  isStreaming?: boolean;
}

/**
 * The single-message half of {@link useChatTranscript}, for a renderer that owns the list itself.
 * `regeneratable` applies directly here: one assistant message is trivially the last one.
 */
export function useTranscriptItem(options: UseTranscriptItemOptions): TranscriptItem {
  const { message, isStreaming = false } = options;
  const messagesRef = useRef<UIMessage[]>([message]);
  // A fresh array each render would re-key nothing but does churn the items memo; the identity is
  // kept stable while the message itself is unchanged.
  if (messagesRef.current[0] !== message) {
    messagesRef.current = [message];
  }
  const items = useTranscriptItems({
    messages: messagesRef.current,
    visibleStart: 0,
    streamingMessageId: isStreaming ? message.id : null,
    options,
  });
  // One message in, exactly one item out.
  return items[0] as TranscriptItem;
}

interface TranscriptItemsParams {
  messages: UIMessage[];
  visibleStart: number;
  streamingMessageId: string | null;
  options: TranscriptItemOptions;
}

/**
 * All per-message UI state lives here, keyed by message id, because the number of messages is not
 * known at render time — a hook per item would break the rules of hooks the moment a turn arrives.
 * Each item's callbacks are cached per id so a controlled `<textarea>`'s ref identity survives every
 * keystroke; without that, React detaches and re-attaches the node on each render and the focus
 * effect drags the caret back to the end mid-edit.
 */
function useTranscriptItems({
  messages,
  visibleStart,
  streamingMessageId,
  options,
}: TranscriptItemsParams): TranscriptItem[] {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [copied, setCopied] = useState<ReadonlySet<string>>(() => new Set());
  const [openReasoning, setOpenReasoning] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  // A question's picks, under `toolCallId|questionId`. Presence IS "the user touched this
  // question" — an absent entry is what makes the submission omit it and take the server's default.
  const [picks, setPicks] = useState<ReadonlyMap<string, string[]>>(() => new Map());
  // Which decision each parked call is sending, not merely that one is: the two affordances on a
  // call are never in flight together, and only the pressed one should report progress.
  const [settling, setSettling] = useState<ReadonlyMap<string, SettleAction>>(() => new Map());
  const [settleErrors, setSettleErrors] = useState<
    ReadonlyMap<string, { message: string; code: string | null }>
  >(() => new Map());

  const backend = useAgentBackend();
  const handlers = settleHandlers(options, backend);
  const latest = useRef({ options, handlers, drafts, picks, messages });
  latest.current = { options, handlers, drafts, picks, messages };

  const copyTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(
    () => () => {
      for (const timer of copyTimers.current.values()) {
        clearTimeout(timer);
      }
      copyTimers.current.clear();
    },
    [],
  );

  const callbackCache = useRef(new Map<string, ItemCallbacks>());
  const reasoningToggleCache = useRef(new Map<string, (open?: boolean) => void>());
  const uiBlocks = useRef(new Map<string, TranscriptBlock>());

  const toggleReasoning = useCallback((key: string, open?: boolean) => {
    setOpenReasoning((current) => {
      const next = new Map(current);
      next.set(key, open ?? !(current.get(key) ?? false));
      return next;
    });
  }, []);

  const stableToggle = useCallback(
    (key: string) => {
      let cached = reasoningToggleCache.current.get(key);
      if (!cached) {
        cached = (open?: boolean) => toggleReasoning(key, open);
        reasoningToggleCache.current.set(key, cached);
      }
      return cached;
    },
    [toggleReasoning],
  );

  const pick = useCallback((toolCallId: string, questionId: string, values: string[]) => {
    setPicks((current) => new Map(current).set(pickKey(toolCallId, questionId), values));
  }, []);

  /**
   * Run one decision against the server. A rejection has to land somewhere the user can see: the
   * call stays parked either way, and a form that silently does nothing on submit is
   * indistinguishable from a broken button.
   */
  const settle = useCallback(
    (toolCallId: string, action: SettleAction, send: () => void | Promise<void>) => {
      setSettleErrors((current) => {
        if (!current.has(toolCallId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(toolCallId);
        return next;
      });
      setSettling((current) => new Map(current).set(toolCallId, action));
      const failed = (error: unknown) => {
        setSettling((current) => {
          const next = new Map(current);
          next.delete(toolCallId);
          return next;
        });
        setSettleErrors((current) =>
          new Map(current).set(toolCallId, {
            message: error instanceof Error ? error.message : 'Could not settle this',
            code: settleErrorCode(error),
          }),
        );
      };
      // Sent in the click's own tick, not a microtask later — a synchronous throw and a rejected
      // promise are the same failure to the person looking at the form.
      try {
        void Promise.resolve(send()).catch(failed);
      } catch (error) {
        failed(error);
      }
    },
    [],
  );

  const answer = useCallback(
    (toolCallId: string) => {
      const current = latest.current;
      const onAnswer = current.handlers.onAnswer;
      if (!onAnswer) {
        return;
      }
      settle(toolCallId, 'answer', () =>
        onAnswer({ toolCallId, answers: answersFor(current.picks, toolCallId) }),
      );
    },
    [settle],
  );

  const skip = useCallback(
    (toolCallId: string) => {
      const onSkip = latest.current.handlers.onSkip;
      if (onSkip) {
        settle(toolCallId, 'skip', () => onSkip({ toolCallId }));
      }
    },
    [settle],
  );

  const approve = useCallback(
    (toolCallId: string, options?: ApproveOptions, target?: ApprovalTarget) => {
      const onApprove = latest.current.handlers.onApprove;
      if (onApprove) {
        settle(toolCallId, 'approve', () =>
          onApprove({
            toolCallId,
            ...(target === undefined ? {} : { target }),
            ...(options?.remember === true ? { remember: true } : {}),
          }),
        );
      }
    },
    [settle],
  );

  const reject = useCallback(
    (toolCallId: string, target?: ApprovalTarget) => {
      const onReject = latest.current.handlers.onReject;
      if (onReject) {
        settle(toolCallId, 'reject', () =>
          onReject({ toolCallId, ...(target === undefined ? {} : { target }) }),
        );
      }
    },
    [settle],
  );

  const callbacksFor = useCallback((id: string): ItemCallbacks => {
    const cached = callbackCache.current.get(id);
    if (cached) {
      return cached;
    }
    const textFor = () =>
      extractMessageText(latest.current.messages.find((message) => message.id === id)?.parts);
    const created: ItemCallbacks = {
      copy: () => {
        // A UI action copies as what its chip says, not as the JSON block the model reads.
        const raw = textFor();
        const message = latest.current.messages.find((candidate) => candidate.id === id);
        const action = message?.role === 'user' ? readUiActionText(raw) : null;
        const text = action !== null ? uiActionSummary(action) : raw;
        if (!text) {
          return;
        }
        const write =
          latest.current.options.writeClipboard ??
          ((value: string) => navigator.clipboard.writeText(value));
        void Promise.resolve()
          .then(() => write(text))
          .then(() => {
            setCopied((current) => new Set(current).add(id));
            const existing = copyTimers.current.get(id);
            if (existing) {
              clearTimeout(existing);
            }
            copyTimers.current.set(
              id,
              setTimeout(() => {
                copyTimers.current.delete(id);
                setCopied((current) => {
                  const next = new Set(current);
                  next.delete(id);
                  return next;
                });
              }, latest.current.options.copyResetMs ?? DEFAULT_COPY_RESET_MS),
            );
          })
          .catch(() => {
            // Clipboard can be unavailable (insecure context / denied permission) — fail quietly.
          });
      },
      startEdit: () => {
        const text = textFor();
        setDrafts((current) => new Map(current).set(id, text));
      },
      cancelEdit: () => {
        setDrafts((current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        });
      },
      setDraft: (value: string) => {
        setDrafts((current) => new Map(current).set(id, value));
      },
      save: () => {
        const next = (latest.current.drafts.get(id) ?? '').trim();
        if (!next) {
          return;
        }
        created.cancelEdit();
        void latest.current.options.onEditSubmit?.({ messageId: id, text: next });
      },
      fork: () => {
        void latest.current.options.onFork?.({ messageId: id });
      },
      regenerate: () => {
        void latest.current.options.onRegenerate?.({ messageId: id });
      },
      textareaRef: (element: HTMLTextAreaElement | null) => {
        if (!element) {
          return;
        }
        element.focus();
        element.setSelectionRange(element.value.length, element.value.length);
      },
      onTextareaChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        created.setDraft(event.target.value);
      },
      onTextareaKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          created.save();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          created.cancelEdit();
        }
      },
    };
    callbackCache.current.set(id, created);
    return created;
  }, []);

  const lastAssistantId = findLastAssistant(messages)?.id ?? null;
  const items: TranscriptItem[] = [];
  // Pushed components of the last render, by block key: an unchanged one keeps its object.
  const previousUi = uiBlocks.current;
  const keptUi = new Map<string, TranscriptBlock>();
  const keepUiIdentity = (blocks: TranscriptBlock[]): TranscriptBlock[] =>
    blocks.map((block) => {
      if (block.kind !== 'ui') return block;
      const kept = shareStructure(previousUi.get(block.key), block);
      keptUi.set(block.key, kept);
      return kept;
    });

  for (let index = visibleStart; index < messages.length; index++) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    const callbacks = callbacksFor(message.id);
    const draft = drafts.get(message.id);
    const isEditing = draft !== undefined;
    const text = extractMessageText(message.parts);
    const usage = (options.getUsage ?? usageFromMetadata)(message);
    const isUser = message.role === 'user';
    const uiAction = isUser ? readUiActionText(text) : null;
    const isAssistant = message.role === 'assistant';
    const isLastAssistant = isAssistant && message.id === lastAssistantId;

    items.push({
      id: message.id,
      message,
      role: message.role,
      index,
      isUser,
      isAssistant,
      isLastAssistant,
      isStreaming: message.id === streamingMessageId,
      uiAction,
      blocks: keepUiIdentity(
        buildTranscriptBlocks(message, {
          isReasoningOpen: (key, isStreamingRun) => openReasoning.get(key) ?? isStreamingRun,
          toggleReasoning: (key, open) => stableToggle(key)(open),
          ...(options.sources !== undefined ? { sources: options.sources } : {}),
          ...(options.toolCatalog !== undefined ? { toolCatalog: options.toolCatalog } : {}),
          ...(options.hideRetriedFailures !== undefined
            ? { hideRetriedFailures: options.hideRetriedFailures }
            : {}),
          // Read-only still lifts question sets into their block, so the outcome shows.
          ...(handlers.onAnswer !== undefined ||
          (options.readOnly === true && options.onAnswer !== null)
            ? {
                elicitation: {
                  picked: (toolCallId, questionId) => picks.get(pickKey(toolCallId, questionId)),
                  pick,
                  canAnswer: handlers.onAnswer !== undefined,
                  canSkip: handlers.onSkip !== undefined,
                  answer,
                  skip,
                  submitting: (toolCallId) => settling.get(toolCallId) ?? null,
                  errorOf: (toolCallId) => settleErrors.get(toolCallId)?.message ?? null,
                  errorCodeOf: (toolCallId) => settleErrors.get(toolCallId)?.code ?? null,
                },
              }
            : {}),
          ...(handlers.onApprove !== undefined || handlers.onReject !== undefined
            ? {
                approval: {
                  canApprove: handlers.onApprove !== undefined,
                  canReject: handlers.onReject !== undefined,
                  approve,
                  reject,
                  submitting: (toolCallId) => settling.get(toolCallId) ?? null,
                  errorOf: (toolCallId) => settleErrors.get(toolCallId)?.message ?? null,
                  errorCodeOf: (toolCallId) => settleErrors.get(toolCallId)?.code ?? null,
                },
              }
            : {}),
        }),
      ),
      text,
      usage: usage ? describeUsage(usage) : null,
      timestamp: describeTimestamp((options.getCreatedAt ?? createdAtFromMetadata)(message)),
      copy: {
        available: text.length > 0,
        copied: copied.has(message.id),
        copy: callbacks.copy,
      },
      edit: {
        available:
          isUser &&
          options.readOnly !== true &&
          options.editable === true &&
          options.onEditSubmit !== undefined,
        isEditing,
        draft: draft ?? text,
        canSave: (draft ?? '').trim().length > 0,
        start: callbacks.startEdit,
        cancel: callbacks.cancelEdit,
        setDraft: callbacks.setDraft,
        save: callbacks.save,
        getTextareaProps: () => ({
          ref: callbacks.textareaRef,
          value: draft ?? text,
          onChange: callbacks.onTextareaChange,
          onKeyDown: callbacks.onTextareaKeyDown,
        }),
      },
      fork: {
        available: options.readOnly !== true && options.onFork !== undefined,
        run: callbacks.fork,
      },
      regenerate: {
        available:
          isLastAssistant &&
          options.readOnly !== true &&
          options.regeneratable === true &&
          options.onRegenerate !== undefined,
        run: callbacks.regenerate,
      },
    });
  }

  uiBlocks.current = keptUi;
  return items;
}

interface ItemCallbacks {
  copy: () => void;
  startEdit: () => void;
  cancelEdit: () => void;
  setDraft: (value: string) => void;
  save: () => void;
  fork: () => void;
  regenerate: () => void;
  textareaRef: (element: HTMLTextAreaElement | null) => void;
  onTextareaChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

interface SettleHandlers {
  onAnswer: ((input: AnswerInput) => void | Promise<void>) | undefined;
  onSkip: ((input: SkipInput) => void | Promise<void>) | undefined;
  onApprove: ((input: ApproveInput) => void | Promise<void>) | undefined;
  onReject: ((input: RejectInput) => void | Promise<void>) | undefined;
}

/**
 * The handler for each human decision: the caller's, else the backend's own call — so a parked
 * approval or question set is never a card nobody can act on. `null` opts a decision out.
 */
function settleHandlers(options: TranscriptItemOptions, backend: AgentBackend): SettleHandlers {
  const pick = <T>(own: T | null | undefined, fallback: T | undefined): T | undefined =>
    options.readOnly === true || own === null ? undefined : (own ?? fallback);
  return {
    onAnswer: pick(
      options.onAnswer,
      backend.answerToolCall
        ? async (input) => {
            await backend.answerToolCall?.(input);
          }
        : undefined,
    ),
    onSkip: pick(
      options.onSkip,
      backend.skipToolCall
        ? async (input) => {
            await backend.skipToolCall?.(input);
          }
        : undefined,
    ),
    onApprove: pick(
      options.onApprove,
      backend.approveToolCall || backend.approveActionProposal
        ? async (input) => {
            if (input.target?.kind === 'proposal') {
              if (input.target.threadId === undefined)
                throw new Error('A proposal decision requires its thread scope');
              await requireBackendMethod(
                backend,
                'approveActionProposal',
              )({
                threadId: input.target.threadId,
                proposalId: input.target.proposalId,
                ...(input.remember === undefined ? {} : { remember: input.remember }),
              });
            } else await requireBackendMethod(backend, 'approveToolCall')(input);
          }
        : undefined,
    ),
    onReject: pick(
      options.onReject,
      backend.rejectToolCall || backend.rejectActionProposal
        ? async (input) => {
            if (input.target?.kind === 'proposal') {
              if (input.target.threadId === undefined)
                throw new Error('A proposal decision requires its thread scope');
              await requireBackendMethod(
                backend,
                'rejectActionProposal',
              )({
                threadId: input.target.threadId,
                proposalId: input.target.proposalId,
                ...(input.reason === undefined ? {} : { reason: input.reason }),
              });
            } else await requireBackendMethod(backend, 'rejectToolCall')(input);
          }
        : undefined,
    ),
  };
}

function metadataOf(message: UIMessage): AgentMessageMetadata {
  const metadata = message.metadata;
  return metadata !== null && typeof metadata === 'object'
    ? (metadata as AgentMessageMetadata)
    : {};
}

/** The default `getUsage`: what the library stamps on `metadata.usage`. */
function usageFromMetadata(message: UIMessage): MessageUsageInfo | null {
  const usage = metadataOf(message).usage;
  if (usage === undefined) return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd ?? null,
  };
}

/** The default `getCreatedAt`: what the library stamps on `metadata.createdAt`. */
function createdAtFromMetadata(message: UIMessage): string | null {
  return metadataOf(message).createdAt ?? null;
}

/** `|` never appears in either half: a tool-call id and a question id are both opaque tokens. */
function pickKey(toolCallId: string, questionId: string): string {
  return `${toolCallId}|${questionId}`;
}

/** The picks belonging to one question set, as the answers a submission carries. */
function answersFor(
  picks: ReadonlyMap<string, string[]>,
  toolCallId: string,
): Record<string, string[]> {
  const prefix = `${toolCallId}|`;
  const answers: Record<string, string[]> = {};
  for (const [key, values] of picks) {
    if (key.startsWith(prefix)) {
      answers[key.slice(prefix.length)] = values;
    }
  }
  return answers;
}

function findLastAssistant(messages: UIMessage[]): UIMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === 'assistant') {
      return message;
    }
  }
  return undefined;
}

/**
 * Changes as the transcript grows, including WITHIN the message being streamed — the array is
 * mutated in place while tokens arrive, so its length alone never moves during a turn.
 */
function contentSignature(messages: UIMessage[]): string {
  const last = messages.at(-1);
  if (!last) {
    return '0';
  }
  let length = 0;
  for (const part of last.parts ?? []) {
    if ('text' in part && typeof part.text === 'string') {
      length += part.text.length;
    }
  }
  return `${messages.length}|${last.id}|${last.parts?.length ?? 0}|${length}`;
}

/** The server's machine-readable reason for refusing a decision (`run_not_active`, …), if any. */
function settleErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : null;
}
