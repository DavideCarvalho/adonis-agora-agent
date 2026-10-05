import type { MessageAttachment, QueuePause } from '../../../index.js';
import type { MessageFile } from '../attachments/files.js';

/**
 * What the composer (and `sendMessage`) does with a message sent while a turn is still running:
 *  - `'queue'` (default) — it waits in the thread's queue and runs when the turn settles.
 *  - `'interrupt'` — the running turn is cancelled and this message runs next.
 *  - `'block'` — the composer refuses it (`blockedBy: 'busy'`), as before queues existed.
 */
export type WhileRunning = 'queue' | 'interrupt' | 'block';

/**
 * A per-call answer to "a turn is still running" — `composer.submit({ mode })`,
 * `sendMessage(message, { mode })`. It overrides the chat's `whileRunning` for that one send
 * (including `'block'`), and means nothing when no turn is running: the message is simply sent.
 */
export interface SendWhileRunning {
  /** `'queue'` — wait for the running turn. `'interrupt'` — cancel it and run this next. */
  mode?: 'queue' | 'interrupt';
}

/** A message waiting in the thread's queue, as the chat shows it. */
export interface QueuedChatMessage {
  /** The server's id once it is queued; a local id while `state` is `'sending'`. */
  id: string;
  text: string;
  /** The uploaded attachments as they were queued — what a re-send carries. */
  attachments: MessageAttachment[];
  /**
   * The same attachments as {@link MessageFile}s — the shape `messageFiles()` gives for a sent
   * message, so one renderer draws the files of a waiting message and of a sent one.
   */
  files: MessageFile[];
  /**
   * `'sending'` — on its way to the server (it has no server id yet, so it cannot be edited).
   * `'queued'` — waiting its turn.
   */
  state: 'sending' | 'queued';
  /** Queued by an interrupt: it runs as soon as the cancelled turn settles. */
  interrupt: boolean;
  createdAt: string;
}

/** `chat.queue` — the thread's queue of waiting messages, and what can be done to it. */
export interface ChatQueue {
  /** Waiting messages, in the order they will run. */
  items: QueuedChatMessage[];
  /** Why the queue stopped draining (a failed turn, a Stop, the quota), or `null`. */
  paused: QueuePause | null;
  /** The backend can queue (`enqueueMessage`). Without it sends made mid-turn are refused. */
  isSupported: boolean;
  /**
   * Queue `text` (with already-uploaded `attachments`) on this chat's thread. `mode: 'interrupt'`
   * cancels the running turn and runs it next. Starts at once when nothing is running.
   */
  add: (
    text: string,
    options?: { attachments?: MessageAttachment[]; mode?: 'queue' | 'interrupt' },
  ) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /**
   * Run a waiting message now: it moves to the head as an interrupt and the running turn is
   * cancelled for it (with nothing running, it starts at once). One server call — the message keeps
   * its id and never leaves the queue, unlike a `remove` followed by an `add`. Needs a backend with
   * `interruptQueuedMessage`.
   */
  interrupt: (id: string) => Promise<void>;
  edit: (id: string, text: string) => Promise<void>;
  /** Move a waiting message to `index` (0 → next). */
  move: (id: string, index: number) => Promise<void>;
  clear: () => Promise<void>;
  /** Lift a pause; the head starts when nothing is running. */
  resume: () => Promise<void>;
  /** The last queue operation that failed, or `null`. */
  error: Error | null;
}
