import type {
  AgentStore,
  AppendMessageInput,
  CreateThreadInput,
  RecordRunEndInput,
  RecordRunStartInput,
  RecordToolCallInput,
  RecordUsageInput,
  UpdateToolCallInput,
} from '../spi/agent-store.js';
import type {
  MessageAttachment,
  MessageRole,
  MessageUsage,
  StoredMessage,
  ThreadDetail,
  ThreadSummary,
  ToolCallRequest,
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

export interface LucidAgentStoreOptions {
  /**
   * Provision the agent tables on first use (via {@link ensureAgentTables}), so the lib manages its
   * own schema — the ecosystem convention (mirrors `@adonis-agora/durable` and `@adonis-agora/authz`).
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

function parseJson<T>(text: unknown): T | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

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
export class LucidAgentStore implements AgentStore {
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
      this.ready = this.autoCreateTables ? ensureAgentTables(this.db) : Promise.resolve();
    }
    return this.ready;
  }

  async createThread(input: CreateThreadInput): Promise<ThreadSummary> {
    await this.init();
    const id = crypto.randomUUID();
    const now = Date.now();
    await this.db.table(AGENT_TABLES.threads).insert({
      id,
      actor_ref: input.actor.id,
      tenant_ref: input.actor.tenantRef ?? null,
      title: input.title ?? 'New chat',
      persona: input.persona,
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
      persona: input.persona,
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
    const messageRows = await this.db
      .from(AGENT_TABLES.messages)
      .where('thread_id', threadId)
      .orderBy('created_at', 'asc')
      .select('*');
    const messages = messageRows.map(rowToMessage);
    const last = messages[messages.length - 1];
    const activeStreamId = row.active_stream_id;
    return {
      ...threadRowToSummary(row, last?.content),
      messages,
      ...(typeof activeStreamId === 'string' ? { activeStreamId } : {}),
    };
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
      const messageRows = await trx
        .from(AGENT_TABLES.messages)
        .where('thread_id', threadId)
        .orderBy('created_at', 'asc')
        .select('*');
      const cutoff = messageRows.findIndex((m) => String(m.id) === fromMessageId);
      const kept = cutoff >= 0 ? messageRows.slice(0, cutoff + 1) : messageRows;

      const id = crypto.randomUUID();
      const now = Date.now();
      const title = String(source.title);
      const persona = String(source.persona);
      await trx.table(AGENT_TABLES.threads).insert({
        id,
        actor_ref: source.actor_ref,
        tenant_ref: source.tenant_ref ?? null,
        title,
        persona,
        transient: 0,
        pinned_at: null,
        summary: null,
        summary_message_count: 0,
        active_stream_id: null,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      });
      for (const m of kept) {
        // New message id: the message PK is unique, so a fork copies content under fresh ids.
        await trx.table(AGENT_TABLES.messages).insert({
          id: crypto.randomUUID(),
          thread_id: id,
          role: m.role,
          content: m.content,
          tool_calls: m.tool_calls ?? null,
          tool_results: m.tool_results ?? null,
          attachments: m.attachments ?? null,
          follow_ups: m.follow_ups ?? null,
          usage: m.usage ?? null,
          persona: m.persona ?? null,
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

  async setActiveStream(threadId: string, runId: string | null): Promise<void> {
    await this.init();
    await this.db
      .from(AGENT_TABLES.threads)
      .where('id', threadId)
      .update({ active_stream_id: runId });
  }

  async appendMessage(input: AppendMessageInput): Promise<StoredMessage> {
    await this.init();
    const id = crypto.randomUUID();
    const now = Date.now();
    await this.db.table(AGENT_TABLES.messages).insert({
      id,
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
    };
  }

  async truncateFrom(threadId: string, messageId: string): Promise<void> {
    await this.init();
    await this.db.transaction(async (trx) => {
      const rows = await trx
        .from(AGENT_TABLES.messages)
        .where('thread_id', threadId)
        .orderBy('created_at', 'asc')
        .select('id');
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
    });
  }

  async updateToolCall(input: UpdateToolCallInput): Promise<void> {
    await this.init();
    const patch: Record<string, unknown> = { status: input.status };
    if (input.output !== undefined) patch.output = safeJson(input.output);
    if (input.error !== undefined) patch.error = input.error;
    if (input.executionMs !== undefined) patch.execution_ms = input.executionMs;
    if (input.executedByRef !== undefined) patch.executed_by_ref = input.executedByRef;
    if (input.status === 'executed' || input.status === 'failed') patch.executed_at = Date.now();
    await this.db.from(AGENT_TABLES.toolCalls).where('id', input.toolCallId).update(patch);
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

function threadRowToSummary(row: Record<string, unknown>, lastPreview?: string): ThreadSummary {
  const pinnedAt = row.pinned_at;
  return {
    id: String(row.id),
    title: String(row.title),
    persona: String(row.persona),
    transient: toInt(row.transient) !== 0,
    createdAt: msToIso(row.created_at),
    updatedAt: msToIso(row.updated_at),
    ...(pinnedAt !== null && pinnedAt !== undefined ? { pinnedAt: msToIso(pinnedAt) } : {}),
    ...(lastPreview !== undefined ? { lastMessagePreview: lastPreview.slice(0, 120) } : {}),
  };
}

function rowToMessage(row: Record<string, unknown>): StoredMessage {
  const toolCalls = parseJson<ToolCallRequest[]>(row.tool_calls);
  const toolResults = parseJson<ToolResult[]>(row.tool_results);
  const attachments = parseJson<MessageAttachment[]>(row.attachments);
  const followUps = parseJson<string[]>(row.follow_ups);
  const usage = parseJson<MessageUsage>(row.usage);
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
  };
}
