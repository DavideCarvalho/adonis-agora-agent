import type { PoppyEvent, PoppyEventBody } from './protocol.js';
import {
  newEventId,
  type PoppyConversationPatch,
  type PoppyConversationRecord,
  type PoppyMessageClaim,
  type PoppyMessageReceipt,
  type PoppyStore,
  type StoredPoppyEvent,
} from './store.js';

/**
 * The slice of a Redis client {@link redisPoppyStore} uses — an `@adonisjs/redis` connection
 * (ioredis) has it: `redisPoppyStore(redis.connection('main'))`.
 */
export interface PoppyRedisClient {
  get(key: string): Promise<string | null>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  incr(key: string): Promise<number>;
}

export interface RedisPoppyStoreOptions {
  /** Key prefix. Default `'agent:poppy:'`. */
  prefix?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A {@link PoppyStore} shared by every replica, over Redis. Positions come from `INCR`, so two
 * appends never share one; a message claim, an event key and the reader lease are `SET … NX`.
 * Conversations are JSON values; events one key each (`…:evt:<conversation>:<seq>`).
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */
export function redisPoppyStore(
  redis: PoppyRedisClient,
  options: RedisPoppyStoreOptions = {},
): PoppyStore {
  const p = options.prefix ?? 'agent:poppy:';
  const k = {
    conversation: (id: string) => `${p}cnv:${id}`,
    seq: (id: string) => `${p}seq:${id}`,
    event: (id: string, seq: number) => `${p}evt:${id}:${seq}`,
    eventId: (id: string, eventId: string) => `${p}evtid:${id}:${eventId}`,
    eventKey: (id: string, key: string) => `${p}evtkey:${id}:${key}`,
    message: (owner: string, messageId: string) => `${p}msg:${owner}:${messageId}`,
    lease: (id: string) => `${p}lease:${id}`,
  };

  const getConversation = async (id: string): Promise<PoppyConversationRecord | null> => {
    const raw = await redis.get(k.conversation(id));
    return raw === null ? null : (JSON.parse(raw) as PoppyConversationRecord);
  };

  const lastSeq = async (id: string): Promise<number> =>
    Number.parseInt((await redis.get(k.seq(id))) ?? '0', 10) || 0;

  return {
    async createConversation(record) {
      await redis.set(k.conversation(record.id), JSON.stringify(record));
    },
    getConversation,
    async updateConversation(id, patch: PoppyConversationPatch) {
      const current = await getConversation(id);
      if (!current) return;
      await redis.set(
        k.conversation(id),
        JSON.stringify({ ...current, ...patch, updatedAt: Date.now() }),
      );
    },

    async appendEvent(conversationId, body: PoppyEventBody, opts: { key?: string } = {}) {
      if (opts.key !== undefined) {
        const keyKey = k.eventKey(conversationId, opts.key);
        if ((await redis.set(keyKey, 'pending', 'NX')) === null) {
          // Taken: answer the event it points at (once its writer has numbered it).
          for (let i = 0; i < 100; i++) {
            const seq = Number.parseInt((await redis.get(keyKey)) ?? '', 10);
            if (Number.isSafeInteger(seq)) {
              const raw = await redis.get(k.event(conversationId, seq));
              if (raw !== null) {
                return { event: { seq, event: JSON.parse(raw) as PoppyEvent }, created: false };
              }
            }
            await sleep(10);
          }
          throw new Error(`poppy: event key ${opts.key} never resolved`);
        }
      }
      const seq = await redis.incr(k.seq(conversationId));
      const now = Date.now();
      const stored: StoredPoppyEvent = {
        seq,
        event: { id: newEventId(seq), created_at: new Date(now).toISOString(), ...body },
      };
      await redis.set(k.event(conversationId, seq), JSON.stringify(stored.event));
      await redis.set(k.eventId(conversationId, stored.event.id), String(seq));
      if (opts.key !== undefined) {
        await redis.set(k.eventKey(conversationId, opts.key), String(seq));
      }
      return { event: stored, created: true };
    },

    async listEvents(conversationId, afterSeq, limit) {
      const last = await lastSeq(conversationId);
      const pruned = (await getConversation(conversationId))?.prunedSeq ?? 0;
      const seqs: number[] = [];
      for (let seq = Math.max(afterSeq, pruned) + 1; seq <= last && seqs.length < limit; seq++)
        seqs.push(seq);
      if (seqs.length === 0) return [];
      const raws = await redis.mget(...seqs.map((seq) => k.event(conversationId, seq)));
      const out: StoredPoppyEvent[] = [];
      raws.forEach((raw, index) => {
        // A position whose write is still in flight ends the page: nothing is skipped over.
        if (raw === null) return;
        out.push({ seq: seqs[index] as number, event: JSON.parse(raw) as PoppyEvent });
      });
      const firstGap = raws.indexOf(null);
      return firstGap === -1 ? out : out.filter((entry) => entry.seq < (seqs[firstGap] ?? 0));
    },

    async findEventSeq(conversationId, eventId) {
      const raw = await redis.get(k.eventId(conversationId, eventId));
      if (raw === null) return null;
      const seq = Number.parseInt(raw, 10);
      return (await redis.get(k.event(conversationId, seq))) === null ? null : seq;
    },

    async pruneEvents(conversationId, before) {
      const conversation = await getConversation(conversationId);
      const last = await lastSeq(conversationId);
      const from = conversation?.prunedSeq ?? 0;
      let upTo = from;
      const doomed: string[] = [];
      for (let seq = from + 1; seq < last; seq++) {
        const raw = await redis.get(k.event(conversationId, seq));
        if (raw !== null) {
          const event = JSON.parse(raw) as PoppyEvent;
          if (Date.parse(event.created_at) >= before) break;
          doomed.push(k.event(conversationId, seq), k.eventId(conversationId, event.id));
        }
        upTo = seq;
      }
      if (!conversation || upTo === from) return;
      // Readers learn the new floor before the events go, so none mistakes the gap for a write.
      await redis.set(
        k.conversation(conversationId),
        JSON.stringify({ ...conversation, prunedSeq: upTo }),
      );
      if (doomed.length > 0) await redis.del(...doomed);
    },

    async claimMessage(owner, messageId, receipt: PoppyMessageReceipt): Promise<PoppyMessageClaim> {
      const key = k.message(owner, messageId);
      if ((await redis.set(key, JSON.stringify(receipt), 'NX')) !== null) {
        return { status: 'claimed' };
      }
      const raw = await redis.get(key);
      if (raw === null) return this.claimMessage(owner, messageId, receipt);
      return { status: 'existing', ...(JSON.parse(raw) as PoppyMessageReceipt) };
    },

    async releaseMessage(owner, messageId) {
      await redis.del(k.message(owner, messageId));
    },

    async leaseReader(conversationId, holder, ttlMs) {
      const key = k.lease(conversationId);
      if ((await redis.set(key, holder, 'PX', ttlMs, 'NX')) !== null) return true;
      if ((await redis.get(key)) !== holder) return false;
      await redis.set(key, holder, 'PX', ttlMs);
      return true;
    },

    async releaseReader(conversationId, holder) {
      const key = k.lease(conversationId);
      if ((await redis.get(key)) === holder) await redis.del(key);
    },
  };
}
