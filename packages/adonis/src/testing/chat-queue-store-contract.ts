import type { AgentStore } from '../spi/agent-store.js';
import type { ChatQueueStore } from '../spi/chat-queue.js';
import type { MessageAttachment } from '../types.js';

/** A store under test, with one thread already created for `actorRef`. */
export interface ChatQueueContractSubject {
  store: AgentStore & ChatQueueStore;
  threadId: string;
}

/** One behaviour every {@link ChatQueueStore} must have. `run` throws on the first mismatch. */
export interface ChatQueueContractCase {
  name: string;
  run: (subject: ChatQueueContractSubject) => Promise<void>;
}

function check(condition: boolean, message: string, actual?: unknown): void {
  if (!condition) {
    throw new Error(actual === undefined ? message : `${message} (got ${JSON.stringify(actual)})`);
  }
}

const ACTOR = { id: 'contract-actor', roles: ['member'], tenantRef: 't1' };

const ATTACHMENT: MessageAttachment = {
  mediaId: 'm1',
  url: 'https://files.test/m1',
  contentType: 'image/png',
  name: 'shot.png',
};

async function contents(subject: ChatQueueContractSubject): Promise<string[]> {
  return (await subject.store.listQueue(subject.threadId)).map((message) => message.content);
}

/**
 * The behaviours a {@link ChatQueueStore} adapter owes the queue: FIFO order with head inserts,
 * round-tripping every field, edits, moves, conditional removal, the pause, and the
 * compare-and-set admission the drain relies on. Framework-agnostic — each case throws — so a store
 * outside this repo (a host's own) can run it from any test runner:
 *
 * ```ts
 * for (const contractCase of CHAT_QUEUE_STORE_CONTRACT) {
 *   it(contractCase.name, async () => contractCase.run(await freshSubject()));
 * }
 * ```
 */
