import type { ToolCallOutcome } from '../dangling-tool-calls.js';
import type {
  AgentStore,
  AppendMessageInput,
  CreateThreadInput,
  RecordRunEndInput,
  RecordRunStartInput,
  RecordToolCallInput,
  RecordUsageInput,
  ThreadTurnPage,
  ThreadTurnQuery,
  ThreadTurnReader,
  UpdateThreadInput,
  UpdateToolCallInput,
} from '../spi/agent-store.js';
import {
  type ToolCallApprovalColumns,
  type ToolCallApprovalState,
  toolCallApprovalFromRow,
} from '../spi/approval-policy.js';
import type {
  ChatQueueStore,
  EnqueueMessageInput,
  QueuedMessage,
  QueuedMessagePatch,
  QueuePause,
} from '../spi/chat-queue.js';
import type { AgentUiComponent } from '../stream-events.js';
import type { ToolConfirmation } from '../tool-presentation.js';
import type {
  Actor,
  MessageAttachment,
  MessageFeedback,
  MessageRole,
  MessageUsage,
  PageContext,
  StoredMessage,
  ThreadDetail,
  ThreadSummary,
  ToolCallApproval,
  ToolCallRequest,
  ToolCallStatus,
  ToolResult,
} from '../types.js';
import { AGENT_TABLES, ensureAgentTables } from './lucid-schema.js';

// ── Structural Lucid typing (copied from telescope) ──────────────────────────
// The store touches only this slice of an AdonisJS Lucid `Database`, typed structurally so
// `@adonisjs/lucid` stays an *optional peer*: the store file imports no lucid types. The factory
// passes the real `db` in (cast), and it satisfies these shapes (Knex-backed query builder).

/** The chainable query-builder surface the store leans on (Knex-shaped). */
export interface LucidQueryBuilderLike {
  where(column: string, value: unknown): this;
  where(column: string, operator: string, value: unknown): this;
  whereNull(column: string): this;
  whereIn(column: string, values: readonly unknown[]): this;
  orderBy(column: string, direction: 'asc' | 'desc'): this;
  limit(value: number): this;
  offset(value: number): this;
  first(): Promise<Record<string, unknown> | null>;
  select(...columns: string[]): Promise<Record<string, unknown>[]>;
  update(row: Record<string, unknown>): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface LucidInsertBuilderLike {
  insert(row: Record<string, unknown>): Promise<unknown>;
}

/** A query client — the base connection or a transaction client (both expose `from`/`table`). */
export interface LucidClientLike {
  from(table: string): LucidQueryBuilderLike;
  table(table: string): LucidInsertBuilderLike;
}

/**
 * Bindings a raw query accepts: positional (an array) or named (an object). Deliberately a SUPERTYPE
 * of Lucid's own `RawQueryBindings` (`StrictValues[] | { [key: string]: StrictValues }`) rather than a
 * narrower guess.
 *
 * It used to be `unknown[]`, and that silently excluded the very client the migration stub passes in.
 * A method parameter is checked bivariantly, so a candidate satisfies this interface if EITHER
 * direction assigns — but `unknown[]` assigned in neither: not to `StrictValues[]` (an `unknown`
 * element is not a `StrictValue`), and `RawQueryBindings` not to `unknown[]` (the named-bindings
 * object is not an array). So `QueryClientContract` — what `db.connection(name)` returns — failed to
 * match, only the `Database` manager did (its `bindings?: any` matches anything), and the published
 * migration did not compile in a consumer app.
 *
 * Widening to `readonly unknown[] | Record<string, unknown>` makes `RawQueryBindings` assignable in
 * the outward direction, so every real Lucid client matches. It stays a structural mirror: nothing
 * here imports `@adonisjs/lucid`, which is what keeps it an optional peer.
 */
export type LucidRawBindings = readonly unknown[] | Record<string, unknown>;

/**
 * A raw SQL runner — the ONLY capability the schema helpers need. Kept separate from
 * {@link LucidDatabaseLike} so `createAgentTables` and friends ask for exactly what they use: both the
 * `Database` manager and a per-connection `QueryClientContract` satisfy it, which is what lets the
 * published migration scope its DDL with `db.connection(this.db.connectionName)` and honour
 * `migration:run --connection=x`.
 */
export interface LucidRawRunner {
  rawQuery(sql: string, bindings?: LucidRawBindings): Promise<unknown>;
}

/** The `Database` facade slice: a client plus raw SQL (DDL) and transactions. */
export interface LucidDatabaseLike extends LucidClientLike, LucidRawRunner {
  transaction<T>(callback: (trx: LucidClientLike) => Promise<T>): Promise<T>;
}

/**
 * `query` in the order its messages were appended: `seq`, which append assigns, then `created_at`
 * and `id` for the rows from before `seq` existed (they all hold 0, and so sort first). `created_at`
 * alone could not order a transcript: two messages of one turn routinely share a millisecond, and
 * the database then returned them in either order.
 */
export function inAppendOrder<Q extends LucidQueryBuilderLike>(
  query: Q,
  direction: 'asc' | 'desc',
): Q {
  return query.orderBy('seq', direction).orderBy('created_at', direction).orderBy('id', direction);
}

export interface LucidAgentStoreOptions {
  /**
   * Provision the agent tables (via {@link ensureAgentTables}) — as the app starts when the agent
   * provider built the store, else on first use — so the lib manages its own schema, the ecosystem
   * convention (mirrors `@adonis-agora/durable` and `@adonis-agora/authz`).
   * Default `true`. Set `false` to opt out and run the published migration (`createAgentTables` /
   * `node ace configure @adonis-agora/agent`) instead — e.g. when you want the schema versioned.
   * The same flag governs the pricing store and the governance read-model, which share these tables.
   */
  autoCreateTables?: boolean;
}

function toInt(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number.parseInt(value, 10) || 0;
  return 0;
}

function msToIso(value: unknown): string {
  return new Date(toInt(value)).toISOString();
}

function safeJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/**
 * How many rows an `update`/`delete` touched. Knex answers a bare count on SQLite/MySQL and Postgres,
 * Lucid may wrap it in an array, and a raw driver result carries it as `rowCount`/`changes`/
 * `affectedRows` — read whichever is there. Unknown → `0` (a compare-and-set that cannot prove it
 * won must say it lost).
 */
function affectedRows(result: unknown): number {
  if (typeof result === 'number') return result;
  if (typeof result === 'bigint') return Number(result);
  if (Array.isArray(result)) return result.length === 0 ? 0 : affectedRows(result[0]);
  if (typeof result === 'object' && result !== null) {
    const record = result as Record<string, unknown>;
    for (const key of ['rowCount', 'changes', 'affectedRows'] as const) {
      if (typeof record[key] === 'number') return record[key];
    }
  }
  return 0;
}

function queuedMessageFromRow(row: Record<string, unknown>): QueuedMessage {
  const attachments = parseJson<MessageAttachment[]>(row.attachments);
  const pageContext = parseJson<PageContext>(row.page_context);
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    actor: parseJson<Actor>(row.actor) ?? { id: '' },
    content: String(row.content ?? ''),
    ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
    ...(typeof row.agent_name === 'string' ? { agentName: row.agent_name } : {}),
    ...(typeof row.persona === 'string' && row.persona.length > 0 ? { persona: row.persona } : {}),
    ...(typeof row.model === 'string' ? { model: row.model } : {}),
    ...(pageContext !== undefined ? { pageContext } : {}),
    ...(toInt(row.interrupt) === 1 ? { interrupt: true } : {}),
    createdAt: msToIso(row.created_at),
    updatedAt: msToIso(row.updated_at),
  };
}

