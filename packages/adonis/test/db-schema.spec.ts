import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureA2aTables, LucidA2aStore } from '../src/a2a/index.js';
import { lucidChannelStore } from '../src/channels/store.js';
import { agentDoctorChecks, checkDbSchema } from '../src/doctor/checks.js';
import {
  type Actor,
  AGENT_TABLES,
  agentTables,
  createAgentTables,
  dropAgentTables,
  LucidAgentStore,
  LucidConfirmTokenStore,
  type LucidDatabaseLike,
  LucidGovernanceQueries,
  LucidPricingStore,
  LucidTokenStreamSink,
  lucidStoreSchema,
  PgDocumentTreeStore,
  PgVectorStore,
  type StreamFrame,
  stores,
} from '../src/index.js';
import { LucidPoppyStore } from '../src/poppy/store.js';
import { LucidPoppyConnectionStore } from '../src/poppy-connections/store.js';
import { makeMemoryDb } from './helpers/make-db.js';
import { type Backend, type BackendDb, openBackend, unavailable } from './helpers/real-db.js';

/**
 * The `schema` option: the agent's tables in a database schema of their own (a Postgres schema, a
 * MySQL database) while the connection's default stays where it is (`public` / the connection's
 * database). Every statement names the schema — never `SET search_path`, which behind PgBouncer in
 * transaction mode leaks to other clients.
 *
 * The strongest assertion here is the negative one: after each case, the default schema holds NO
 * agent table. Any statement the lib issued unqualified would have either created a table there or
 * failed against a table that is not there, so the cases passing with nothing in the default schema
 * is what proves every statement carried the schema.
 */

const actor: Actor = { id: 'user-1', roles: ['ADMIN'], tenantRef: 'tenant-1' };
const day = new Date().toISOString().slice(0, 10);
const asDb = (db: Database) => db as unknown as LucidDatabaseLike;

const uniqueSchema = (prefix = 'agsch') =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;

/** Table names of `schema` (or of the connection's default schema), from the catalog. */
async function tablesOf(
  backend: Backend,
  db: Database,
  schema: string | undefined,
): Promise<string[]> {
  const where =
    schema !== undefined
      ? 'table_schema = ?'
      : backend === 'postgres'
        ? "table_schema = 'public'"
        : 'table_schema = DATABASE()';
  const result = (await db.rawQuery(
    `SELECT table_name AS name FROM information_schema.tables WHERE ${where}`,
    schema !== undefined ? [schema] : [],
  )) as unknown;
  const rows = (
    Array.isArray(result)
      ? (result[0] as Record<string, unknown>[])
      : ((result as { rows: Record<string, unknown>[] }).rows ?? [])
  ) as Record<string, unknown>[];
  return rows.map((row) => String(row.name ?? row.NAME)).sort();
}

async function dropSchema(backend: Backend, db: Database, schema: string): Promise<void> {
  await db.rawQuery(
    backend === 'postgres'
      ? `DROP SCHEMA IF EXISTS "${schema}" CASCADE`
      : `DROP DATABASE IF EXISTS \`${schema}\``,
  );
}

const REAL: readonly Backend[] = ['postgres', 'mysql'];

