import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_TABLES,
  AgentSseEncoder,
  childSinkWriter,
  createAgentTables,
  type LucidDatabaseLike,
  LucidTokenStreamSink,
  type LucidTokenStreamSinkOptions,
  type StreamFrame,
  type TokenStreamSink,
  tokenSinks,
} from '../src/index.js';
import { portableSql } from '../src/stores/sql-dialect.js';
import { makeMemoryDb } from './helpers/make-db.js';
import { openBackend } from './helpers/real-db.js';

/**
 * The Lucid sink against a real database — in-memory SQLite always, and a real Postgres when
 * `AGENT_TEST_PG_URL` names one (the same variable the schema-provisioning spec reads).
 *
 * "Two replicas" is two sink INSTANCES that share nothing but the database: one writes, the other
 * subscribes. On Postgres they do not even share a connection pool.
 */
const url = process.env.AGENT_TEST_PG_URL;

function makePgDb(): Database {
  const target = new URL(url as string);
  return new Database(
    {
      connection: 'pg',
      connections: {
        pg: {
          client: 'pg',
          connection: {
            host: target.hostname,
            port: Number(target.port || 5432),
            user: decodeURIComponent(target.username),
            password: decodeURIComponent(target.password),
            database: target.pathname.slice(1),
          },
          pool: { min: 0, max: 4 },
        },
      },
    },
    new Logger({ enabled: false }),
    new Emitter(undefined as never),
  );
}

interface Backend {
  name: string;
  skip: boolean;
  /** A table of this spec's own on Postgres, so a parallel spec dropping the agent tables cannot take it. */
  table: string;
  /** The databases of replica A and replica B, and how to let them go. */
  open(): Promise<{ dbs: Database[]; close(): Promise<void> }>;
}

const backends: Backend[] = [
  {
    name: 'sqlite',
    skip: false,
    table: AGENT_TABLES.streamFrames,
    // `:memory:` is per connection, so both "replicas" have to go through the one database object.
    open: async () => {
      const db = makeMemoryDb();
      return { dbs: [db], close: () => db.manager.closeAll() };
    },
  },
  {
    name: 'postgres',
    skip: url === undefined,
    table: 'agent_stream_frame_sink_spec',
    open: async () => {
      const dbs = [makePgDb(), makePgDb()];
      return {
        dbs,
        close: async () => {
          for (const db of dbs) await db.manager.closeAll();
        },
      };
    },
  },
  {
    // A throwaway database of its own, two pools over it: two replicas sharing nothing else.
    name: 'mysql',
    skip: process.env.AGENT_TEST_MYSQL_URL === undefined,
    table: AGENT_TABLES.streamFrames,
    open: async () => {
      const handle = await openBackend('mysql', { tables: false });
      return { dbs: [handle.db, handle.replica()], close: () => handle.close() };
    },
  },
];

const asDb = (db: Database) => db as unknown as LucidDatabaseLike;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function collect(sink: TokenStreamSink, runId: string): Promise<StreamFrame[]> {
  const frames: StreamFrame[] = [];
  for await (const frame of sink.subscribe(runId)) frames.push(frame);
  return frames;
}

const textOf = (frames: StreamFrame[]) =>
  frames.map((frame) => (frame.t === 'text' ? frame.v : '')).join('');

const step = (index: number): StreamFrame => ({
  t: 'event',
  event: { kind: 'step-start', index } as never,
});

