import { randomBytes } from 'node:crypto';
import type { LucidClientLike, LucidRawRunner } from '../stores/lucid.js';
import { forDialect } from '../stores/lucid-schema.js';
import { isMySql } from '../stores/sql-dialect.js';
import type { Actor } from '../types.js';
import type {
  PoppyContext,
  PoppyEvent,
  PoppyEventBody,
  PoppyResponder,
  PoppyStatus,
} from './protocol.js';

/**
 * A Poppy conversation as this surface keeps it. It belongs to a Personal Agent (`clientId`) and
 * one of its Users (`userId`); once it used an account here, to that account too (`accountRef`,
 * §7.2). The agent side of it is an agent thread (`threadId`) — a Direct Conversation shares its
 * parent's thread, which is how the Company Agent knows what was said in either (§7.10).
 */
export interface PoppyConversationRecord {
  id: string;
  clientId: string;
  userId: string;
  accountRef: string | null;
  agentName: string;
  threadId: string | null;
  /** Set on a Direct Conversation: the conversation it was opened from. */
  parentId: string | null;
  /** On a parent: its open Direct Conversation. */
  openDirectId: string | null;
  status: PoppyStatus;
  responder: PoppyResponder;
  /** The User's context as last shared — fields a message leaves out keep their value (§7.4). */
  context: PoppyContext;
  /** The run whose reply is being written, while there is one. */
  activeRunId: string | null;
  /**
   * The position of the last message event a turn has taken up. The event log IS the turn queue:
   * user messages after it are what the next turn answers — on whichever replica picks it up.
   */
  turnSeq: number;
  /** Who the latest request came as — what the next turn runs as. */
  grant: PoppyGrant | null;
  /** Events at or below this sequence number were pruned: a cursor there is `cursor_expired`. */
  prunedSeq: number;
  createdAt: number;
  updatedAt: number;
}

/** The identity a conversation's turns run as: that of its latest request (§7.11). */
export interface PoppyGrant {
  actor: Actor;
  /** The token's account scopes; empty when signed out. */
  scopes: string[];
  signedIn: boolean;
}

export type PoppyConversationPatch = Partial<
  Pick<
    PoppyConversationRecord,
    | 'accountRef'
    | 'threadId'
    | 'openDirectId'
    | 'status'
    | 'responder'
    | 'context'
    | 'activeRunId'
    | 'turnSeq'
    | 'grant'
    | 'prunedSeq'
  >
>;

/** An event with its position in the conversation. */
export interface StoredPoppyEvent {
  seq: number;
  event: PoppyEvent;
}

/** What an accepted message keeps for its retries (§7.3). */
export interface PoppyMessageReceipt {
  fingerprint: string;
  conversationId: string;
  /** The HTTP status and body the first delivery got. */
  response: { status: number; body: Record<string, unknown> };
}

export type PoppyMessageClaim =
  | { status: 'claimed' }
  | ({ status: 'existing' } & PoppyMessageReceipt);

/**
 * Where conversations, their events and message receipts live. Events are append-only and read by
 * position, so a cursor replays exactly what came after it, on any replica.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */
export interface PoppyStore {
  createConversation(record: PoppyConversationRecord): Promise<void>;
  getConversation(id: string): Promise<PoppyConversationRecord | null>;
  updateConversation(id: string, patch: PoppyConversationPatch): Promise<void>;
  /**
   * Append an event, numbered after the conversation's last. With `key`, at most one event per key
   * is ever appended: a second append answers the first event with `created: false` — what keeps a
   * re-read turn from writing its reply twice.
   */
  appendEvent(
    conversationId: string,
    body: PoppyEventBody,
    options?: { key?: string },
  ): Promise<{ event: StoredPoppyEvent; created: boolean }>;
  /** Events after `afterSeq`, in order, at most `limit`. */
  listEvents(conversationId: string, afterSeq: number, limit: number): Promise<StoredPoppyEvent[]>;
  /** The position of an event, `null` when the conversation has no such event (any more). */
  findEventSeq(conversationId: string, eventId: string): Promise<number | null>;
  /** Drop the events created before `before` (epoch ms), keeping at least the last one. */
  pruneEvents(conversationId: string, before: number): Promise<void>;
  /** Claim `messageId` for `owner` — atomically, so two deliveries of one message are one. */
  claimMessage(
    owner: string,
    messageId: string,
    receipt: PoppyMessageReceipt,
  ): Promise<PoppyMessageClaim>;
  /** Drop a claim whose message could not be taken, so its retry is processed afresh. */
  releaseMessage(owner: string, messageId: string): Promise<void>;
  /**
   * Take (or renew) the right to write the reply of the conversation's active run for `ttlMs` —
   * `false` while another holder's lease is live. What lets any replica pick up a reply whose
   * writer died, without two writing it at once.
   */
  leaseReader(conversationId: string, holder: string, ttlMs: number): Promise<boolean>;
  releaseReader(conversationId: string, holder: string): Promise<void>;
}