for (const backend of REAL) {
  const reason = unavailable(backend);
  const suite = reason === undefined ? describe : describe.skip;
  suite(`schema option [${backend}]${reason === undefined ? '' : ` — skipped: ${reason}`}`, () => {
    let handle: BackendDb;
    let created: string[] = [];

    const open = async () => {
      handle = await openBackend(backend, { tables: false });
      return handle;
    };
    const schemaFor = () => {
      const name = uniqueSchema();
      created.push(name);
      return name;
    };

    afterEach(async () => {
      if (handle === undefined) return;
      // Nothing ever landed in the connection's own schema.
      const leaked = (await tablesOf(backend, handle.db, undefined)).filter((name) =>
        name.startsWith('agent_'),
      );
      for (const schema of created) await dropSchema(backend, handle.db, schema);
      created = [];
      await handle.close();
      expect(leaked).toEqual([]);
    });

    it('createAgentTables creates the schema and every table in it, idempotently', async () => {
      const { db } = await open();
      const schema = schemaFor();
      expect(await createAgentTables(asDb(db), { schema })).toEqual([]);
      expect(await tablesOf(backend, db, schema)).toEqual(Object.values(AGENT_TABLES).sort());
      // Up to date: a second run repairs nothing and creates nothing.
      expect(await createAgentTables(asDb(db), { schema })).toEqual([]);
      await dropAgentTables(asDb(db), { schema });
      expect(await tablesOf(backend, db, schema)).toEqual([]);
    });

    it('repairs a table in the schema: a missing column and a NOT NULL that should not be', async () => {
      const { db } = await open();
      const schema = schemaFor();
      await createAgentTables(asDb(db), { schema });
      const q = (table: string) =>
        backend === 'postgres' ? `"${schema}"."${table}"` : `\`${schema}\`.\`${table}\``;
      await db.rawQuery(`ALTER TABLE ${q(AGENT_TABLES.messages)} DROP COLUMN sent_at`);
      await db.rawQuery(
        backend === 'postgres'
          ? `ALTER TABLE ${q(AGENT_TABLES.tokenUsage)} ALTER COLUMN thread_id SET NOT NULL`
          : `ALTER TABLE ${q(AGENT_TABLES.tokenUsage)} MODIFY thread_id VARCHAR(255) NOT NULL`,
      );
      const repairs = await createAgentTables(asDb(db), { schema });
      expect(repairs).toContain(`${AGENT_TABLES.messages}.sent_at`);
      expect(repairs).toContain(`${AGENT_TABLES.tokenUsage}.thread_id`);
      expect(await createAgentTables(asDb(db), { schema })).toEqual([]);
    });

    it('the store, pricing, governance and confirm tokens read and write in the schema', async () => {
      const { db } = await open();
      const schema = schemaFor();
      // Boot path: the store provisions the schema and its tables itself (autoCreateTables).
      const store = new LucidAgentStore(asDb(db), { schema });
      await store.ensureSchema();
      expect(store.databaseSchema).toBe(schema);

      const thread = await store.createThread({ actor, persona: 'default', title: 'In a schema' });
      const user = await store.appendMessage({ threadId: thread.id, role: 'user', content: 'hi' });
      await store.recordRunStart({ runId: 'run-1', threadId: thread.id, actor });
      const assistant = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'calling',
        runId: 'run-1',
      });
      await store.recordToolCall({
        toolCallId: 'call-1',
        messageId: assistant.id,
        toolName: 'purge_cache',
        toolType: 'action',
        input: { all: true },
        status: 'pending_approval',
        runId: 'run-1',
      });
      await store.recordUsage({
        threadId: thread.id,
        actorRef: actor.id,
        modelId: 'gpt-test',
        purpose: 'chat',
        usage: { inputTokens: 10, outputTokens: 5 },
        runId: 'run-1',
      });
      await store.recordRunEnd({ runId: 'run-1', status: 'completed', stepCount: 1 });
      await store.enqueueMessage({ threadId: thread.id, actor, content: 'next' });

      expect((await store.getThread(thread.id))?.messages.map((m) => m.content)).toEqual([
        'hi',
        'calling',
      ]);
      expect((await store.listThreads(actor.id)).map((t) => t.id)).toEqual([thread.id]);
      expect((await store.listQueue(thread.id)).map((m) => m.content)).toEqual(['next']);
      expect(await store.rememberedApprovals(thread.id)).toEqual([]);
      expect((await store.usageBetween(actor.id, day, day)).usedTokens).toBe(15);
      const fork = await store.forkThread(thread.id, assistant.id);
      expect((await store.getThread(fork.id))?.messages).toHaveLength(2);
      await store.truncateFrom(fork.id, (await store.getThread(fork.id))?.messages[1]?.id ?? '');
      expect((await store.getThread(fork.id))?.messages).toHaveLength(1);
      expect(user.id).toBeTruthy();

      const pricing = new LucidPricingStore(asDb(db), { schema });
      await pricing.upsertModelPrice({
        modelId: 'gpt-test',
        inputPricePer1m: 1,
        outputPricePer1m: 2,
      });
      expect((await pricing.listCurrentPrices()).map((p) => p.modelId)).toEqual(['gpt-test']);

      const governance = new LucidGovernanceQueries(asDb(db), pricing, { schema });
      expect((await governance.listRuns()).items.map((run) => run.runId)).toEqual(['run-1']);
      expect(await governance.runDetail('run-1')).not.toBeNull();
      expect((await governance.spendByModel({ fromDay: day, toDay: day }))[0]).toMatchObject({
        modelId: 'gpt-test',
      });
      expect((await governance.pendingApprovals()).length).toBe(1);
      expect((await governance.recentThreads(10)).length).toBe(2);
      expect(await governance.listTenants()).toEqual(['tenant-1']);
      expect((await governance.threadDetail(thread.id))?.threadId).toBe(thread.id);

      const tokens = new LucidConfirmTokenStore(asDb(db), { schema });
      const claim = { hash: 'h1', actorRef: actor.id, tool: 'purge_cache', expiresAt: 1 };
      expect(await tokens.claim(claim)).toBe(true);
      expect(await tokens.claim(claim)).toBe(false);
      expect(await tokens.purgeExpired(Date.now())).toBe(1);

      await store.softDeleteThread(thread.id);
      expect(await store.listThreads(actor.id)).toHaveLength(1);
    });

    it('the channel state and the token sink live in the schema', async () => {
      const { db } = await open();
      const schema = schemaFor();
      const channels = lucidChannelStore(db as never, { schema });
      expect(await channels.claim('msg-1', 60_000)).toBe(true);
      expect(await channels.claim('msg-1', 60_000)).toBe(false);
      await channels.set('q', 'answer', 60_000);
      expect(await channels.get('q')).toBe('answer');
      await channels.delete('q');
      expect(await channels.get('q')).toBeNull();

      const sink = new LucidTokenStreamSink(asDb(db), {
        schema,
        pollIntervalMs: 5,
        flushMs: 0,
        autoPurge: false,
        ttlSeconds: 1,
      });
      const writer = sink.open('run-s');
      await writer.write({ t: 'text', v: 'Hello' });
      await writer.end();
      const frames: StreamFrame[] = [];
      for await (const frame of sink.subscribe('run-s')) frames.push(frame);
      expect(frames).toEqual([{ t: 'text', v: 'Hello' }]);
      expect(await sink.purgeExpired(Date.now() + 5_000)).toBeGreaterThanOrEqual(0);
      expect(await tablesOf(backend, db, schema)).toEqual(
        [AGENT_TABLES.channelState, AGENT_TABLES.streamFrames].sort(),
      );
    });

    it('two installs in two schemas of one database do not see each other', async () => {
      const { db } = await open();
      const [one, two] = [schemaFor(), schemaFor()];
      const a = new LucidAgentStore(asDb(db), { schema: one });
      const b = new LucidAgentStore(asDb(db), { schema: two });
      await a.createThread({ actor, persona: 'default', id: 'same-id', title: 'A' });
      await b.createThread({ actor, persona: 'default', id: 'same-id', title: 'B' });
      expect((await a.getThread('same-id'))?.title).toBe('A');
      expect((await b.getThread('same-id'))?.title).toBe('B');
    });

    it("works inside the app's own transaction", async () => {
      const { db } = await open();
      const schema = schemaFor();
      await createAgentTables(asDb(db), { schema });
      await db.transaction(async (trx) => {
        const scoped = new LucidAgentStore(trx as unknown as LucidDatabaseLike, {
          schema,
          autoCreateTables: false,
        });
        const thread = await scoped.createThread({ actor, persona: 'default', id: 'in-trx' });
        await scoped.appendMessage({ threadId: thread.id, role: 'user', content: 'inside' });
      });
      const outside = new LucidAgentStore(asDb(db), { schema, autoCreateTables: false });
      expect((await outside.getThread('in-trx'))?.messages.map((m) => m.content)).toEqual([
        'inside',
      ]);
      expect(
        await db.from(agentTables(schema).threads).where('id', 'in-trx').first(),
      ).not.toBeNull();
    });

    it('the Poppy store keeps its tables in the schema', async () => {
      const { db } = await open();
      const schema = schemaFor();
      const poppy = new LucidPoppyStore(db as never, { schema });
      const now = Date.now();
      await poppy.createConversation({
        id: 'c1',
        clientId: 'https://pa.example',
        userId: 'u1',
        accountRef: null,
        agentName: 'support',
        threadId: null,
        parentId: null,
        openDirectId: null,
        status: 'idle',
        responder: 'agent',
        context: { locale: 'en-US' },
        activeRunId: null,
        turnSeq: 0,
        grant: { actor: { id: 'a1', roles: ['personal_agent'] }, scopes: [], signedIn: false },
        prunedSeq: 0,
        createdAt: now,
        updatedAt: now,
      } as never);
      expect((await poppy.getConversation('c1'))?.agentName).toBe('support');
      expect(await tablesOf(backend, db, schema)).toEqual(
        ['agent_poppy_conversation', 'agent_poppy_event', 'agent_poppy_message'].sort(),
      );
    });

    it('the Poppy-connections store keeps its tables in the schema', async () => {
      const { db } = await open();
      const schema = schemaFor();
      const now = Date.now();
      const connections = new LucidPoppyConnectionStore(db as never, { schema });
      await connections.saveConnection({
        owner: 'o1',
        issuer: 'https://company.example',
        domain: 'company.example',
        organization: 'Company',
        scope: 'read',
        status: 'active',
        state: 'sealed',
        createdAt: now,
        updatedAt: now,
      });
      expect((await connections.listConnections('o1')).map((c) => c.domain)).toEqual([
        'company.example',
      ]);
      expect(await tablesOf(backend, db, schema)).toEqual(
        ['agent_poppy_connect', 'agent_poppy_connection'].sort(),
      );
    });

    it('agora:doctor: the schema, its tables and the write probe', async () => {
      const { db } = await open();
      const schema = schemaFor();
      const store = new LucidAgentStore(asDb(db), { schema, autoCreateTables: false });
      expect(await checkDbSchema({ database: asDb(db), databaseSchema: schema })).toMatchObject({
        status: 'error',
        message: expect.stringContaining('does not exist'),
      });
      await createAgentTables(asDb(db), { schema });
      await db.rawQuery(
        backend === 'postgres'
          ? `DROP TABLE "${schema}"."${AGENT_TABLES.genuiCalls}"`
          : `DROP TABLE \`${schema}\`.\`${AGENT_TABLES.genuiCalls}\``,
      );
      expect(await checkDbSchema(store)).toMatchObject({
        status: 'error',
        message: expect.stringContaining(AGENT_TABLES.genuiCalls),
      });
      await createAgentTables(asDb(db), { schema });
      expect(await checkDbSchema(store)).toMatchObject({ status: 'ok' });
      // The write probe rolled back.
      expect(
        await db.from(agentTables(schema).confirmTokens).where('actor_ref', 'agora:doctor').first(),
      ).toBeNull();
    });

    it('the A2A store keeps its tables in the schema', async () => {
      const { db } = await open();
      const schema = schemaFor();
      const connection = db.connection();
      await ensureA2aTables(connection as never, { schema });
      const a2a = new LucidA2aStore(connection as never, { schema });
      await a2a.createContext({
        id: 'ctx-1',
        brand: 'support',
        agentIssuer: 'https://pa.example',
        agentSub: 'sub',
        accountRef: null,
      });
      expect(await a2a.bindAccount('ctx-1', 'acc-1')).toBe(true);
      expect(await a2a.claimMessage('ctx-1', 'm1')).toEqual({ status: 'claimed' });
      await a2a.completeMessage('ctx-1', 'm1', { ok: true });
      expect(await a2a.claimMessage('ctx-1', 'm1')).toEqual({
        status: 'done',
        reply: { ok: true },
      });
    });

    if (backend === 'postgres') {
      it('document trees live in the schema', async () => {
        const { db } = await open();
        const schema = schemaFor();
        const trees = new PgDocumentTreeStore(asDb(db), { schema });
        await trees.ensureSchema();
        expect(await tablesOf(backend, db, schema)).toEqual(
          ['agent_rag_trees', 'agent_rag_trees_units'].sort(),
        );
      });

      it('pgvector chunks live in the schema; the extension stays put', async (ctx) => {
        const { db } = await open();
        const schema = schemaFor();
        const available = (await db.rawQuery(
          "SELECT 1 FROM pg_available_extensions WHERE name = 'vector'",
        )) as { rows: unknown[] };
        // The CI Postgres service has no pgvector; the testcontainers image (`pnpm test:db`) does.
        if (available.rows.length === 0) ctx.skip();
        const chunks = new PgVectorStore(asDb(db), { schema, dimension: 3 });
        await chunks.ensureSchema();
        await chunks.upsert([
          { id: 'doc#0', text: 'alpha', embedding: [1, 0, 0], metadata: { tenant: 't1' } },
          { id: 'doc#1', text: 'beta', embedding: [0, 1, 0], metadata: { tenant: 't1' } },
        ]);
        // The advisory-locked swap, on a table named through the schema.
        await chunks.replaceDocument('doc', [
          { id: 'doc#0', text: 'gamma', embedding: [0, 0, 1], metadata: { tenant: 't1' } },
        ]);
        const hits = await chunks.search([0, 0, 1], { topK: 5 });
        expect(hits.map((hit) => hit.text)).toEqual(['gamma']);
        expect(await tablesOf(backend, db, schema)).toEqual(['agent_rag_chunks']);
        // `vector` was not created in (or moved to) the configured schema.
        const ext = (await db.rawQuery(
          `SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'`,
        )) as { rows: { schema: string }[] };
        expect(ext.rows[0]?.schema).not.toBe(schema);
      });
    }
  });
}