describe.each(backends)('LucidTokenStreamSink on $name', (backend) => {
  describe.skipIf(backend.skip)('', () => {
    let dbs: Database[];
    let close: () => Promise<void>;
    let runId: string;

    /** A sink on replica `replica` (0 = A, 1 = B). Fast timings so the suite does not wait on polls. */
    const sinkOn = (replica: number, options: LucidTokenStreamSinkOptions = {}) =>
      new LucidTokenStreamSink(asDb(dbs[replica % dbs.length] as Database), {
        tableName: backend.table,
        pollIntervalMs: 5,
        flushMs: 10,
        autoPurge: false,
        ...options,
      });

    const rowCount = async (run: string) =>
      (
        await asDb(dbs[0] as Database)
          .from(backend.table)
          .where('run_id', run)
          .select('seq')
      ).length;

    beforeEach(async () => {
      ({ dbs, close } = await backend.open());
      const first = asDb(dbs[0] as Database);
      await first.rawQuery(portableSql(first, `DROP TABLE IF EXISTS "${backend.table}"`));
      // A run id of this test's own: nothing here depends on the table being empty.
      runId = `run-${crypto.randomUUID()}`;
    });

    afterEach(async () => {
      const first = asDb(dbs[0] as Database);
      await first.rawQuery(portableSql(first, `DROP TABLE IF EXISTS "${backend.table}"`));
      await close();
    });

    it('yields the frames in the order they were written, then ends', async () => {
      const sink = sinkOn(0);
      const writer = sink.open(runId);
      await writer.write({ t: 'text', v: 'Hello' });
      await writer.write(step(0));
      await writer.write({ t: 'component', name: 'Card', data: { n: 1 }, id: 'c:ui:0' });
      await writer.write({ t: 'text', v: ' world' });
      await writer.end();

      expect(await collect(sink, runId)).toEqual([
        { t: 'text', v: 'Hello' },
        step(0),
        { t: 'component', name: 'Card', data: { n: 1 }, id: 'c:ui:0' },
        { t: 'text', v: ' world' },
      ]);
    });

    it('serves a run written on one replica to a subscriber on another, attached before any frame', async () => {
      const writerReplica = sinkOn(0);
      const readerReplica = sinkOn(1);
      const reading = collect(readerReplica, runId);
      await sleep(20); // the subscriber is polling an empty run by now

      const writer = writerReplica.open(runId);
      await writer.write({ t: 'text', v: 'from A' });
      await writer.write(step(0));
      await writer.end();

      expect(await reading).toEqual([{ t: 'text', v: 'from A' }, step(0)]);
    });

    it('replays everything to a late subscriber, then follows live', async () => {
      const writerReplica = sinkOn(0);
      const writer = writerReplica.open(runId);
      await writer.write(step(0));
      await writer.write(step(1));

      const reading = collect(sinkOn(1), runId);
      await sleep(20);
      await writer.write(step(2));
      await writer.end();

      expect(await reading).toEqual([step(0), step(1), step(2)]);
    });

    it('replays a run that already ended, then terminates', async () => {
      const writer = sinkOn(0).open(runId);
      await writer.write({ t: 'text', v: 'all of it' });
      await writer.write({ t: 'error', code: 'internal' as never, message: 'boom' });
      await writer.end();

      const frames = await collect(sinkOn(1), runId);
      expect(frames).toEqual([
        { t: 'text', v: 'all of it' },
        { t: 'error', code: 'internal', message: 'boom' },
      ]);
    });

    it('coalesces streamed tokens into few rows without changing the text or the order', async () => {
      const sink = sinkOn(0, { flushMs: 40 });
      const writer = sink.open(runId);
      const tokens = Array.from({ length: 60 }, (_, index) => `t${index} `);
      for (const token of tokens.slice(0, 30)) await writer.write({ t: 'text', v: token });
      await writer.write(step(0)); // a non-text frame cuts the gathered text and keeps its place
      for (const token of tokens.slice(30)) await writer.write({ t: 'text', v: token });
      await writer.end();

      const frames = await collect(sinkOn(1), runId);
      expect(textOf(frames)).toBe(tokens.join(''));
      expect(frames.map((frame) => frame.t)).toEqual(['text', 'event', 'text']);
      expect(frames[0]).toEqual({ t: 'text', v: tokens.slice(0, 30).join('') });
      // Two text rows, the event and the end marker — not sixty-two.
      expect(await rowCount(runId)).toBe(4);
    });

    it('writes gathered text on its own once the flush window passes', async () => {
      const sink = sinkOn(0, { flushMs: 10 });
      await sink.ensureSchema();
      const writer = sink.open(runId);
      await writer.write({ t: 'text', v: 'a' });
      await writer.write({ t: 'text', v: 'b' });
      expect(await rowCount(runId)).toBe(0);
      await sleep(60);
      expect(await rowCount(runId)).toBe(1);
      await writer.end();
      expect(await collect(sink, runId)).toEqual([{ t: 'text', v: 'ab' }]);
    });

    it('writes every frame as its own row under flushMs: 0', async () => {
      const sink = sinkOn(0, { flushMs: 0 });
      const writer = sink.open(runId);
      await writer.write({ t: 'text', v: 'a' });
      await writer.write({ t: 'text', v: 'b' });
      await writer.end();
      expect(await collect(sink, runId)).toEqual([
        { t: 'text', v: 'a' },
        { t: 'text', v: 'b' },
      ]);
    });

    it('numbers SSE events the same on every replica, so an `after` cursor resumes without a gap or a repeat', async () => {
      const writer = sinkOn(0, { flushMs: 0 }).open(runId);
      for (let index = 0; index < 6; index += 1) {
        await writer.write({ t: 'text', v: `chunk-${index};` });
        await writer.write(step(index));
      }
      await writer.end();

      const sse = async (sink: TokenStreamSink, after: number) => {
        const encoder = new AgentSseEncoder(after);
        let out = '';
        for await (const frame of sink.subscribe(runId)) out += encoder.encode(frame);
        return out;
      };
      const idsOf = (body: string) => [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));

      const whole = await sse(sinkOn(0), 0);
      expect(idsOf(whole)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));

      // A client that saw events 1..5 reconnects to the OTHER replica.
      const rest = await sse(sinkOn(1), 5);
      expect(idsOf(rest)).toEqual([6, 7, 8, 9, 10, 11, 12]);
      expect(whole.endsWith(rest)).toBe(true);
    });

    it('keeps the numbering contiguous when two replicas write into one run at once', async () => {
      // A parent whose delegated children forward into its stream from different replicas.
      const a = sinkOn(0, { flushMs: 0 }).open(runId);
      const b = sinkOn(1, { flushMs: 0 }).open(runId);
      await Promise.all(
        Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? a : b).write(step(index))),
      );
      await a.end();

      const rows = await asDb(dbs[0] as Database)
        .from(backend.table)
        .where('run_id', runId)
        .orderBy('seq', 'asc')
        .select('seq');
      expect(rows.map((row) => Number(row.seq))).toEqual(
        Array.from({ length: 21 }, (_, index) => index + 1),
      );
      const frames = await collect(sinkOn(1), runId);
      expect(frames).toHaveLength(20);
      expect(new Set(frames.map((frame) => JSON.stringify(frame))).size).toBe(20);
    });

    it("writes out a delegated run's gathered text when the child ends, before its parent's next frame", async () => {
      // The child ran on replica B and forwarded into the parent's stream; the parent resumes on A.
      const child = childSinkWriter(await sinkOn(1, { flushMs: 5000 }).open(runId));
      await child.write({ t: 'text', v: 'from the delegate' });
      await child.end(); // never ends the stream — but must not sit on the text either

      const parent = sinkOn(0).open(runId);
      await parent.write(step(1));
      await parent.end();

      expect(await collect(sinkOn(0), runId)).toEqual([
        { t: 'text', v: 'from the delegate' },
        step(1),
      ]);
    });

    it('shares gathered text between writers of one run in a process, so order survives a second open()', async () => {
      const sink = sinkOn(0, { flushMs: 5000 });
      await sink.open(runId).write({ t: 'text', v: 'first' });
      const second = sink.open(runId);
      await second.write(step(0));
      await second.end();
      expect(await collect(sink, runId)).toEqual([{ t: 'text', v: 'first' }, step(0)]);
    });

    it('reports whether it holds anything for a run, and close() drops it', async () => {
      const sink = sinkOn(0);
      expect(await sink.has(runId)).toBe(false);
      const writer = sink.open(runId);
      await writer.write(step(0));
      expect(await sinkOn(1).has(runId)).toBe(true);
      await writer.end();
      expect(await sink.has(runId)).toBe(true);

      await sink.close(runId);
      expect(await sink.has(runId)).toBe(false);
      expect(await rowCount(runId)).toBe(0);
    });

    it('purges runs whose last write is older than the TTL — ended or not — and keeps the rest', async () => {
      const sink = sinkOn(0, { ttlSeconds: 60 });
      const ended = `${runId}-ended`;
      const crashed = `${runId}-crashed`;
      const endedWriter = sink.open(ended);
      await endedWriter.write(step(0));
      await endedWriter.end();
      await sink.open(crashed).write(step(0)); // never ends

      expect(await sink.purgeExpired(Date.now() + 30_000)).toBe(0);
      expect(await sink.has(ended)).toBe(true);

      // A run still being written when the others lapse.
      const live = `${runId}-live`;
      const db = asDb(dbs[0] as Database);
      await db.table(backend.table).insert({
        run_id: live,
        seq: 1,
        frame: JSON.stringify(step(0)),
        created_at: Date.now() + 90_000,
      });

      expect(await sinkOn(1, { ttlSeconds: 60 }).purgeExpired(Date.now() + 120_000)).toBe(2);
      expect(await sink.has(ended)).toBe(false);
      expect(await sink.has(crashed)).toBe(false);
      expect(await sink.has(live)).toBe(true);
    });

    it('never purges under ttlSeconds: 0', async () => {
      const sink = sinkOn(0, { ttlSeconds: 0 });
      const writer = sink.open(runId);
      await writer.write(step(0));
      await writer.end();
      expect(await sink.purgeExpired(Date.now() + 10 * 365 * 86_400_000)).toBe(0);
      expect(await sink.has(runId)).toBe(true);
    });

    it('purges on its own after a run ends when autoPurge is on', async () => {
      const db = asDb(dbs[0] as Database);
      const sink = sinkOn(0, { ttlSeconds: 60, autoPurge: true });
      await sink.ensureSchema();
      await db.table(backend.table).insert({
        run_id: `${runId}-stale`,
        seq: 1,
        frame: null,
        created_at: Date.now() - 120_000,
      });
      await sink.open(runId).end();
      for (let tries = 0; tries < 100 && (await sink.has(`${runId}-stale`)); tries += 1) {
        await sleep(5);
      }
      expect(await sink.has(`${runId}-stale`)).toBe(false);
      expect(await sink.has(runId)).toBe(true);
    });

    it('does not create the table under autoCreateTables: false', async () => {
      const sink = sinkOn(0, { autoCreateTables: false });
      await expect(sink.has(runId)).rejects.toThrow();
    });
  });
});

