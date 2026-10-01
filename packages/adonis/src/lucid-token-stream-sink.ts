import type { SinkWriter, StreamFrame, TokenStreamSink } from './spi/token-stream-sink.js';
import type { LucidDatabaseLike } from './stores/lucid.js';
import { AGENT_TABLES, ensureStreamFrameTable, rowsOf } from './stores/lucid-schema.js';
import { portableSql } from './stores/sql-dialect.js';

/** Default TTL (seconds) for a run's rows: 1h past its last write, the same window the Redis sink keeps. */
const DEFAULT_TTL_SECONDS = 3600;

/** Default gap (ms) between two reads of a run a subscriber is following. */
const DEFAULT_POLL_INTERVAL_MS = 250;

/** Default gap (ms) between two reads once a run has been quiet for {@link IDLE_AFTER_MS}. */
const DEFAULT_IDLE_POLL_INTERVAL_MS = 1000;

/** How long a run has to write nothing before its subscribers slow down to the idle interval. */
const IDLE_AFTER_MS = 5000;

/** Default window (ms) consecutive `text` frames are gathered over before they are written as one row. */
const DEFAULT_FLUSH_MS = 50;

/** Rows read per query, so a long run's replay is paged rather than loaded whole. */
const READ_PAGE = 500;

/** Run ids deleted per statement by {@link LucidTokenStreamSink.purgeExpired}. */
const PURGE_CHUNK = 200;

/** The least time between two purges an instance starts on its own (see `autoPurge`). */
const AUTO_PURGE_EVERY_MS = 60_000;

/** Attempts at one append before a sequence-number collision is reported instead of retried. */
const APPEND_ATTEMPTS = 8;

export interface LucidTokenStreamSinkOptions {
  /** The frame table. Defaults to `agent_stream_frame` (`AGENT_TABLES.streamFrames`). */
  tableName?: string;
  /**
   * Gap (ms) between two reads of a run a subscriber is following — the most a frame waits in the
   * table before a browser sees it. Defaults to 250.
   */
  pollIntervalMs?: number;
  /**
   * Gap (ms) between two reads once the run has written nothing for five seconds (parked on a
   * human, a slow tool), so an open SSE connection on a quiet run costs one query a second rather
   * than four. The first frame to arrive puts the subscriber back on `pollIntervalMs`. Defaults to
   * 1000; never below `pollIntervalMs`.
   */
  idlePollIntervalMs?: number;
  /**
   * Window (ms) consecutive `text` frames are gathered over and written as ONE row — a model
   * streams token by token, and a row per token is more writes than a database should take for a
   * chat answer. Any other frame, and `end()`, write what is gathered first, so order is kept.
   * Defaults to 50. `0` writes every frame as its own row.
   */
  flushMs?: number;
  /**
   * TTL (seconds) of a run's rows, counted from its LAST write — so a long run stays, and a run
   * that crashed without ending still lapses. {@link LucidTokenStreamSink.purgeExpired} is what
   * deletes them. Defaults to 3600 (1h). `0` keeps rows until `close()`/manual cleanup.
   */
  ttlSeconds?: number;
  /**
   * Purge lapsed runs from this instance as a side effect of ending a run, at most once a minute,
   * so the table stays bounded in an app that never schedules {@link LucidTokenStreamSink.purgeExpired}.
   * Default `true`. Set `false` to purge only from your own schedule.
   */
  autoPurge?: boolean;
  /**
   * Create the frame table on first use (and at startup, under the agent provider). Default `true`.
   * Set `false` when the published migration (`createAgentTables`) owns the schema.
   */
  autoCreateTables?: boolean;
}

/** One run's write side in this process: the text being gathered, and the writes already queued. */
interface RunWrites {
  text: string | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Settles when every write queued so far has been attempted. Never rejects. */
  tail: Promise<void>;
  pending: number;
  /** A gathered write that failed on its timer, with nobody awaiting it — reported by the next call. */
  failure: { error: unknown } | undefined;
}

function toInt(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number.parseInt(value, 10) || 0;
  return 0;
}

