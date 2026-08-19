import { z } from 'zod';
import type { BrandedFunctionalTool } from '../ai-tool-ref.js';
import { defineTool } from '../ai-tool-ref.js';
import type { AiToolCtx } from '../spi/tool.js';
import type { LucidRawRunner } from '../stores/lucid.js';
import { injectLimit } from './limit.js';
import { loadSqlParser } from './parser.js';
import { SqlValidator } from './sql-validator.js';
import {
  type GroupTableAccessConfig,
  GroupTableAccessPolicy,
  type TableAccessPolicy,
} from './table-access.js';
import { type TenantScopeConfig, TenantScopeRewriter } from './tenant-scope.js';

/** App-supplied runner over a read-only connection. The package never opens a DB itself. */
export interface QueryRunner {
  run(sql: string): Promise<Record<string, unknown>[]>;
}

/**
 * Configuration for {@link dataTool} — the governed read-only SQL agent tool. Mirrors the reference
 * `ExecuteSqlDeps`, adapted to the AdonisJS `defineConfig`/factory idiom. Supply the DB handle as a
 * structural {@link LucidRawRunner} (so `@adonisjs/lucid` stays an optional peer) or a custom
 * {@link QueryRunner}.
 */
export interface DataToolConfig {
  /**
   * Read-only Lucid DB handle (structural). Queries run through `db.rawQuery(sql)`. Point it at a
   * read-only connection/replica. Provide this OR {@link DataToolConfig.runner}.
   */
  db?: LucidRawRunner;
  /** Custom query runner. Overrides {@link DataToolConfig.db} when both are given. */
  runner?: QueryRunner;
  /**
   * Coarse table-level allowlist checked for every referenced table. Pass a {@link TableAccessPolicy}
   * instance, or a {@link GroupTableAccessConfig} to build the default {@link GroupTableAccessPolicy}.
   * **Required** — there is no implicit allow-all (fail-closed).
   */
  tableAccess: TableAccessPolicy | GroupTableAccessConfig;
  /** Optional per-row tenant constraint injected before the query runs. */
  tenant?: TenantScopeConfig;
  /** Row cap injected when the query has no LIMIT. Default 100. */
  maxRows?: number;
  /**
   * Reject the query if the runner has not resolved within this many ms — a soft statement-timeout
   * guard (the query may keep running server-side; the model gets a timeout error to re-plan). Off by
   * default; pair with a DB-level statement timeout for a hard cap.
   */
  statementTimeoutMs?: number;
  /** Tool name the model sees. Default `executeSql`. */
  name?: string;
  /** Roles allowed to invoke the tool (spec-level gate). Omit → config defaults (ADMIN-only). */
  roles?: string[];
  /** Authz ability checked by an ability-aware `RolesPolicy`. */
  ability?: string;
}

export interface DataToolResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  sql: string;
  truncated?: true;
}

const DEFAULT_MAX_ROWS = 100;
const DEFAULT_TOOL_NAME = 'executeSql';

/** Serialized rows above this size are truncated so a single tool result can't blow the context. */
const MAX_RESULT_BYTES = 256 * 1024;

const inputSchema = z.object({
  sql: z.string().min(1).describe('A single read-only MySQL SELECT statement'),
});

type DataToolInput = z.infer<typeof inputSchema>;

const DESCRIPTION =
  'Execute a single read-only MySQL SELECT statement. Use this to answer questions about real ' +
  'data. Only SELECT is allowed (no INSERT/UPDATE/DELETE/DDL). Access is restricted to the ' +
  'tables your role is permitted to read, results are capped, and tenant-scoped tables are ' +
  'automatically constrained to your current tenant.';

function isTableAccessPolicy(
  value: TableAccessPolicy | GroupTableAccessConfig,
): value is TableAccessPolicy {
  return typeof (value as TableAccessPolicy).canAccess === 'function';
}