/** `evt_<seq in base 36>_<random>`: unique, and its position survives the event being pruned. */
export function newEventId(seq: number): string {
  return `evt_${seq.toString(36)}_${randomBytes(6).toString('base64url')}`;
}

/** The position an event id was minted at, or `null` for an id this surface never minted. */
export function eventIdSeq(id: string): number | null {
  const match = /^evt_([0-9a-z]{1,11})_[A-Za-z0-9_-]+$/.exec(id);
  if (!match?.[1]) return null;
  const seq = Number.parseInt(match[1], 36);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

function toEvent(seq: number, body: PoppyEventBody, now: number): StoredPoppyEvent {
  return {
    seq,
    event: { id: newEventId(seq), created_at: new Date(now).toISOString(), ...body },
  };
}

// ── In memory ─────────────────────────────────────────────────────────────────

/** Process-local {@link PoppyStore} — tests and single-instance dev. */
export class InMemoryPoppyStore implements PoppyStore {
  readonly #conversations = new Map<string, PoppyConversationRecord>();
  readonly #events = new Map<string, { seq: number; event: PoppyEvent; key: string | null }[]>();
  readonly #messages = new Map<string, PoppyMessageReceipt>();
  readonly #leases = new Map<string, { holder: string; until: number }>();

  async createConversation(record: PoppyConversationRecord): Promise<void> {
    this.#conversations.set(record.id, structuredClone(record));
  }

  async getConversation(id: string): Promise<PoppyConversationRecord | null> {
    const found = this.#conversations.get(id);
    return found ? structuredClone(found) : null;
  }

  async updateConversation(id: string, patch: PoppyConversationPatch): Promise<void> {
    const found = this.#conversations.get(id);
    if (!found) return;
    Object.assign(found, structuredClone(patch), { updatedAt: Date.now() });
  }

  async appendEvent(conversationId: string, body: PoppyEventBody, options: { key?: string } = {}) {
    const list = this.#events.get(conversationId) ?? [];
    this.#events.set(conversationId, list);
    if (options.key !== undefined) {
      const existing = list.find((entry) => entry.key === options.key);
      if (existing) {
        return { event: { seq: existing.seq, event: existing.event }, created: false };
      }
    }
    const conversation = this.#conversations.get(conversationId);
    const last = list.at(-1)?.seq ?? conversation?.prunedSeq ?? 0;
    const stored = toEvent(last + 1, body, Date.now());
    list.push({ ...stored, key: options.key ?? null });
    return { event: structuredClone(stored), created: true };
  }

  async listEvents(conversationId: string, afterSeq: number, limit: number) {
    return (this.#events.get(conversationId) ?? [])
      .filter((entry) => entry.seq > afterSeq)
      .slice(0, limit)
      .map((entry) => structuredClone({ seq: entry.seq, event: entry.event }));
  }

  async findEventSeq(conversationId: string, eventId: string): Promise<number | null> {
    return (
      (this.#events.get(conversationId) ?? []).find((entry) => entry.event.id === eventId)?.seq ??
      null
    );
  }

  async pruneEvents(conversationId: string, before: number): Promise<void> {
    const list = this.#events.get(conversationId) ?? [];
    const cutoff = new Date(before).toISOString();
    const last = list.at(-1);
    const keep = list.filter((entry) => entry === last || entry.event.created_at >= cutoff);
    const dropped = list.filter((entry) => !keep.includes(entry));
    if (dropped.length === 0) return;
    this.#events.set(conversationId, keep);
    const conversation = this.#conversations.get(conversationId);
    if (conversation) {
      conversation.prunedSeq = Math.max(conversation.prunedSeq, ...dropped.map((e) => e.seq));
    }
  }

  async claimMessage(owner: string, messageId: string, receipt: PoppyMessageReceipt) {
    const key = `${owner}\n${messageId}`;
    const found = this.#messages.get(key);
    if (found) return { status: 'existing' as const, ...structuredClone(found) };
    this.#messages.set(key, structuredClone(receipt));
    return { status: 'claimed' as const };
  }

  async releaseMessage(owner: string, messageId: string): Promise<void> {
    this.#messages.delete(`${owner}\n${messageId}`);
  }

  async leaseReader(conversationId: string, holder: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const lease = this.#leases.get(conversationId);
    if (lease && lease.holder !== holder && lease.until > now) return false;
    this.#leases.set(conversationId, { holder, until: now + ttlMs });
    return true;
  }

  async releaseReader(conversationId: string, holder: string): Promise<void> {
    if (this.#leases.get(conversationId)?.holder === holder) this.#leases.delete(conversationId);
  }
}

// ── Lucid ─────────────────────────────────────────────────────────────────────

export const POPPY_TABLES = {
  conversations: 'agent_poppy_conversation',
  events: 'agent_poppy_event',
  messages: 'agent_poppy_message',
} as const;

/**
 * `CREATE TABLE IF NOT EXISTS` DDL for the Poppy tables — the agent tables' portable dialect
 * (quoted identifiers, epoch-ms `BIGINT`, `TEXT` JSON; `forDialect` adapts it to MySQL). An event's
 * primary key is its position, so two appends racing for one position cannot both win; a message's
 * is its (owner, id), the idempotency lock of §7.3.
 */
export function poppyTableStatements(): string[] {
  const t = POPPY_TABLES;
  return [
    `CREATE TABLE IF NOT EXISTS "${t.conversations}" (
      "id" VARCHAR(255) PRIMARY KEY NOT NULL,
      "client_id" VARCHAR(2048) NOT NULL,
      "user_id" VARCHAR(255) NOT NULL,
      "account_ref" VARCHAR(255) NULL,
      "agent_name" VARCHAR(255) NOT NULL,
      "thread_id" VARCHAR(255) NULL,
      "parent_id" VARCHAR(255) NULL,
      "open_direct_id" VARCHAR(255) NULL,
      "status" VARCHAR(16) NOT NULL,
      "responder" VARCHAR(16) NOT NULL,
      "context" TEXT NULL,
      "active_run_id" VARCHAR(255) NULL,
      "turn_seq" BIGINT NOT NULL,
      "grant_info" TEXT NULL,
      "reader_holder" VARCHAR(255) NULL,
      "reader_until" BIGINT NULL,
      "pruned_seq" BIGINT NOT NULL,
      "created_at" BIGINT NOT NULL,
      "updated_at" BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS "${t.events}" (
      "conversation_id" VARCHAR(255) NOT NULL,
      "seq" BIGINT NOT NULL,
      "id" VARCHAR(64) NOT NULL,
      "type" VARCHAR(64) NOT NULL,
      "event" TEXT NOT NULL,
      "event_key" VARCHAR(255) NULL,
      "created_at" BIGINT NOT NULL,
      PRIMARY KEY ("conversation_id", "seq")
    )`,
    `CREATE TABLE IF NOT EXISTS "${t.messages}" (
      "owner" VARCHAR(64) NOT NULL,
      "message_id" VARCHAR(256) NOT NULL,
      "fingerprint" VARCHAR(64) NOT NULL,
      "conversation_id" VARCHAR(255) NOT NULL,
      "response" TEXT NOT NULL,
      "created_at" BIGINT NOT NULL,
      PRIMARY KEY ("owner", "message_id")
    )`,
  ];
}

/** Create the Poppy tables if missing. Idempotent. */
export async function ensurePoppyTables(db: LucidRawRunner): Promise<void> {
  const mysql = isMySql(db);
  for (const statement of poppyTableStatements()) {
    await db.rawQuery(forDialect(statement, mysql));
  }
}

function toInt(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number.parseInt(value, 10) || 0;
  return 0;
}

const nullable = (value: unknown) => (value == null ? null : String(value));

const PATCH_COLUMNS: Record<keyof PoppyConversationPatch, string> = {
  accountRef: 'account_ref',
  threadId: 'thread_id',
  openDirectId: 'open_direct_id',
  status: 'status',
  responder: 'responder',
  context: 'context',
  activeRunId: 'active_run_id',
  turnSeq: 'turn_seq',
  grant: 'grant_info',
  prunedSeq: 'pruned_seq',
};

export interface LucidPoppyStoreOptions {
  /** Create the tables on first use (`CREATE TABLE IF NOT EXISTS`). Default `true`. */
  autoCreateTables?: boolean;
}

/** {@link PoppyStore} over Lucid (any of SQLite / Postgres / MySQL). */
export class LucidPoppyStore implements PoppyStore {
  #ready: Promise<void> | null = null;
  readonly #autoCreate: boolean;

  constructor(
    private readonly db: LucidClientLike & LucidRawRunner,
    options: LucidPoppyStoreOptions = {},
  ) {
    this.#autoCreate = options.autoCreateTables ?? true;
  }

  /** Provision the tables (once). A failure is retried on the next call. */
  ready(): Promise<void> {
    if (!this.#autoCreate) return Promise.resolve();
    if (this.#ready === null) {
      this.#ready = ensurePoppyTables(this.db);
      this.#ready.catch(() => {
        this.#ready = null;
      });
    }
    return this.#ready;
  }

  async createConversation(record: PoppyConversationRecord): Promise<void> {
    await this.ready();
    await this.db.table(POPPY_TABLES.conversations).insert({
      id: record.id,
      client_id: record.clientId,
      user_id: record.userId,
      account_ref: record.accountRef,
      agent_name: record.agentName,
      thread_id: record.threadId,
      parent_id: record.parentId,
      open_direct_id: record.openDirectId,
      status: record.status,
      responder: record.responder,
      context: JSON.stringify(record.context),
      active_run_id: record.activeRunId,
      turn_seq: record.turnSeq,
      grant_info: record.grant === null ? null : JSON.stringify(record.grant),
      reader_holder: null,
      reader_until: null,
      pruned_seq: record.prunedSeq,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    });
  }

  async getConversation(id: string): Promise<PoppyConversationRecord | null> {
    await this.ready();
    const row = await this.db.from(POPPY_TABLES.conversations).where('id', id).first();
    if (!row) return null;
    return {
      id: String(row.id),
      clientId: String(row.client_id),
      userId: String(row.user_id),
      accountRef: nullable(row.account_ref),
      agentName: String(row.agent_name),
      threadId: nullable(row.thread_id),
      parentId: nullable(row.parent_id),
      openDirectId: nullable(row.open_direct_id),
      status: String(row.status) as PoppyStatus,
      responder: String(row.responder) as PoppyResponder,
      context: row.context == null ? {} : (JSON.parse(String(row.context)) as PoppyContext),
      activeRunId: nullable(row.active_run_id),
      turnSeq: toInt(row.turn_seq),
      grant: row.grant_info == null ? null : (JSON.parse(String(row.grant_info)) as PoppyGrant),
      prunedSeq: toInt(row.pruned_seq),
      createdAt: toInt(row.created_at),
      updatedAt: toInt(row.updated_at),
    };
  }

  async updateConversation(id: string, patch: PoppyConversationPatch): Promise<void> {
    await this.ready();
    const row: Record<string, unknown> = { updated_at: Date.now() };
    for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
      const value = patch[key as keyof PoppyConversationPatch];
      if (value === undefined) continue;
      row[column] =
        key === 'context' || (key === 'grant' && value !== null) ? JSON.stringify(value) : value;
    }
    await this.db.from(POPPY_TABLES.conversations).where('id', id).update(row);
  }

  async appendEvent(conversationId: string, body: PoppyEventBody, options: { key?: string } = {}) {
    await this.ready();
    for (let attempt = 0; ; attempt++) {
      if (options.key !== undefined) {
        const existing = await this.db
          .from(POPPY_TABLES.events)
          .where('conversation_id', conversationId)
          .where('event_key', options.key)
          .first();
        if (existing) {
          return {
            event: {
              seq: toInt(existing.seq),
              event: JSON.parse(String(existing.event)) as PoppyEvent,
            },
            created: false,
          };
        }
      }
      const last = await this.db
        .from(POPPY_TABLES.events)
        .where('conversation_id', conversationId)
        .orderBy('seq', 'desc')
        .limit(1)
        .first();
      const floor =
        last === null
          ? ((await this.getConversation(conversationId))?.prunedSeq ?? 0)
          : toInt(last.seq);
      const now = Date.now();
      const stored = toEvent(floor + 1, body, now);
      try {
        await this.db.table(POPPY_TABLES.events).insert({
          conversation_id: conversationId,
          seq: stored.seq,
          id: stored.event.id,
          type: body.type,
          event: JSON.stringify(stored.event),
          event_key: options.key ?? null,
          created_at: now,
        });
        return { event: stored, created: true };
      } catch (error) {
        // Another append took this position first: number this one after it.
        if (attempt >= 20) throw error;
      }
    }
  }

  async listEvents(conversationId: string, afterSeq: number, limit: number) {
    await this.ready();
    const rows = await this.db
      .from(POPPY_TABLES.events)
      .where('conversation_id', conversationId)
      .where('seq', '>', afterSeq)
      .orderBy('seq', 'asc')
      .limit(limit)
      .select('seq', 'event');
    return rows.map((row) => ({
      seq: toInt(row.seq),
      event: JSON.parse(String(row.event)) as PoppyEvent,
    }));
  }

  async findEventSeq(conversationId: string, eventId: string): Promise<number | null> {
    await this.ready();
    const row = await this.db
      .from(POPPY_TABLES.events)
      .where('conversation_id', conversationId)
      .where('id', eventId)
      .first();
    return row ? toInt(row.seq) : null;
  }

  async pruneEvents(conversationId: string, before: number): Promise<void> {
    await this.ready();
    const last = await this.db
      .from(POPPY_TABLES.events)
      .where('conversation_id', conversationId)
      .orderBy('seq', 'desc')
      .limit(1)
      .first();
    if (!last) return;
    const dropped = await this.db
      .from(POPPY_TABLES.events)
      .where('conversation_id', conversationId)
      .where('created_at', '<', before)
      .where('seq', '<', toInt(last.seq))
      .orderBy('seq', 'desc')
      .limit(1)
      .first();
    if (!dropped) return;
    const upTo = toInt(dropped.seq);
    await this.db
      .from(POPPY_TABLES.events)
      .where('conversation_id', conversationId)
      .where('seq', '<=', upTo)
      .delete();
    const conversation = await this.getConversation(conversationId);
    if (conversation && conversation.prunedSeq < upTo) {
      await this.updateConversation(conversationId, { prunedSeq: upTo });
    }
  }

  async claimMessage(owner: string, messageId: string, receipt: PoppyMessageReceipt) {
    await this.ready();
    try {
      await this.db.table(POPPY_TABLES.messages).insert({
        owner,
        message_id: messageId,
        fingerprint: receipt.fingerprint,
        conversation_id: receipt.conversationId,
        response: JSON.stringify(receipt.response),
        created_at: Date.now(),
      });
      return { status: 'claimed' as const };
    } catch (error) {
      const row = await this.db
        .from(POPPY_TABLES.messages)
        .where('owner', owner)
        .where('message_id', messageId)
        .first();
      if (!row) throw error;
      return {
        status: 'existing' as const,
        fingerprint: String(row.fingerprint),
        conversationId: String(row.conversation_id),
        response: JSON.parse(String(row.response)) as PoppyMessageReceipt['response'],
      };
    }
  }

  async releaseMessage(owner: string, messageId: string): Promise<void> {
    await this.ready();
    await this.db
      .from(POPPY_TABLES.messages)
      .where('owner', owner)
      .where('message_id', messageId)
      .delete();
  }

  async leaseReader(conversationId: string, holder: string, ttlMs: number): Promise<boolean> {
    await this.ready();
    const now = Date.now();
    const row = await this.db.from(POPPY_TABLES.conversations).where('id', conversationId).first();
    if (!row) return false;
    const current = nullable(row.reader_holder);
    if (current !== null && current !== holder && toInt(row.reader_until) > now) return false;
    // Compare-and-set on what was read: of two takers, the second matches nothing.
    let query = this.db.from(POPPY_TABLES.conversations).where('id', conversationId);
    query =
      current === null
        ? query.whereNull('reader_holder')
        : query.where('reader_holder', current).where('reader_until', toInt(row.reader_until));
    await query.update({ reader_holder: holder, reader_until: now + ttlMs });
    const after = await this.db
      .from(POPPY_TABLES.conversations)
      .where('id', conversationId)
      .first();
    return nullable(after?.reader_holder) === holder;
  }

  async releaseReader(conversationId: string, holder: string): Promise<void> {
    await this.ready();
    await this.db
      .from(POPPY_TABLES.conversations)
      .where('id', conversationId)
      .where('reader_holder', holder)
      .update({ reader_holder: null, reader_until: null });
  }
}