describe('LucidTokenStreamSink wiring', () => {
  let db: Database;

  beforeEach(() => {
    db = makeMemoryDb();
  });

  afterEach(async () => {
    await db.manager.closeAll();
  });

  it('is built by tokenSinks.lucid() over a given database', async () => {
    const sink = await tokenSinks.lucid({ db: asDb(db), pollIntervalMs: 5, flushMs: 0 })({
      app: undefined as never,
    });
    expect(sink).toBeInstanceOf(LucidTokenStreamSink);
    const writer = await sink.open('run-1');
    await writer.write({ t: 'text', v: 'hi' });
    await writer.end();
    expect(await collect(sink, 'run-1')).toEqual([{ t: 'text', v: 'hi' }]);
  });

  it('resolves the named Lucid connection from the container', async () => {
    const asked: (string | undefined)[] = [];
    const manager = {
      connection: (name?: string) => {
        asked.push(name);
        return asDb(db);
      },
    };
    const app = { container: { make: async () => manager } };
    const sink = await tokenSinks.lucid({ connection: 'pg' })({ app: app as never });
    expect(sink).toBeInstanceOf(LucidTokenStreamSink);
    expect(asked).toEqual(['pg']);
  });

  it('refuses a table name that is not a plain identifier', () => {
    expect(() => new LucidTokenStreamSink(asDb(db), { tableName: 'frames"; DROP' })).toThrow(
      /not a valid table name/,
    );
  });

  it('gets its table from createAgentTables too, on a database that predates it', async () => {
    await createAgentTables(asDb(db));
    // A database provisioned before the sink existed: everything but the frame table.
    await db.rawQuery(`DROP TABLE "${AGENT_TABLES.streamFrames}"`);
    expect(await createAgentTables(asDb(db))).toEqual([]);

    const sink = new LucidTokenStreamSink(asDb(db), { autoCreateTables: false, flushMs: 0 });
    const writer = sink.open('run-1');
    await writer.write({ t: 'text', v: 'hi' });
    await writer.end();
    expect(await collect(sink, 'run-1')).toEqual([{ t: 'text', v: 'hi' }]);
  });
});
