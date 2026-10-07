import type { LucidClientLike, LucidRawRunner } from '../stores/lucid.js';

/**
 * A2A conversation state the agent tables do not carry: who a `contextId` belongs to, and the reply
 * each `messageId` got (PACT §4.2, §4.3).
 *
 * A context belongs to a brand (the exposed agent) and to one personal-agent user — the pair
 * `(agent issuer, sub)`. Once a turn in it has run under a delegation, it is also bound to that
 * account: a token for another account is refused there, so one conversation never mixes two users'
 * data (§5.5).
 */
export interface A2aContext {
  /** The `contextId` — the agent thread's id. */
  id: string;
  /** The exposed agent (the "brand" in `/a2a/{brand}`). */
  brand: string;
  agentIssuer: string;
  agentSub: string;
  /** The account a delegated turn ran as; `null` until one does. */
  accountRef: string | null;
}

/** Where a `messageId` stands: never seen (now claimed), still running, or answered. */
export type MessageClaim =
  | { status: 'claimed' }
  | { status: 'pending' }
  | { status: 'done'; reply: unknown };

export interface A2aStore {
  getContext(id: string): Promise<A2aContext | null>;
  createContext(context: A2aContext): Promise<void>;
  /**
   * Bind the context to `accountRef` unless it is already bound. `true` when it is now bound to
   * `accountRef` (either way), `false` when it was bound to someone else.
   */
  bindAccount(id: string, accountRef: string): Promise<boolean>;
  /** Claim `messageId` in the context — atomically, so two deliveries of one message run once. */
  claimMessage(contextId: string, messageId: string): Promise<MessageClaim>;
  /** Store the reply a claimed message got, for its retries. */
  completeMessage(contextId: string, messageId: string, reply: unknown): Promise<void>;
  /** Drop a claim whose turn failed, so a retry runs it again instead of finding nothing. */
  releaseMessage(contextId: string, messageId: string): Promise<void>;
}

/** Process-local {@link A2aStore} — tests and single-instance dev. */
export class InMemoryA2aStore implements A2aStore {
  readonly #contexts = new Map<string, A2aContext>();
  readonly #messages = new Map<string, { done: boolean; reply?: unknown }>();

  async getContext(id: string): Promise<A2aContext | null> {
    const found = this.#contexts.get(id);
    return found ? { ...found } : null;
  }

  async createContext(context: A2aContext): Promise<void> {
    this.#contexts.set(context.id, { ...context });
  }

  async bindAccount(id: string, accountRef: string): Promise<boolean> {
    const context = this.#contexts.get(id);
    if (!context) return false;
    if (context.accountRef === null) context.accountRef = accountRef;
    return context.accountRef === accountRef;
  }

  async claimMessage(contextId: string, messageId: string): Promise<MessageClaim> {
    const key = `${contextId}\n${messageId}`;
    const found = this.#messages.get(key);
    if (!found) {
      this.#messages.set(key, { done: false });
      return { status: 'claimed' };
    }
    return found.done ? { status: 'done', reply: found.reply } : { status: 'pending' };
  }

  async completeMessage(contextId: string, messageId: string, reply: unknown): Promise<void> {
    this.#messages.set(`${contextId}\n${messageId}`, { done: true, reply });
  }

  async releaseMessage(contextId: string, messageId: string): Promise<void> {
    this.#messages.delete(`${contextId}\n${messageId}`);
  }
}

export const A2A_TABLES = {
  contexts: 'agent_a2a_context',
  messages: 'agent_a2a_message',
} as const;

/**
 * `CREATE TABLE IF NOT EXISTS` DDL for the two A2A tables — same portable dialect as the agent
 * tables (quoted identifiers, epoch-ms `BIGINT`, `TEXT` JSON). The message table's primary key IS the
 * idempotency lock: two deliveries of one `messageId` race on the insert and one loses.
 */
export function a2aTableStatements(): string[] {
  const t = A2A_TABLES;
  return [
    `CREATE TABLE IF NOT EXISTS "${t.contexts}" (
      "id" VARCHAR(255) PRIMARY KEY NOT NULL,
      "brand" VARCHAR(255) NOT NULL,
      "agent_issuer" VARCHAR(2048) NOT NULL,
      "agent_sub" VARCHAR(255) NOT NULL,
      "account_ref" VARCHAR(255) NULL,
      "created_at" BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS "${t.messages}" (
      "context_id" VARCHAR(255) NOT NULL,
      "message_id" VARCHAR(255) NOT NULL,
      "reply" TEXT NULL,
      "created_at" BIGINT NOT NULL,
      PRIMARY KEY ("context_id", "message_id")
    )`,
  ];
}

/** Create the A2A tables if missing. Idempotent. */
export async function ensureA2aTables(db: LucidRawRunner): Promise<void> {
  for (const statement of a2aTableStatements()) {
    await db.rawQuery(statement);
  }
}

/** {@link A2aStore} over Lucid (any of SQLite / Postgres / MySQL). */
export class LucidA2aStore implements A2aStore {
  constructor(private readonly db: LucidClientLike) {}

  async getContext(id: string): Promise<A2aContext | null> {
    const row = await this.db.from(A2A_TABLES.contexts).where('id', id).first();
    if (!row) return null;
    return {
      id: String(row.id),
      brand: String(row.brand),
      agentIssuer: String(row.agent_issuer),
      agentSub: String(row.agent_sub),
      accountRef: row.account_ref == null ? null : String(row.account_ref),
    };
  }

  async createContext(context: A2aContext): Promise<void> {
    await this.db.table(A2A_TABLES.contexts).insert({
      id: context.id,
      brand: context.brand,
      agent_issuer: context.agentIssuer,
      agent_sub: context.agentSub,
      account_ref: context.accountRef,
      created_at: Date.now(),
    });
  }

  async bindAccount(id: string, accountRef: string): Promise<boolean> {
    await this.db
      .from(A2A_TABLES.contexts)
      .where('id', id)
      .whereNull('account_ref')
      .update({ account_ref: accountRef });
    // Re-read rather than trust the update count: a concurrent bind to the SAME account also wins.
    const context = await this.getContext(id);
    return context?.accountRef === accountRef;
  }

  async claimMessage(contextId: string, messageId: string): Promise<MessageClaim> {
    try {
      await this.db.table(A2A_TABLES.messages).insert({
        context_id: contextId,
        message_id: messageId,
        reply: null,
        created_at: Date.now(),
      });
      return { status: 'claimed' };
    } catch (error) {
      const row = await this.#message(contextId, messageId);
      if (!row) throw error;
      return row.reply == null
        ? { status: 'pending' }
        : { status: 'done', reply: JSON.parse(String(row.reply)) };
    }
  }

  async completeMessage(contextId: string, messageId: string, reply: unknown): Promise<void> {
    await this.db
      .from(A2A_TABLES.messages)
      .where('context_id', contextId)
      .where('message_id', messageId)
      .update({ reply: JSON.stringify(reply) });
  }

  async releaseMessage(contextId: string, messageId: string): Promise<void> {
    await this.db
      .from(A2A_TABLES.messages)
      .where('context_id', contextId)
      .where('message_id', messageId)
      .whereNull('reply')
      .delete();
  }

  #message(contextId: string, messageId: string) {
    return this.db
      .from(A2A_TABLES.messages)
      .where('context_id', contextId)
      .where('message_id', messageId)
      .first();
  }
}