/** Normalize whatever a Lucid `rawQuery` returns (SQLite array, PG `{rows}`, MySQL `[rows,fields]`). */
function normalizeRows(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    // mysql2 returns `[rows, fields]`; the first element is itself the rows array.
    if (raw.length > 0 && Array.isArray(raw[0])) {
      return raw[0] as Record<string, unknown>[];
    }
    return raw as Record<string, unknown>[];
  }
  if (raw !== null && typeof raw === 'object' && Array.isArray((raw as { rows?: unknown }).rows)) {
    return (raw as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}

function withTimeout<T>(promise: Promise<T>, ms: number | undefined): Promise<T> {
  if (ms === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Query exceeded the ${ms}ms statement timeout.`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Builds the governed `executeSql` read tool as a branded functional tool ({@link defineTool}) the agent
 * registry auto-discovers. Register it in `config/agent.ts` (`defineConfig({ tools: [dataTool({ ... })] })`)
 * or export it from an `app/agent_tools/` module.
 *
 * The pipeline per call (identical to the reference satellite) is:
 * validate (single SELECT) → assert table access for every referenced table →
 * tenant-scope rewrite (if configured) → inject LIMIT → run → return rows,
 * truncating the payload if it would exceed ~256KB. `node-sql-parser` is imported lazily on the first
 * call, so it stays an optional peer.
 */
export function dataTool(config: DataToolConfig): BrandedFunctionalTool {
  const maxRows = config.maxRows ?? DEFAULT_MAX_ROWS;
  const tableAccess = isTableAccessPolicy(config.tableAccess)
    ? config.tableAccess
    : new GroupTableAccessPolicy(config.tableAccess);

  const runner = resolveRunner(config);

  // Lazily built once from the lazily-imported parser, then reused across calls.
  let pipeline: Promise<{ validator: SqlValidator; tenantScope?: TenantScopeRewriter }> | null =
    null;
  const getPipeline = () => {
    if (pipeline === null) {
      pipeline = loadSqlParser().then((parser) => ({
        validator: new SqlValidator(parser),
        ...(config.tenant !== undefined
          ? { tenantScope: new TenantScopeRewriter(config.tenant, parser) }
          : {}),
      }));
    }
    return pipeline;
  };

  return defineTool<DataToolInput>(
    {
      name: config.name ?? DEFAULT_TOOL_NAME,
      kind: 'read',
      description: DESCRIPTION,
      input: inputSchema,
      ...(config.roles !== undefined ? { roles: config.roles } : {}),
      ...(config.ability !== undefined ? { ability: config.ability } : {}),
    },
    async (input: DataToolInput, ctx: AiToolCtx): Promise<DataToolResult> => {
      const { validator, tenantScope } = await getPipeline();
      const { tables } = validator.validate(input.sql);

      const roles = ctx.actor.roles ?? [];
      const forbidden = tables.filter((table) => !tableAccess.canAccess(roles, table));
      if (forbidden.length > 0) {
        const formatted = forbidden.map((table) => `\`${table}\``).join(', ');
        const rolesLabel = roles.length > 0 ? roles.join(', ') : 'none';
        throw new Error(`Your roles (${rolesLabel}) are not allowed to query ${formatted}.`);
      }

      let sql = input.sql;
      if (tenantScope) {
        // CRITICAL: pass ctx.actor.tenantRef through UNTOUCHED. A strictly-`undefined` tenantRef is the
        // privileged pass-through; a `null`/empty one must NOT be coerced to undefined (that would leak
        // every tenant's rows), so never `?? undefined` here.
        sql = tenantScope.rewrite(sql, ctx.actor.tenantRef);
      }
      const parser = await loadSqlParser();
      sql = injectLimit(parser, sql, maxRows);

      const rows = await withTimeout(runner.run(sql), config.statementTimeoutMs);
      return buildResult(rows, sql);
    },
  );
}

function resolveRunner(config: DataToolConfig): QueryRunner {
  if (config.runner !== undefined) return config.runner;
  const db = config.db;
  if (db === undefined) {
    throw new Error(
      'dataTool: provide either `db` (a Lucid database handle) or a custom `runner`.',
    );
  }
  return {
    async run(sql: string): Promise<Record<string, unknown>[]> {
      const raw = await db.rawQuery(sql);
      return normalizeRows(raw);
    },
  };
}

function buildResult(rows: Record<string, unknown>[], sql: string): DataToolResult {
  const rowCount = rows.length;
  if (byteLength(rows) <= MAX_RESULT_BYTES) {
    return { rows, rowCount, sql };
  }

  // Keep prefix rows until the serialized payload would exceed the cap.
  const kept: Record<string, unknown>[] = [];
  let size = 2; // opening + closing bracket of the JSON array
  for (const row of rows) {
    const rowSize = byteLength(row) + 1; // +1 for the joining comma
    if (size + rowSize > MAX_RESULT_BYTES) break;
    kept.push(row);
    size += rowSize;
  }

  return { rows: kept, rowCount, sql, truncated: true };
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}