/**
 * Did this insert lose the race for a `(run_id, seq)`? Read off the driver's own code — Postgres
 * `23505`, SQLite `SQLITE_CONSTRAINT_*`, MySQL `ER_DUP_ENTRY`/1062 (or its deadlock victim, 1213),
 * SQL Server 2627 — so nothing
 * else (a missing table, a lost connection) is ever retried as though it were one.
 */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: unknown; errno?: unknown; number?: unknown } | null;
  if (e === null || typeof e !== 'object') return false;
  if (e.code === '23505' || e.code === 'ER_DUP_ENTRY') return true;
  // InnoDB settles two `INSERT … SELECT MAX(seq) + 1` into one run (both taking gap locks on the
  // same range) by rolling one back as a deadlock victim, not with a duplicate key: the same lost
  // race, just as safe to retry.
  if (e.code === 'ER_LOCK_DEADLOCK' || e.errno === 1213) return true;
  if (typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) return true;
  return e.errno === 1062 || e.number === 2627;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A multi-replica {@link TokenStreamSink} over the app's SQL database (through `@adonisjs/lucid`) —
 * for a deployment with several replicas and NO Redis. The replica running the model turn appends
 * each frame as a row of `agent_stream_frame`; any replica serves the run's SSE by reading the rows
 * past its cursor, in order, until it meets the end marker. A subscriber that attaches late, or
 * after the run ended, replays from the first row — the same guarantee the in-process and Redis
 * sinks give.
 *
 * Two things differ from the Redis sink, and both are the price of having no broker:
 *
 *  - **Delivery is polled.** There is no publish to wake a subscriber, so a frame waits up to
 *    `pollIntervalMs` (250 ms) before a browser sees it.
 *  - **Text is coalesced on the way in.** Consecutive `text` frames written within `flushMs`
 *    (50 ms) are stored as ONE `text` frame holding their concatenation. The stored rows are the
 *    run's stream: every subscriber, on every replica, reads the same rows in the same order, so
 *    the SSE event ids `AgentSseEncoder` counts from them — and an `after` cursor — stay exact. They
 *    are NOT the ids the in-process sink would have produced for the same run (it numbers every
 *    token), which only matters to a cursor carried across a change of sink.
 *
 * Sequence numbers are per run, start at 1 and have no gaps: each append takes `MAX(seq) + 1` for
 * its run in the same statement that inserts it, and the `(run_id, seq)` primary key turns a
 * collision into a retry. A run normally has ONE writer, and then no append ever collides; the
 * retry exists for a parent whose delegated children (each forwarding into its stream, possibly
 * from another replica) write at once. Nothing depends on ordering across runs.
 *
 * Text a writer is still gathering lives in the process for at most `flushMs`; a process that dies
 * in that window loses it from the LIVE stream (the persisted message is unaffected).
 *
 * Wire it with `defineConfig({ sink: tokenSinks.lucid() })`.
 */
export class LucidTokenStreamSink implements TokenStreamSink {
  private readonly table: string;
  private readonly pollIntervalMs: number;
  private readonly idlePollIntervalMs: number;
  private readonly flushMs: number;
  private readonly ttlSeconds: number;
  private readonly autoPurge: boolean;
  private readonly autoCreateTables: boolean;
  private readonly writes = new Map<string, RunWrites>();
  private provisioned: Promise<void> | undefined;
  private lastAutoPurge = 0;