describe('schema option: refused where it cannot work', () => {
  let db: Database | undefined;
  afterEach(async () => {
    await db?.manager.closeAll();
    db = undefined;
  });

  it('fails on SQLite, naming the option and the dialect, rather than falling back', async () => {
    db = makeMemoryDb();
    const sqlite = asDb(db);
    const message = /schema: "agent".*no schemas/;
    expect(() => new LucidAgentStore(sqlite, { schema: 'agent' })).toThrow(message);
    expect(() => new LucidPricingStore(sqlite, { schema: 'agent' })).toThrow(message);
    expect(() => new LucidGovernanceQueries(sqlite, undefined, { schema: 'agent' })).toThrow(
      message,
    );
    expect(() => new LucidConfirmTokenStore(sqlite, { schema: 'agent' })).toThrow(message);
    expect(() => new LucidTokenStreamSink(sqlite, { schema: 'agent' })).toThrow(message);
    expect(() => lucidChannelStore(db as never, { schema: 'agent' })).toThrow(message);
    expect(() => new LucidPoppyStore(db as never, { schema: 'agent' })).toThrow(message);
    expect(() => new LucidPoppyConnectionStore(db as never, { schema: 'agent' })).toThrow(message);
    await expect(createAgentTables(sqlite, { schema: 'agent' })).rejects.toThrow(message);
    await expect(ensureA2aTables(db as never, { schema: 'agent' })).rejects.toThrow(message);
  });

  it('refuses a name that is not a plain identifier', () => {
    db = makeMemoryDb();
    for (const bad of ['agent.tables', 'a"b', '1agent', '', 'x'.repeat(64)]) {
      expect(() => new LucidAgentStore(asDb(db as Database), { schema: bad })).toThrow(
        /plain identifier/,
      );
    }
  });

  it('without schema, SQLite keeps working exactly as before', async () => {
    db = makeMemoryDb();
    const store = new LucidAgentStore(asDb(db));
    const thread = await store.createThread({ actor, persona: 'default' });
    expect(await store.getThread(thread.id)).not.toBeNull();
    expect(store.databaseSchema).toBeUndefined();
  });
});