function parseJson<T>(text: unknown): T | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/**
 * The message columns a model turn reads. `usage`, `follow_ups` and `run_id` stay in the table: they
 * are the thread reader's bookkeeping, not part of the prompt.
 */
const TURN_MESSAGE_COLUMNS = [
  'id',
  'role',
  'content',
  'persona',
  'tool_calls',
  'tool_results',
  'attachments',
  'created_at',
] as const;

/**
 * A production-grade, persistent {@link AgentStore} backed by AdonisJS **Lucid** (Knex) over the five
 * agent tables (threads, messages, tool calls, token usage, model pricing). JSON payloads are stored
 * as TEXT and timestamps as epoch-ms integers, so it is portable across SQLite / Postgres / MySQL and
 * is the behavioral twin of the in-memory store.
 *
 * `forkThread` / `truncateFrom` run in a transaction (cheap safety); `truncateFrom` deletes the
 * doomed messages' tool calls explicitly (not only via FK cascade) so it works on SQLite even without
 * `PRAGMA foreign_keys=ON`. The tool-call PK is always the model-supplied `toolCallId`.
 *
 * Usually you don't construct this directly: `config/agent.ts` selects it via `stores.lucid({ ... })`
 * and the provider builds it, lazily importing `@adonisjs/lucid` only when the `lucid` store is chosen.
 */
export class LucidAgentStore implements AgentStore, ThreadTurnReader, ChatQueueStore {
  private readonly autoCreateTables: boolean;
  private ready: Promise<void> | null = null;

  constructor(
    private readonly db: LucidDatabaseLike,
    options: LucidAgentStoreOptions = {},
  ) {
    this.autoCreateTables = options.autoCreateTables ?? true;
  }

  private init(): Promise<void> {
    if (this.ready === null) {
      const ready = this.autoCreateTables ? ensureAgentTables(this.db) : Promise.resolve();
      // A failed provisioning is not remembered: the next call tries again.
      ready.catch(() => {
        if (this.ready === ready) this.ready = null;
      });
      this.ready = ready;
    }
    return this.ready;
  }

  /**
   * Provision (or repair) the agent tables now. The agent provider calls this once as the app starts,
   * so no request — and no transaction a caller happens to have open — ever pays for DDL. Idempotent;
   * a no-op under `autoCreateTables: false`. Every other method still awaits it, which is what keeps
   * a store built by hand (no provider) working.
   */
  ensureSchema(): Promise<void> {
    return this.init();
  }