  constructor(
    private readonly db: LucidDatabaseLike,
    options: LucidTokenStreamSinkOptions = {},
  ) {
    const table = options.tableName ?? AGENT_TABLES.streamFrames;
    // The name is spliced into SQL (DDL takes no bindings), so it has to be a plain identifier.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error(`LucidTokenStreamSink: "${table}" is not a valid table name`);
    }
    this.table = table;
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.idlePollIntervalMs = Math.max(
      this.pollIntervalMs,
      options.idlePollIntervalMs ?? DEFAULT_IDLE_POLL_INTERVAL_MS,
    );
    this.flushMs = Math.max(0, options.flushMs ?? DEFAULT_FLUSH_MS);
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.autoPurge = options.autoPurge ?? true;
    this.autoCreateTables = options.autoCreateTables ?? true;
  }

  /**
   * Create the frame table if it is missing. The agent provider calls this once as the app starts;
   * a sink built by hand falls back to it on first use. A no-op under `autoCreateTables: false`.
   */
  ensureSchema(): Promise<void> {
    if (!this.autoCreateTables) return Promise.resolve();
    if (this.provisioned === undefined) {
      this.provisioned = ensureStreamFrameTable(this.db, this.table).catch((error) => {
        this.provisioned = undefined;
        throw error;
      });
    }
    return this.provisioned;
  }

  private runWrites(runId: string): RunWrites {
    let state = this.writes.get(runId);
    if (state === undefined) {
      state = {
        text: null,
        timer: undefined,
        tail: Promise.resolve(),
        pending: 0,
        failure: undefined,
      };
      this.writes.set(runId, state);
    }
    return state;
  }

  /** Forget a run's write state once nothing is gathered, queued or left to report. */
  private release(runId: string, state: RunWrites): void {
    if (
      state.pending === 0 &&
      state.text === null &&
      state.failure === undefined &&
      this.writes.get(runId) === state
    ) {
      this.writes.delete(runId);
    }
  }

  /** Queue `work` behind every write already queued for the run, so rows land in call order. */
  private enqueue(runId: string, state: RunWrites, work: () => Promise<void>): Promise<void> {
    state.pending += 1;
    const next = state.tail.then(work);
    state.tail = next
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        state.pending -= 1;
        this.release(runId, state);
      });
    return next;
  }

  /** Queue the gathered text (if any) as one `text` row. */
  private flushText(runId: string, state: RunWrites): Promise<void> {
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (state.text === null) return Promise.resolve();
    const frame: StreamFrame = { t: 'text', v: state.text };
    state.text = null;
    return this.enqueue(runId, state, () => this.append(runId, JSON.stringify(frame)));
  }

  /** Raise, once, a gathered write that failed with nobody awaiting it. */
  private raiseFailure(state: RunWrites): void {
    const failure = state.failure;
    if (failure !== undefined) {
      state.failure = undefined;
      throw failure.error;
    }
  }

  /** Append one row to the run — a frame, or the end marker (`null`). */
  private async append(runId: string, frame: string | null): Promise<void> {
    await this.ensureSchema();
    for (let attempt = 1; ; attempt += 1) {
      try {
        // The next number and the insert are one statement; see the class comment for why the
        // primary key, not a lock, is what settles two writers asking at once.
        await this.db.rawQuery(
          portableSql(
            this.db,
            `INSERT INTO "${this.table}" ("run_id", "seq", "frame", "created_at") ` +
              `SELECT ?, COALESCE(MAX("seq"), 0) + 1, ?, ? FROM "${this.table}" WHERE "run_id" = ?`,
          ),
          [runId, frame, Date.now(), runId],
        );
        return;
      } catch (error) {
        if (attempt >= APPEND_ATTEMPTS || !isUniqueViolation(error)) throw error;
      }
    }
  }

  /**
   * The run's writer. Writers opened for the same run in one process share what they are gathering,
   * so a delegated run's text (forwarded through a {@link childSinkWriter}) and its parent's next
   * frame keep the order they were written in.
   */
  open(runId: string): SinkWriter {
    return {
      write: async (frame: StreamFrame) => {
        const state = this.runWrites(runId);
        this.raiseFailure(state);
        if (frame.t === 'text' && this.flushMs > 0) {
          state.text = (state.text ?? '') + frame.v;
          // Counted from the FIRST gathered token, not the last: a steady stream still reaches the
          // table every `flushMs`, instead of being held for as long as the model keeps talking.
          if (state.timer === undefined) {
            state.timer = setTimeout(() => {
              state.timer = undefined;
              this.flushText(runId, state).catch((error: unknown) => {
                state.failure = { error };
              });
            }, this.flushMs);
          }
          return;
        }
        const flushed = this.flushText(runId, state);
        const appended = this.enqueue(runId, state, () =>
          this.append(runId, JSON.stringify(frame)),
        );
        await Promise.all([flushed, appended]);
      },
      flush: async () => {
        const state = this.runWrites(runId);
        const flushed = this.flushText(runId, state);
        await Promise.all([flushed, state.tail]);
        this.raiseFailure(state);
        this.release(runId, state);
      },
      end: async () => {
        const state = this.runWrites(runId);
        const flushed = this.flushText(runId, state);
        const ended = this.enqueue(runId, state, () => this.append(runId, null));
        await Promise.all([flushed, ended]);
        this.raiseFailure(state);
        this.release(runId, state);
        this.purgeInBackground();
      },
    };
  }

  async *subscribe(runId: string): AsyncIterable<StreamFrame> {
    await this.ensureSchema();
    let cursor = 0;
    let quietSince = Date.now();
    while (true) {
      const rows = await this.db
        .from(this.table)
        .where('run_id', runId)
        .where('seq', '>', cursor)
        .orderBy('seq', 'asc')
        .limit(READ_PAGE)
        .select('seq', 'frame');
      let ended = false;
      for (const row of rows) {
        cursor = toInt(row.seq);
        if (row.frame === null || row.frame === undefined) {
          ended = true;
          continue;
        }
        yield JSON.parse(String(row.frame)) as StreamFrame;
      }
      if (ended) {
        return;
      }
      if (rows.length > 0) {
        quietSince = Date.now();
        // A full page means there may be more already written: read on without waiting.
        if (rows.length >= READ_PAGE) continue;
      }
      await sleep(
        Date.now() - quietSince >= IDLE_AFTER_MS ? this.idlePollIntervalMs : this.pollIntervalMs,
      );
    }
  }

  async has(runId: string): Promise<boolean> {
    await this.ensureSchema();
    return (await this.db.from(this.table).where('run_id', runId).first()) !== null;
  }

  async close(runId: string): Promise<void> {
    const state = this.writes.get(runId);
    if (state !== undefined) {
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.timer = undefined;
      state.text = null;
      state.failure = undefined;
      await state.tail;
      this.writes.delete(runId);
    }
    await this.ensureSchema();
    await this.db.from(this.table).where('run_id', runId).delete();
  }

  /**
   * Delete every run whose last write is older than `ttlSeconds` at `now` (epoch ms) — ended runs
   * past their replay window and runs that crashed without ending alike. Returns how many runs went.
   * Safe to call from any replica, and from several at once. A no-op under `ttlSeconds: 0`.
   *
   * An instance already calls it after a run ends (at most once a minute; `autoPurge`), which keeps
   * the table bounded on a replica that streams. Call it from a schedule as well if a quiet
   * deployment must not keep the last hour's streams around indefinitely.
   */
  async purgeExpired(now: number = Date.now()): Promise<number> {
    if (this.ttlSeconds <= 0) return 0;
    await this.ensureSchema();
    const cutoff = now - this.ttlSeconds * 1000;
    // Two steps rather than one `DELETE … WHERE run_id IN (SELECT … FROM the same table)`, which
    // MySQL refuses. A run that writes between the two was idle for the whole TTL a moment ago.
    const lapsed = rowsOf(
      await this.db.rawQuery(
        portableSql(
          this.db,
          `SELECT "run_id" AS run_id FROM "${this.table}" GROUP BY "run_id" HAVING MAX("created_at") < ?`,
        ),
        [cutoff],
      ),
    ).map((row) => String(row.run_id));
    for (let index = 0; index < lapsed.length; index += PURGE_CHUNK) {
      await this.db
        .from(this.table)
        .whereIn('run_id', lapsed.slice(index, index + PURGE_CHUNK))
        .delete();
    }
    return lapsed.length;
  }

  /** {@link purgeExpired}, unawaited and at most once a minute. Its failure is not the run's. */
  private purgeInBackground(): void {
    if (!this.autoPurge || this.ttlSeconds <= 0) return;
    const now = Date.now();
    if (now - this.lastAutoPurge < AUTO_PURGE_EVERY_MS) return;
    this.lastAutoPurge = now;
    this.purgeExpired(now).catch(() => {
      // Retried after the next run to end; a purge that cannot run must not fail a finished turn.
    });
  }
}