describe('schema option: config inheritance', () => {
  /** A container whose `lucid.db` is a client that says it is Postgres (nothing is queried). */
  const ctxWith = (schema?: string) => {
    const fakeDb = {
      dialect: { name: 'postgres' },
      connection: () => fakeDb,
      from: () => ({}),
      table: () => ({}),
      rawQuery: async () => [],
      transaction: async () => undefined,
    };
    const app = { container: { make: async () => fakeDb } } as never;
    return schema === undefined ? { app } : { app, schema };
  };

  it("stores.lucid() takes config/agent.ts's top-level schema, and its own over it", async () => {
    const inherited = (await stores.lucid({ autoCreateTables: false })(
      ctxWith('agent'),
    )) as LucidAgentStore;
    expect(inherited.databaseSchema).toBe('agent');
    const own = stores.lucid({ autoCreateTables: false, schema: 'mine' });
    expect(((await own(ctxWith('agent'))) as LucidAgentStore).databaseSchema).toBe('mine');
    expect(lucidStoreSchema(own)).toBe('mine');
    const none = (await stores.lucid({ autoCreateTables: false })(ctxWith())) as LucidAgentStore;
    expect(none.databaseSchema).toBeUndefined();
  });

  it('agora:doctor registers no schema check without a schema', () => {
    expect(agentDoctorChecks().map((check) => check.id)).not.toContain('agent.db-schema');
    expect(agentDoctorChecks({ schemaStore: () => undefined }).map((check) => check.id)).toContain(
      'agent.db-schema',
    );
  });
});