  async createThread(input: CreateThreadInput): Promise<ThreadSummary> {
    await this.init();
    const id = input.id ?? crypto.randomUUID();
    const now = Date.now();
    await this.db.table(AGENT_TABLES.threads).insert({
      id,
      actor_ref: input.actor.id,
      tenant_ref: input.actor.tenantRef ?? null,
      title: input.title ?? 'New chat',
      // NOT NULL since the first schema: an empty string is "none pinned" (see `pinnedPersona`).
      persona: input.persona ?? '',
      transient: input.transient ? 1 : 0,
      pinned_at: null,
      summary: null,
      summary_message_count: 0,
      active_stream_id: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    return {
      id,
      title: input.title ?? 'New chat',
      persona: pinnedPersona(input.persona),
      transient: input.transient ?? false,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
  }

  async getThread(threadId: string): Promise<ThreadDetail | null> {
    await this.init();
    const row = await this.db
      .from(AGENT_TABLES.threads)
      .where('id', threadId)
      .whereNull('deleted_at')
      .first();
    if (row === null || row === undefined) return null;
    const messageRows = await inAppendOrder(
      this.db.from(AGENT_TABLES.messages).where('thread_id', threadId),
      'asc',
    ).select('*');
    const messages = await this.withApprovals(messageRows.map(rowToMessage));
    const last = messages[messages.length - 1];
    return {
      ...threadRowToSummary(row, last?.content),
      messages,
    };
  }

  async loadThreadForTurn(query: ThreadTurnQuery): Promise<ThreadTurnPage | null> {
    await this.init();
    const row = await this.db
      .from(AGENT_TABLES.threads)
      .where('id', query.threadId)
      .whereNull('deleted_at')
      .first();
    if (row === null || row === undefined) return null;
    const answered = await this.db
      .from(AGENT_TABLES.messages)
      .where('thread_id', query.threadId)
      .where('role', 'assistant')
      .limit(1)
      .select('id');
    return {
      title: String(row.title),
      hasAssistantMessage: answered.length > 0,
      messages: await this.loadTurnWindow(query.threadId, query.messageLimit),
    };
  }

  /**
   * The newest `limit` messages, oldest-first, projected to the columns a model turn reads. The
   * bound is the database's: a `limit` on rows ordered newest-first, so a long thread's older rows
   * are never materialized at all.
   */
  private async loadTurnWindow(
    threadId: string,
    limit: number | undefined,
  ): Promise<StoredMessage[]> {
    if (limit !== undefined && limit <= 0) return [];
    const query = inAppendOrder(
      this.db.from(AGENT_TABLES.messages).where('thread_id', threadId),
      'desc',
    );
    if (limit !== undefined) query.limit(limit);
    const rows = await query.select(...TURN_MESSAGE_COLUMNS);
    return rows.reverse().map(rowToMessage);
  }

  async getThreadActorRef(threadId: string): Promise<string | null> {
    await this.init();
    const row = await this.db
      .from(AGENT_TABLES.threads)
      .where('id', threadId)
      .whereNull('deleted_at')
      .first();
    if (row === null || row === undefined) return null;
    return String(row.actor_ref);
  }

  async listThreads(actorRef: string, limit = 50): Promise<ThreadSummary[]> {
    await this.init();
    const rows = await this.db
      .from(AGENT_TABLES.threads)
      .where('actor_ref', actorRef)
      .where('transient', 0)
      .whereNull('deleted_at')
      .orderBy('updated_at', 'desc')
      .limit(limit)
      .select('*');
    return rows.map((row) => threadRowToSummary(row));
  }

  async promoteThread(threadId: string): Promise<void> {
    await this.init();
    await this.db
      .from(AGENT_TABLES.threads)
      .where('id', threadId)
      .where('transient', 1)
      .update({ transient: 0, updated_at: Date.now() });
  }

  async softDeleteThread(threadId: string): Promise<void> {
    await this.init();
    await this.db
      .from(AGENT_TABLES.threads)
      .where('id', threadId)
      .update({ deleted_at: Date.now() });
  }

  async forkThread(threadId: string, fromMessageId: string): Promise<ThreadSummary> {
    await this.init();
    return this.db.transaction(async (trx) => {
      const source = await trx.from(AGENT_TABLES.threads).where('id', threadId).first();
      if (source === null || source === undefined) {
        throw new Error(`thread ${threadId} not found`);
      }
      const messageRows = await inAppendOrder(
        trx.from(AGENT_TABLES.messages).where('thread_id', threadId),
        'asc',
      ).select('*');
      const cutoff = messageRows.findIndex((m) => String(m.id) === fromMessageId);
      const kept = cutoff >= 0 ? messageRows.slice(0, cutoff + 1) : messageRows;

      const id = crypto.randomUUID();
      const now = Date.now();
      const title = String(source.title);
      const persona = pinnedPersona(source.persona);
      await trx.table(AGENT_TABLES.threads).insert({
        id,
        actor_ref: source.actor_ref,
        tenant_ref: source.tenant_ref ?? null,
        title,
        persona: persona ?? '',
        transient: 0,
        pinned_at: null,
        summary: null,
        summary_message_count: 0,
        active_stream_id: null,
        model: source.model ?? null,
        default_agent: source.default_agent ?? null,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      });
      for (const [index, m] of kept.entries()) {
        // New message id: the message PK is unique, so a fork copies content under fresh ids.
        await trx.table(AGENT_TABLES.messages).insert({
          id: crypto.randomUUID(),
          // Numbered afresh in the order just read, so the copy reads back in the original's order.
          seq: index + 1,
          thread_id: id,
          role: m.role,
          content: m.content,
          tool_calls: m.tool_calls ?? null,
          tool_results: m.tool_results ?? null,
          attachments: m.attachments ?? null,
          follow_ups: m.follow_ups ?? null,
          usage: m.usage ?? null,
          persona: m.persona ?? null,
          reasoning: m.reasoning ?? null,
          reasoning_ms: m.reasoning_ms ?? null,
          ui: m.ui ?? null,
          ...(typeof m.agent_name === 'string' ? { agent_name: m.agent_name } : {}),
          created_at: toInt(m.created_at),
        });
      }
      return {
        id,
        title,
        persona,
        transient: false,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
    });
  }

  async setTitle(threadId: string, title: string): Promise<void> {
    await this.init();
    await this.db
      .from(AGENT_TABLES.threads)
      .where('id', threadId)
      .update({ title, updated_at: Date.now() });
  }

  async updateThread(threadId: string, patch: UpdateThreadInput): Promise<void> {
    await this.init();
    const update: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.title !== undefined) update.title = patch.title;
    if (patch.model !== undefined) update.model = patch.model;
    if (patch.defaultAgent !== undefined) update.default_agent = patch.defaultAgent;
    if (patch.persona !== undefined) update.persona = patch.persona ?? '';
    await this.db.from(AGENT_TABLES.threads).where('id', threadId).update(update);
  }

  async defaultAgentForThread(threadId: string): Promise<string | null> {
    await this.init();
    const row = await this.db.from(AGENT_TABLES.threads).where('id', threadId).first();
    return typeof row?.default_agent === 'string' ? row.default_agent : null;
  }

  async personaForThread(threadId: string): Promise<string | null> {
    await this.init();
    const row = await this.db.from(AGENT_TABLES.threads).where('id', threadId).first();
    return pinnedPersona(row?.persona);
  }

  async clearActiveStream(threadId: string, runId: string): Promise<void> {
    await this.init();
    await this.db
      .from(AGENT_TABLES.threads)
      .where('id', threadId)
      .where('active_stream_id', runId)
      .update({ active_stream_id: null });
  }

  async setActiveStream(threadId: string, runId: string | null): Promise<void> {
    await this.init();
    await this.db
      .from(AGENT_TABLES.threads)
      .where('id', threadId)
      .update({ active_stream_id: runId });
  }

  // ── Chat queue (ChatQueueStore) ────────────────────────────────────────────

  async activeRunForThread(threadId: string): Promise<string | null> {
    await this.init();
    const row = await this.db.from(AGENT_TABLES.threads).where('id', threadId).first();
    return typeof row?.active_stream_id === 'string' ? row.active_stream_id : null;
  }

  async threadHeldByRun(runId: string): Promise<string | null> {
    await this.init();
    const row = await this.db
      .from(AGENT_TABLES.threads)
      .where('active_stream_id', runId)
      .whereNull('deleted_at')
      .first();
    return row === null || row === undefined ? null : String(row.id);
  }

  /**
   * Compare-and-set, as two conditional updates rather than one `OR` (the structural query builder
   * has no `orWhere`): free → `runId`; else held by `runId` or `replacing` → `runId`. Each statement
   * is atomic and re-checks its own predicate under the row lock, so of two racing claims exactly
   * one matches.
   */
  async claimActiveStream(
    threadId: string,
    runId: string,
    options: { replacing?: string } = {},
  ): Promise<boolean> {
    await this.init();
    const free = await this.db
      .from(AGENT_TABLES.threads)
      .where('id', threadId)
      .whereNull('active_stream_id')
      .update({ active_stream_id: runId });
    if (affectedRows(free) > 0) {
      return true;
    }
    const holders = options.replacing !== undefined ? [runId, options.replacing] : [runId];
    const handed = await this.db
      .from(AGENT_TABLES.threads)
      .where('id', threadId)
      .whereIn('active_stream_id', holders)
      .update({ active_stream_id: runId });
    if (affectedRows(handed) > 0) {
      return true;
    }
    // Zero can still be a win: a MySQL connection without FOUND_ROWS reports CHANGED rows, and
    // re-claiming a thread this run already holds changes nothing. The row says who holds it now.
    const held = await this.db.from(AGENT_TABLES.threads).where('id', threadId).first();
    return held !== null && held !== undefined && held.active_stream_id === runId;
  }

  async releaseActiveStream(threadId: string, runId: string): Promise<boolean> {
    await this.init();
    const released = await this.db
      .from(AGENT_TABLES.threads)
      .where('id', threadId)
      .where('active_stream_id', runId)
      .update({ active_stream_id: null });
    return affectedRows(released) > 0;
  }

  async enqueueMessage(input: EnqueueMessageInput): Promise<QueuedMessage> {
    await this.init();
    const id = crypto.randomUUID();
    const now = Date.now();
    await this.db.transaction(async (trx) => {
      const rows = await trx
        .from(AGENT_TABLES.queuedMessages)
        .where('thread_id', input.threadId)
        .select('position');
      const positions = rows.map((row) => toInt(row.position));
      // The head takes `min - 1` and the tail `max + 1`, so nothing already waiting is rewritten.
      const position =
        positions.length === 0
          ? 0
          : input.at === 'head'
            ? Math.min(...positions) - 1
            : Math.max(...positions) + 1;
      await trx.table(AGENT_TABLES.queuedMessages).insert({
        id,
        thread_id: input.threadId,
        actor: safeJson(input.actor) ?? '{}',
        content: input.content,
        attachments:
          input.attachments !== undefined && input.attachments.length > 0
            ? safeJson(input.attachments)
            : null,
        agent_name: input.agentName ?? null,
        persona: input.persona ?? null,
        model: input.model ?? null,
        page_context: input.pageContext !== undefined ? safeJson(input.pageContext) : null,
        interrupt: input.interrupt === true ? 1 : 0,
        position,
        created_at: now,
        updated_at: now,
      });
    });
    const stored = await this.getQueuedMessage(id);
    if (stored === null) {
      throw new Error(`queued message ${id} vanished after insert`);
    }
    return stored;
  }

  async listQueue(threadId: string): Promise<QueuedMessage[]> {
    await this.init();
    const rows = await this.db
      .from(AGENT_TABLES.queuedMessages)
      .where('thread_id', threadId)
      .orderBy('position', 'asc')
      .select('*');
    return rows.map(queuedMessageFromRow);
  }

  async getQueuedMessage(id: string): Promise<QueuedMessage | null> {
    await this.init();
    const row = await this.db.from(AGENT_TABLES.queuedMessages).where('id', id).first();
    return row === null || row === undefined ? null : queuedMessageFromRow(row);
  }

  async updateQueuedMessage(id: string, patch: QueuedMessagePatch): Promise<QueuedMessage | null> {
    await this.init();
    const update: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.content !== undefined) update.content = patch.content;
    if (patch.attachments !== undefined) {
      update.attachments =
        patch.attachments === null || patch.attachments.length === 0
          ? null
          : safeJson(patch.attachments);
    }
    if (patch.interrupt !== undefined) update.interrupt = patch.interrupt ? 1 : 0;
    const updated = await this.db.from(AGENT_TABLES.queuedMessages).where('id', id).update(update);
    return affectedRows(updated) > 0 ? this.getQueuedMessage(id) : null;
  }

  async moveQueuedMessage(id: string, index: number): Promise<boolean> {
    await this.init();
    return this.db.transaction(async (trx) => {
      const target = await trx.from(AGENT_TABLES.queuedMessages).where('id', id).first();
      if (target === null || target === undefined) {
        return false;
      }
      const rows = await trx
        .from(AGENT_TABLES.queuedMessages)
        .where('thread_id', String(target.thread_id))
        .orderBy('position', 'asc')
        .select('id');
      const order = rows.map((row) => String(row.id)).filter((rowId) => rowId !== id);
      order.splice(Math.max(0, Math.min(order.length, Math.trunc(index))), 0, id);
      // A move rewrites the whole run order as `0..n-1`.
      for (const [position, rowId] of order.entries()) {
        await trx.from(AGENT_TABLES.queuedMessages).where('id', rowId).update({ position });
      }
      return true;
    });
  }

  /** A conditional delete: `false` when the row was already gone (a drain lost its head). */
  async removeQueuedMessage(id: string): Promise<boolean> {
    await this.init();
    const removed = await this.db.from(AGENT_TABLES.queuedMessages).where('id', id).delete();
    return affectedRows(removed) > 0;
  }

  async clearQueue(threadId: string): Promise<number> {
    await this.init();
    const removed = await this.db
      .from(AGENT_TABLES.queuedMessages)
      .where('thread_id', threadId)
      .delete();
    return affectedRows(removed);
  }

  async queuePause(threadId: string): Promise<QueuePause | null> {
    await this.init();
    const row = await this.db.from(AGENT_TABLES.threads).where('id', threadId).first();
    return parseJson<QueuePause>(row?.queue_pause) ?? null;
  }

  async setQueuePause(threadId: string, pause: QueuePause | null): Promise<void> {
    await this.init();
    await this.db
      .from(AGENT_TABLES.threads)
      .where('id', threadId)
      .update({ queue_pause: pause === null ? null : safeJson(pause) });
  }

  async appendMessage(input: AppendMessageInput): Promise<StoredMessage> {
    await this.init();
    const id = crypto.randomUUID();
    const now = Date.now();
    const seq = await this.nextMessageSeq(input.threadId);
    await this.db.table(AGENT_TABLES.messages).insert({
      id,
      seq,
      thread_id: input.threadId,
      role: input.role,
      content: input.content,
      tool_calls: safeJson(input.toolCalls),
      tool_results: safeJson(input.toolResults),
      attachments: safeJson(input.attachments),
      follow_ups: safeJson(input.followUps),
      usage: safeJson(input.usage),
      persona: input.persona ?? null,
      run_id: input.runId ?? null,
      // Only when set: a detached sub-agent's answer is the one message that carries it, so a
      // database whose `agent_name` column has not been added yet keeps every other write working.
      ...(input.agentName !== undefined ? { agent_name: input.agentName } : {}),
      reasoning: input.reasoning ?? null,
      reasoning_ms: input.reasoningMs ?? null,
      ui: safeJson(input.ui),
      created_at: now,
    });
    // Keep the thread's `updated_at` in step so list ordering reflects the latest activity.
    await this.db
      .from(AGENT_TABLES.threads)
      .where('id', input.threadId)
      .update({ updated_at: now });
    return {
      id,
      role: input.role,
      content: input.content,
      createdAt: new Date(now).toISOString(),
      ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
      ...(input.toolResults !== undefined ? { toolResults: input.toolResults } : {}),
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      ...(input.followUps !== undefined ? { followUps: input.followUps } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      ...(input.persona !== undefined ? { persona: input.persona } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
      ...(input.reasoningMs !== undefined ? { reasoningMs: input.reasoningMs } : {}),
      ...(input.ui !== undefined ? { ui: input.ui } : {}),
    };
  }

  /**
   * The next `seq` in a thread: one past its highest. Two appends racing on ONE thread can draw the
   * same number — the turn loop never does that, and the tie then falls back to `created_at`, `id`.
   */
  private async nextMessageSeq(threadId: string): Promise<number> {
    const [last] = await this.db
      .from(AGENT_TABLES.messages)
      .where('thread_id', threadId)
      .orderBy('seq', 'desc')
      .limit(1)
      .select('seq');
    return toInt(last?.seq) + 1;
  }

  async setMessageUi(messageId: string, ui: AgentUiComponent[]): Promise<void> {
    await this.init();
    await this.db
      .from(AGENT_TABLES.messages)
      .where('id', messageId)
      .update({ ui: safeJson(ui) });
  }

  async setMessageToolResults(messageId: string, results: ToolResult[]): Promise<void> {
    await this.init();
    await this.db
      .from(AGENT_TABLES.messages)
      .where('id', messageId)
      .update({ tool_results: safeJson(results) });
  }

  async truncateFrom(threadId: string, messageId: string): Promise<void> {
    await this.init();
    await this.db.transaction(async (trx) => {
      const rows = await inAppendOrder(
        trx.from(AGENT_TABLES.messages).where('thread_id', threadId),
        'asc',
      ).select('id');
      const cutoff = rows.findIndex((m) => String(m.id) === messageId);
      if (cutoff < 0) return;
      const doomed = rows.slice(cutoff).map((m) => String(m.id));
      for (const mid of doomed) {
        // Delete tool calls explicitly (works on SQLite without FK cascade), then the message.
        await trx.from(AGENT_TABLES.toolCalls).where('message_id', mid).delete();
        await trx.from(AGENT_TABLES.messages).where('id', mid).delete();
      }
    });
  }

  /**
   * Of `mediaIds`, the ones a surviving message — or one waiting in a thread's queue — in one of this
   * actor's threads still carries.
   *
   * The match on the attachment's `mediaId` runs here rather than in SQL: the column is JSON text,
   * and every dialect this store targets spells "an array element with this field" differently
   * while none of them could use an index for it. The scan is bounded by ONE actor's
   * attachment-bearing messages.
   * Soft-deleted threads are included: their messages survive, so what they point at is still
   * reachable from stored state.
   */
  async referencedMediaIds(actorRef: string, mediaIds: readonly string[]): Promise<string[]> {
    if (mediaIds.length === 0) {
      return [];
    }
    await this.init();
    const threads = await this.db
      .from(AGENT_TABLES.threads)
      .where('actor_ref', actorRef)
      .select('id');
    if (threads.length === 0) {
      return [];
    }
    const rows = await this.db
      .from(AGENT_TABLES.messages)
      .whereIn(
        'thread_id',
        threads.map((thread) => String(thread.id)),
      )
      .where('attachments', 'is not', null)
      .select('attachments');
    // A message waiting in a thread's queue has been sent and not yet run: what it carries is in use.
    const queued = await this.db
      .from(AGENT_TABLES.queuedMessages)
      .whereIn(
        'thread_id',
        threads.map((thread) => String(thread.id)),
      )
      .where('attachments', 'is not', null)
      .select('attachments');
    const wanted = new Set(mediaIds);
    const found = new Set<string>();
    for (const row of [...rows, ...queued]) {
      for (const attachment of parseJson<MessageAttachment[]>(row.attachments) ?? []) {
        if (wanted.has(attachment.mediaId)) {
          found.add(attachment.mediaId);
        }
      }
    }
    return [...wanted].filter((mediaId) => found.has(mediaId));
  }

  async recordToolCall(input: RecordToolCallInput): Promise<void> {
    await this.init();
    // PK = the model-supplied toolCallId (never a generated id).
    await this.db.table(AGENT_TABLES.toolCalls).insert({
      id: input.toolCallId,
      message_id: input.messageId,
      tool_name: input.toolName,
      tool_type: input.toolType,
      input: safeJson(input.input),
      output: null,
      status: input.status,
      executed_by_ref: null,
      execution_ms: null,
      error: null,
      run_id: input.runId ?? null,
      created_at: Date.now(),
      executed_at: null,
      approver: input.approver ?? null,
      confirmation: input.confirmation !== undefined ? JSON.stringify(input.confirmation) : null,
      expires_at: input.expiresAt !== undefined ? Date.parse(input.expiresAt) : null,
      remember: null,
      decided_via: null,
    });
  }

  async updateToolCall(input: UpdateToolCallInput): Promise<void> {
    await this.init();
    const patch: Record<string, unknown> = { status: input.status };
    if (input.output !== undefined) patch.output = safeJson(input.output);
    if (input.error !== undefined) patch.error = input.error;
    if (input.executionMs !== undefined) patch.execution_ms = input.executionMs;
    if (input.executedByRef !== undefined) patch.executed_by_ref = input.executedByRef;
    if (input.remember !== undefined) patch.remember = input.remember ? 1 : 0;
    if (input.decidedVia !== undefined) patch.decided_via = input.decidedVia;
    if (input.status === 'executed' || input.status === 'failed') patch.executed_at = Date.now();
    await this.db.from(AGENT_TABLES.toolCalls).where('id', input.toolCallId).update(patch);
  }

  /** Attach, per message, the approval record of every call on it a policy put to a person. */
  private async withApprovals(messages: StoredMessage[]): Promise<StoredMessage[]> {
    if (messages.length === 0) return messages;
    const rows = await this.db
      .from(AGENT_TABLES.toolCalls)
      .whereIn(
        'message_id',
        messages.map((message) => message.id),
      )
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .select('*');
    const byMessage = new Map<string, ToolCallApproval[]>();
    for (const call of rows) {
      const approval = toolCallApprovalFromRow(approvalColumns(call));
      if (approval === null) continue;
      const list = byMessage.get(String(call.message_id)) ?? [];
      list.push(approval);
      byMessage.set(String(call.message_id), list);
    }
    return messages.map((message) => {
      const approvals = byMessage.get(message.id);
      return approvals === undefined ? message : { ...message, approvals };
    });
  }

  async rememberedApprovals(threadId: string): Promise<string[]> {
    await this.init();
    const messageIds = (
      await this.db.from(AGENT_TABLES.messages).where('thread_id', threadId).select('id')
    ).map((row) => String(row.id));
    if (messageIds.length === 0) return [];
    const rows = await this.db
      .from(AGENT_TABLES.toolCalls)
      .whereIn('message_id', messageIds)
      .where('remember', 1)
      .select('tool_name');
    return [...new Set(rows.map((row) => String(row.tool_name)))];
  }

  async toolCallApproval(toolCallId: string): Promise<ToolCallApprovalState | null> {
    await this.init();
    const row = await this.db.from(AGENT_TABLES.toolCalls).where('id', toolCallId).first();
    if (row === null || row === undefined) return null;
    return {
      status: String(row.status) as ToolCallStatus,
      approver: typeof row.approver === 'string' ? row.approver : null,
      expiresAt:
        row.expires_at !== null && row.expires_at !== undefined
          ? new Date(toInt(row.expires_at)).toISOString()
          : null,
    };
  }

  async threadOfMessage(messageId: string): Promise<string | null> {
    await this.init();
    const row = await this.db.from(AGENT_TABLES.messages).where('id', messageId).first();
    return row === null || row === undefined ? null : String(row.thread_id);
  }

  async setMessageFeedback(messageId: string, feedback: MessageFeedback | null): Promise<void> {
    await this.init();
    await this.db
      .from(AGENT_TABLES.messages)
      .where('id', messageId)
      .update({ feedback: safeJson(feedback) });
  }

  async toolCallInput(toolCallId: string): Promise<unknown> {
    await this.init();
    const row = await this.db.from(AGENT_TABLES.toolCalls).where('id', toolCallId).first();
    if (row === null || row === undefined) return null;
    return parseJson<unknown>(row.input) ?? null;
  }

  async getToolCallRunId(toolCallId: string): Promise<string | null> {
    await this.init();
    const row = await this.db.from(AGENT_TABLES.toolCalls).where('id', toolCallId).first();
    if (row === null || row === undefined || row.run_id == null) return null;
    return String(row.run_id);
  }

  async toolCallOutcomes(toolCallIds: string[]): Promise<ToolCallOutcome[]> {
    if (toolCallIds.length === 0) return [];
    await this.init();
    const rows = await this.db
      .from(AGENT_TABLES.toolCalls)
      .whereIn('id', toolCallIds)
      .select('id', 'status', 'output', 'error');
    return rows.map((row: Record<string, unknown>) => {
      const output = parseJson<unknown>(row.output);
      return {
        id: String(row.id),
        status: String(row.status) as ToolCallStatus,
        ...(output !== undefined && output !== null ? { output } : {}),
        ...(typeof row.error === 'string' ? { error: row.error } : {}),
      };
    });
  }

  async failUnsettledToolCalls(runId: string, error: string): Promise<number> {
    await this.init();
    const updated = await this.db
      .from(AGENT_TABLES.toolCalls)
      .where('run_id', runId)
      .where('status', 'pending_approval')
      .update({ status: 'failed', error });
    const count = Array.isArray(updated) ? updated[0] : updated;
    return typeof count === 'number' ? count : Number(count ?? 0);
  }

  async recordUsage(input: RecordUsageInput): Promise<void> {
    await this.init();
    await this.db.table(AGENT_TABLES.tokenUsage).insert({
      id: crypto.randomUUID(),
      thread_id: input.threadId,
      actor_ref: input.actorRef,
      message_id: input.messageId ?? null,
      model_id: input.modelId,
      purpose: input.purpose,
      input_tokens: input.usage.inputTokens,
      output_tokens: input.usage.outputTokens,
      cache_write_tokens: input.usage.cacheWriteTokens ?? null,
      cache_read_tokens: input.usage.cacheReadTokens ?? null,
      cost_usd: input.costUsd ?? null,
      run_id: input.runId ?? null,
      created_at: Date.now(),
    });
  }

  async recordRunStart(input: RecordRunStartInput): Promise<void> {
    await this.init();
    await this.db.table(AGENT_TABLES.runs).insert({
      id: input.runId,
      thread_id: input.threadId,
      agent_name: input.agentName ?? null,
      parent_run_id: input.parentRunId ?? null,
      actor_ref: input.actor.id,
      tenant_ref: input.actor.tenantRef ?? null,
      status: 'running',
      started_at: Date.now(),
      finished_at: null,
      step_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: null,
      error: null,
      durable: input.durable ? 1 : 0,
    });
  }

  async getRunActorRef(runId: string): Promise<string | null> {
    await this.init();
    const row = await this.db.from(AGENT_TABLES.runs).where('id', runId).first();
    if (row === null || row === undefined) return null;
    return String(row.actor_ref);
  }

  async recordRunEnd(input: RecordRunEndInput): Promise<void> {
    await this.init();
    const patch: Record<string, unknown> = {
      status: input.status,
      finished_at: input.finishedAt ?? Date.now(),
    };
    if (input.stepCount !== undefined) patch.step_count = input.stepCount;
    if (input.inputTokens !== undefined) patch.input_tokens = input.inputTokens;
    if (input.outputTokens !== undefined) patch.output_tokens = input.outputTokens;
    if (input.costUsd !== undefined) patch.cost_usd = input.costUsd;
    if (input.error !== undefined) patch.error = input.error;
    // First terminal wins: only settle a run still `running`, so a late `completed` from the loop can
    // never overwrite a `failed`/`cancelled` the runner already recorded (idempotent under replay too).
    await this.db
      .from(AGENT_TABLES.runs)
      .where('id', input.runId)
      .where('status', 'running')
      .update(patch);
  }

  async usageBetween(
    actorRef: string,
    fromDay: string,
    toDay: string,
  ): Promise<{ usedTokens: number; costUsd: number }> {
    await this.init();
    const rows = await this.db
      .from(AGENT_TABLES.tokenUsage)
      .where('actor_ref', actorRef)
      .where('created_at', '>=', Date.parse(`${fromDay}T00:00:00.000Z`))
      .where('created_at', '<=', Date.parse(`${toDay}T23:59:59.999Z`))
      .select('input_tokens', 'output_tokens', 'cost_usd');
    let usedTokens = 0;
    let costUsd = 0;
    for (const row of rows) {
      usedTokens += toInt(row.input_tokens) + toInt(row.output_tokens);
      costUsd += row.cost_usd === null || row.cost_usd === undefined ? 0 : Number(row.cost_usd);
    }
    return { usedTokens, costUsd };
  }

  async quotaToday(actorRef: string, day: string): Promise<{ usedTokens: number }> {
    await this.init();
    // Inclusive UTC day window over epoch-ms `created_at`. Cache tokens are subsets of input/output
    // and are NEVER re-added, so summing input+output is the whole-day token spend.
    const start = Date.parse(`${day}T00:00:00.000Z`);
    const end = Date.parse(`${day}T23:59:59.999Z`);
    const rows = await this.db
      .from(AGENT_TABLES.tokenUsage)
      .where('actor_ref', actorRef)
      .where('created_at', '>=', start)
      .where('created_at', '<=', end)
      .select('input_tokens', 'output_tokens');
    const usedTokens = rows.reduce(
      (sum, row) => sum + toInt(row.input_tokens) + toInt(row.output_tokens),
      0,
    );
    return { usedTokens };
  }
}

/**
 * A thread's `persona` column as the pin it stands for. The column is `NOT NULL` (an empty string is
 * "none pinned"), so `null` is never stored; a store written before pins existed holds whatever its
 * thread was created with, which the service reads as a pin only where the agent declares it.
 */
function pinnedPersona(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function threadRowToSummary(row: Record<string, unknown>, lastPreview?: string): ThreadSummary {
  const pinnedAt = row.pinned_at;
  return {
    id: String(row.id),
    title: String(row.title),
    persona: pinnedPersona(row.persona),
    transient: toInt(row.transient) !== 0,
    createdAt: msToIso(row.created_at),
    updatedAt: msToIso(row.updated_at),
    ...(pinnedAt !== null && pinnedAt !== undefined ? { pinnedAt: msToIso(pinnedAt) } : {}),
    ...(lastPreview !== undefined ? { lastMessagePreview: lastPreview.slice(0, 120) } : {}),
    model: typeof row.model === 'string' ? row.model : null,
    defaultAgent: typeof row.default_agent === 'string' ? row.default_agent : null,
    activeRunId: typeof row.active_stream_id === 'string' ? row.active_stream_id : null,
  };
}

/** A tool-call row's approval columns, in the shape the shared mapping reads. */
function approvalColumns(row: Record<string, unknown>): ToolCallApprovalColumns {
  return {
    toolCallId: String(row.id),
    ...(row.confirmation != null
      ? { confirmation: parseJson<ToolConfirmation>(row.confirmation) }
      : {}),
    status: String(row.status) as ToolCallStatus,
    approver: typeof row.approver === 'string' ? row.approver : null,
    expiresAt:
      row.expires_at !== null && row.expires_at !== undefined
        ? new Date(toInt(row.expires_at)).toISOString()
        : null,
    remember:
      row.remember === null || row.remember === undefined ? null : toInt(row.remember) === 1,
    executedByRef: typeof row.executed_by_ref === 'string' ? row.executed_by_ref : null,
    decidedVia: typeof row.decided_via === 'string' ? row.decided_via : null,
    error: typeof row.error === 'string' ? row.error : null,
  };
}

function rowToMessage(row: Record<string, unknown>): StoredMessage {
  const toolCalls = parseJson<ToolCallRequest[]>(row.tool_calls);
  const toolResults = parseJson<ToolResult[]>(row.tool_results);
  const attachments = parseJson<MessageAttachment[]>(row.attachments);
  const followUps = parseJson<string[]>(row.follow_ups);
  const usage = parseJson<MessageUsage>(row.usage);
  const ui = parseJson<AgentUiComponent[]>(row.ui);
  const feedback = parseJson<MessageFeedback>(row.feedback);
  return {
    id: String(row.id),
    role: String(row.role) as MessageRole,
    content: String(row.content),
    createdAt: msToIso(row.created_at),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(toolResults !== undefined ? { toolResults } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(followUps !== undefined ? { followUps } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(typeof row.persona === 'string' ? { persona: row.persona } : {}),
    ...(typeof row.run_id === 'string' ? { runId: row.run_id } : {}),
    ...(typeof row.agent_name === 'string' ? { agentName: row.agent_name } : {}),
    ...(typeof row.reasoning === 'string' ? { reasoning: row.reasoning } : {}),
    ...(row.reasoning_ms !== null && row.reasoning_ms !== undefined
      ? { reasoningMs: toInt(row.reasoning_ms) }
      : {}),
    ...(ui !== undefined ? { ui } : {}),
    ...(feedback !== undefined && feedback !== null ? { feedback } : {}),
  };
}
