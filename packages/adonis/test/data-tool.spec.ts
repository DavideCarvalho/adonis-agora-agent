import { beforeAll, describe, expect, it } from 'vitest';
import {
  dataTool,
  GroupTableAccessPolicy,
  loadSqlParser,
  type QueryRunner,
  type SqlParserLike,
  TenantScopeRewriter,
} from '../src/index.js';
import type { AiToolCtx } from '../src/spi/tool.js';

class FakeRunner implements QueryRunner {
  lastSql: string | undefined;
  constructor(private readonly rows: Record<string, unknown>[]) {}
  async run(sql: string): Promise<Record<string, unknown>[]> {
    this.lastSql = sql;
    return this.rows;
  }
}

/** Build an AiToolCtx. `tenantRef` is deliberately typed loosely so we can pass `null` to prove it is NOT privileged. */
function ctx(
  overrides: { roles?: string[]; tenantRef?: string | null | undefined } = {},
): AiToolCtx {
  return {
    threadId: 'thread-1',
    runId: 'run-1',
    requestId: 'req-1',
    actor: {
      id: 'actor-1',
      roles: overrides.roles ?? ['ANALYST'],
      // `null` stays PRESENT (the spec proves null is not privileged); only absent/undefined is omitted.
      ...(overrides.tenantRef === undefined ? {} : { tenantRef: overrides.tenantRef as string }),
    },
  };
}

const tableAccess = new GroupTableAccessPolicy({
  roleGroups: { ANALYST: ['OPERATIONAL'] },
  tablesByGroup: { OPERATIONAL: ['vehicle'], ADMIN_ONLY: ['user'] },
});

describe('dataTool', () => {
  it('exposes a read-kind functional tool spec', () => {
    const runner = new FakeRunner([]);
    const tool = dataTool({ runner, tableAccess });
    expect(tool.spec.name).toBe('executeSql');
    expect(tool.spec.kind).toBe('read');
  });

  it('runs a SELECT on an allowed table and injects a LIMIT', async () => {
    const runner = new FakeRunner([{ id: 1 }, { id: 2 }]);
    const tool = dataTool({ runner, tableAccess });

    const result = (await tool.handler.execute({ sql: 'SELECT id FROM vehicle' }, ctx())) as {
      rows: unknown[];
      rowCount: number;
    };

    expect(result).toMatchObject({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 });
    expect(runner.lastSql).toContain('LIMIT 100');
    expect(runner.lastSql).toContain('vehicle');
  });

  it('rejects a non-SELECT (INSERT) before it reaches the runner', async () => {
    const runner = new FakeRunner([]);
    const tool = dataTool({ runner, tableAccess });
    await expect(
      tool.handler.execute({ sql: "INSERT INTO vehicle (id) VALUES ('x')" }, ctx()),
    ).rejects.toThrow();
    expect(runner.lastSql).toBeUndefined();
  });

  it('throws when the query touches a denied table (fail-closed allow-list)', async () => {
    const runner = new FakeRunner([]);
    const tool = dataTool({ runner, tableAccess });

    await expect(tool.handler.execute({ sql: 'SELECT id FROM user' }, ctx())).rejects.toThrow(
      /not allowed to query/,
    );
    expect(runner.lastSql).toBeUndefined();
  });

  it('constrains a scoped table to the tenant predicate', async () => {
    const runner = new FakeRunner([{ id: 1 }]);
    const tool = dataTool({
      runner,
      tableAccess,
      tenant: { tenantColumn: 'base_id', scopedTables: ['vehicle'] },
    });

    await tool.handler.execute({ sql: 'SELECT id FROM vehicle' }, ctx({ tenantRef: 'tenant-abc' }));

    expect(runner.lastSql).toContain('base_id');
    expect(runner.lastSql).toContain('tenant-abc');
  });

  it('passes through unchanged when tenantRef is undefined (privileged)', async () => {
    const runner = new FakeRunner([{ id: 1 }]);
    const tool = dataTool({
      runner,
      tableAccess,
      tenant: { tenantColumn: 'base_id', scopedTables: ['vehicle'] },
    });

    await tool.handler.execute({ sql: 'SELECT id FROM vehicle' }, ctx({ tenantRef: undefined }));

    expect(runner.lastSql).not.toContain('base_id');
  });

  it('does NOT let a tenant predicate under OR count as scope coverage (the OR bypass)', async () => {
    const runner = new FakeRunner([{ id: 1 }]);
    const tool = dataTool({
      runner,
      tableAccess,
      tenant: { tenantColumn: 'base_id', scopedTables: ['vehicle'] },
    });

    await tool.handler.execute(
      { sql: "SELECT id FROM vehicle WHERE base_id = 'tenant-abc' OR 1 = 1" },
      ctx({ tenantRef: 'tenant-abc' }),
    );

    // The input SQL already contains one `tenant-abc` literal (inside the OR). A rewriter that
    // (wrongly) treats that predicate as coverage adds nothing, so the literal still appears
    // exactly once in the emitted SQL — `OR 1 = 1` still matches every tenant's rows. A rewriter
    // that correctly refuses to treat an OR-side predicate as coverage ANDs its own tenant
    // predicate onto the whole WHERE, so the literal appears TWICE.
    const occurrences = (runner.lastSql?.match(/tenant-abc/g) ?? []).length;
    expect(occurrences).toBe(2);
  });

  it('does NOT treat a null tenantRef as privileged (injects a fail-closed predicate)', async () => {
    const runner = new FakeRunner([{ id: 1 }]);
    const tool = dataTool({
      runner,
      tableAccess,
      tenant: { tenantColumn: 'base_id', scopedTables: ['vehicle'] },
    });

    await tool.handler.execute({ sql: 'SELECT id FROM vehicle' }, ctx({ tenantRef: null }));

    // A null tenant must still be constrained — it must never fall through to the privileged path.
    expect(runner.lastSql).toContain('base_id');
    expect(runner.lastSql).not.toBe('SELECT id FROM vehicle');
  });

  it('enforces the configured maxRows in the injected LIMIT', async () => {
    const runner = new FakeRunner([{ id: 1 }]);
    const tool = dataTool({ runner, tableAccess, maxRows: 25 });

    await tool.handler.execute({ sql: 'SELECT id FROM vehicle' }, ctx());

    expect(runner.lastSql).toContain('LIMIT 25');
  });
});

describe('TenantScopeRewriter (undefined-vs-null security semantic)', () => {
  let rewriter: TenantScopeRewriter;

  beforeAll(async () => {
    const parser: SqlParserLike = await loadSqlParser();
    rewriter = new TenantScopeRewriter(
      { tenantColumn: 'base_id', scopedTables: ['vehicle'] },
      parser,
    );
  });

  it('undefined → passes SQL through untouched (privileged)', () => {
    const sql = 'SELECT id FROM vehicle';
    expect(rewriter.rewrite(sql, undefined)).toBe(sql);
  });

  it('null → is NOT privileged: injects a constraining predicate', () => {
    const out = rewriter.rewrite('SELECT id FROM vehicle', null as unknown as string);
    expect(out).toContain('base_id');
    expect(out).not.toBe('SELECT id FROM vehicle');
  });

  it('empty string → is NOT privileged either', () => {
    const out = rewriter.rewrite('SELECT id FROM vehicle', '');
    expect(out).toContain('base_id');
  });

  it('rejects a cross-tenant predicate (no reading another tenant)', () => {
    expect(() =>
      rewriter.rewrite("SELECT id FROM vehicle WHERE base_id = 'other'", 'mine'),
    ).toThrow(/tenant mismatch/);
  });
});