export const CHAT_QUEUE_STORE_CONTRACT: readonly ChatQueueContractCase[] = [
  {
    name: 'keeps FIFO order, with head inserts ahead of everything',
    async run(subject) {
      const { store, threadId } = subject;
      await store.enqueueMessage({ threadId, actor: ACTOR, content: 'a' });
      await store.enqueueMessage({ threadId, actor: ACTOR, content: 'b' });
      await store.enqueueMessage({ threadId, actor: ACTOR, content: 'now', at: 'head' });
      await store.enqueueMessage({ threadId, actor: ACTOR, content: 'c' });
      const order = await contents(subject);
      check(order.join(',') === 'now,a,b,c', 'queue order', order);
    },
  },
  {
    name: 'round-trips every field a queued message carries',
    async run({ store, threadId }) {
      const queued = await store.enqueueMessage({
        threadId,
        actor: ACTOR,
        content: 'with everything',
        attachments: [ATTACHMENT],
        agentName: 'research',
        persona: 'sql',
        model: 'fast-1',
        pageContext: { kind: 'invoice', id: 42 },
        interrupt: true,
      });
      const read = await store.getQueuedMessage(queued.id);
      check(read !== null, 'getQueuedMessage finds it');
      const [listed] = await store.listQueue(threadId);
      for (const message of [queued, read, listed]) {
        check(message?.threadId === threadId, 'threadId', message?.threadId);
        check(JSON.stringify(message?.actor) === JSON.stringify(ACTOR), 'actor', message?.actor);
        check(message?.content === 'with everything', 'content', message?.content);
        check(
          JSON.stringify(message?.attachments) === JSON.stringify([ATTACHMENT]),
          'attachments',
          message?.attachments,
        );
        check(message?.agentName === 'research', 'agentName', message?.agentName);
        check(message?.persona === 'sql', 'persona', message?.persona);
        check(message?.model === 'fast-1', 'model', message?.model);
        check(
          JSON.stringify(message?.pageContext) === JSON.stringify({ kind: 'invoice', id: 42 }),
          'pageContext',
          message?.pageContext,
        );
        check(message?.interrupt === true, 'interrupt', message?.interrupt);
        check(typeof message?.createdAt === 'string', 'createdAt is an ISO string');
      }
      const plain = await store.enqueueMessage({ threadId, actor: ACTOR, content: 'plain' });
      const plainRead = await store.getQueuedMessage(plain.id);
      check(plainRead?.attachments === undefined, 'no attachments → absent', plainRead);
      check(plainRead?.interrupt !== true, 'no interrupt → not an interrupt', plainRead);
      check(plainRead?.persona === undefined, 'no persona → absent', plainRead);
      check((await store.getQueuedMessage('missing')) === null, 'unknown id → null');
    },
  },
  {
    name: 'edits text and attachments, and says when the message is gone',
    async run({ store, threadId }) {
      const queued = await store.enqueueMessage({
        threadId,
        actor: ACTOR,
        content: 'draft',
        attachments: [ATTACHMENT],
      });
      const edited = await store.updateQueuedMessage(queued.id, { content: 'final' });
      check(edited?.content === 'final', 'content edited', edited);
      check(edited?.attachments?.length === 1, 'attachments untouched by a text edit', edited);
      const stripped = await store.updateQueuedMessage(queued.id, { attachments: null });
      check(stripped?.attachments === undefined, 'attachments dropped', stripped);
      check(
        (await store.updateQueuedMessage('missing', { content: 'x' })) === null,
        'editing an unknown message → null',
      );
    },
  },
  {
    name: 'turns a waiting message into an interrupt, and back',
    async run({ store, threadId }) {
      const queued = await store.enqueueMessage({
        threadId,
        actor: ACTOR,
        content: 'now',
        attachments: [ATTACHMENT],
      });
      const promoted = await store.updateQueuedMessage(queued.id, { interrupt: true });
      check(promoted?.interrupt === true, 'the patch answers the interrupt', promoted);
      check(promoted?.content === 'now', 'content untouched by an interrupt patch', promoted);
      check(promoted?.attachments?.length === 1, 'attachments untouched', promoted);
      const read = await store.getQueuedMessage(queued.id);
      check(read?.interrupt === true, 'the interrupt is stored', read);
      const listed = (await store.listQueue(threadId)).find((message) => message.id === queued.id);
      check(listed?.interrupt === true, 'the interrupt is listed', listed);
      const edited = await store.updateQueuedMessage(queued.id, { content: 'now!' });
      check(edited?.interrupt === true, 'a text edit keeps the interrupt', edited);
      const demoted = await store.updateQueuedMessage(queued.id, { interrupt: false });
      check(demoted?.interrupt !== true, 'interrupt: false clears it', demoted);
    },
  },
  {
    name: 'moves a message to an index, clamped',
    async run(subject) {
      const { store, threadId } = subject;
      const a = await store.enqueueMessage({ threadId, actor: ACTOR, content: 'a' });
      await store.enqueueMessage({ threadId, actor: ACTOR, content: 'b' });
      const c = await store.enqueueMessage({ threadId, actor: ACTOR, content: 'c' });
      check(await store.moveQueuedMessage(c.id, 0), 'move reports success');
      check((await contents(subject)).join(',') === 'c,a,b', 'moved to the head');
      check(await store.moveQueuedMessage(c.id, 99), 'move past the end is clamped');
      check((await contents(subject)).join(',') === 'a,b,c', 'moved to the tail');
      check(await store.moveQueuedMessage(a.id, 1), 'move to the middle');
      check((await contents(subject)).join(',') === 'b,a,c', 'moved to the middle');
      // A later enqueue still lands at the tail after a reorder.
      await store.enqueueMessage({ threadId, actor: ACTOR, content: 'd' });
      check((await contents(subject)).join(',') === 'b,a,c,d', 'enqueue after a move');
      check(!(await store.moveQueuedMessage('missing', 0)), 'moving an unknown message → false');
    },
  },
  {
    name: 'removes conditionally, and clears a thread',
    async run(subject) {
      const { store, threadId } = subject;
      const a = await store.enqueueMessage({ threadId, actor: ACTOR, content: 'a' });
      await store.enqueueMessage({ threadId, actor: ACTOR, content: 'b' });
      check(await store.removeQueuedMessage(a.id), 'first removal succeeds');
      check(!(await store.removeQueuedMessage(a.id)), 'second removal of the same id → false');
      check((await contents(subject)).join(',') === 'b', 'the rest stays');
      check((await store.clearQueue(threadId)) === 1, 'clear answers how many it removed');
      check((await store.listQueue(threadId)).length === 0, 'cleared');
    },
  },
  {
    name: 'holds a pause until it is lifted',
    async run({ store, threadId }) {
      check((await store.queuePause(threadId)) === null, 'not paused at first');
      const pause = {
        reason: 'run_failed' as const,
        message: 'model down',
        at: '2026-01-02T03:04:05.000Z',
      };
      await store.setQueuePause(threadId, pause);
      const read = await store.queuePause(threadId);
      check(JSON.stringify(read) === JSON.stringify(pause), 'pause round-trips', read);
      await store.setQueuePause(threadId, null);
      check((await store.queuePause(threadId)) === null, 'pause lifted');
    },
  },
  {
    name: 'admits one run per thread (compare-and-set claim and release)',
    async run({ store, threadId }) {
      check(await store.claimActiveStream(threadId, 'run-a'), 'a free thread is claimed');
      check(await store.claimActiveStream(threadId, 'run-a'), 'a repeated claim is idempotent');
      check(!(await store.claimActiveStream(threadId, 'run-b')), 'a held thread refuses others');
      check((await store.activeRunForThread(threadId)) === 'run-a', 'held by the winner');
      check(
        await store.claimActiveStream(threadId, 'run-b', { replacing: 'run-a' }),
        'handed over by the holder',
      );
      check(
        !(await store.releaseActiveStream(threadId, 'run-a')),
        'a former holder cannot release',
      );
      check((await store.activeRunForThread(threadId)) === 'run-b', 'still held by the new holder');
      check(await store.releaseActiveStream(threadId, 'run-b'), 'the holder releases');
      check((await store.activeRunForThread(threadId)) === null, 'free again');
      check(
        await store.claimActiveStream(threadId, 'run-c', { replacing: 'gone' }),
        'a free thread is claimed whatever it replaces',
      );
      await store.releaseActiveStream(threadId, 'run-c');
      const racers = await Promise.all([
        store.claimActiveStream(threadId, 'racer-1'),
        store.claimActiveStream(threadId, 'racer-2'),
      ]);
      check(racers.filter(Boolean).length === 1, 'exactly one of two racing claims wins', racers);
    },
  },
];
