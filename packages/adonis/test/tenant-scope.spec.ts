import { beforeAll, describe, expect, it } from 'vitest';
import { loadSqlParser, type SqlParserLike, TenantScopeRewriter } from '../src/index.js';

/**
 * Focused spec for `TenantScopeRewriter`'s boolean-context handling — the `OR` bypass
 * (a tenant predicate found anywhere in the tree used to mark a table "covered", so
 * `WHERE base_id = 'mine' OR 1 = 1` passed through unconstrained) plus the adjacent shapes
 * that exercise the same coverage logic.
 *
 * Assertions count occurrences of the tenant literal (`tenant-abc`) rather than comparing
 * exact SQL strings, because `sqlify` reformats identifiers (backticks) independent of
 * whether a constraining predicate was added — an exact-string comparison would pass or
 * fail for the wrong reason.
 */
describe('TenantScopeRewriter — OR/AND boolean-context coverage', () => {
  let rewriter: TenantScopeRewriter;

  beforeAll(async () => {
    const parser: SqlParserLike = await loadSqlParser();
    rewriter = new TenantScopeRewriter(
      { tenantColumn: 'base_id', scopedTables: ['vehicle'] },
      parser,
    );
  });

  function countLiteral(sql: string): number {
    return (sql.match(/tenant-abc/g) ?? []).length;
  }

  it('1. WHERE base_id = tenant-abc OR 1 = 1 — the reported bypass — still gets constrained', () => {
    const sql = "SELECT id FROM vehicle WHERE base_id = 'tenant-abc' OR 1 = 1";
    const out = rewriter.rewrite(sql, 'tenant-abc');
    // Input has ONE tenant-abc literal (inside the OR). A correctly-constrained result ANDs a
    // second one onto the whole WHERE, so the disjunction can never bypass it.
    expect(countLiteral(out)).toBe(2);
  });

  it('2. WHERE base_id = tenant-abc OR base_id <> tenant-abc — still gets constrained', () => {
    const sql = "SELECT id FROM vehicle WHERE base_id = 'tenant-abc' OR base_id <> 'tenant-abc'";
    const out = rewriter.rewrite(sql, 'tenant-abc');
    // Input already has TWO occurrences (one per branch); a correct fix ANDs a third.
    expect(countLiteral(out)).toBe(3);
  });

  it('3. WHERE NOT (base_id = tenant-abc) — still gets constrained', () => {
    const sql = "SELECT id FROM vehicle WHERE NOT (base_id = 'tenant-abc')";
    const out = rewriter.rewrite(sql, 'tenant-abc');
    expect(countLiteral(out)).toBe(2);
  });

  it('4. WHERE (base_id = tenant-abc AND status = x) OR status = y — still gets constrained', () => {
    const sql =
      "SELECT id FROM vehicle WHERE (base_id = 'tenant-abc' AND status = 'x') OR status = 'y'";
    const out = rewriter.rewrite(sql, 'tenant-abc');
    // The predicate is conjunctive only *inside* the left OR-branch, not on the query's own
    // top-level AND spine (the top-level operator here is OR) — so it must NOT count as coverage.
    expect(countLiteral(out)).toBe(2);
  });

  it('5. WHERE base_id = tenant-abc AND status = x — the conjunctive case is already covered (no duplicate)', () => {
    const sql = "SELECT id FROM vehicle WHERE base_id = 'tenant-abc' AND status = 'x'";
    const out = rewriter.rewrite(sql, 'tenant-abc');
    // Must NOT gain a second, redundant predicate.
    expect(countLiteral(out)).toBe(1);
  });

  it('6. two aliases of the same scoped table — only the uncovered alias gains a constraint', () => {
    const sql =
      "SELECT v.id FROM vehicle v JOIN vehicle w ON v.id = w.id WHERE v.base_id = 'tenant-abc'";
    const out = rewriter.rewrite(sql, 'tenant-abc');
    // `v` starts covered (1 occurrence); `w` must gain its own alias-qualified predicate (+1).
    expect(countLiteral(out)).toBe(2);
    expect(out).toContain('`w`.`base_id`');
  });

  it('the reported bypass really is fixed at the SQL-semantics level, not just the AST level', () => {
    // Regression guard for a second bug found while fixing the first: `andCondition` must mark
    // the pre-existing (possibly OR-rooted) WHERE with `parentheses: true` before AND-ing the
    // tenant predicate onto it. Without that flag, node-sql-parser's printer renders AND/OR at
    // the same precedence, left-to-right — so `(a OR b) AND c` and `a OR (b AND c)` would print
    // IDENTICALLY (no parens), and a real database applying standard SQL precedence (AND binds
    // tighter than OR) would read the emitted text as `a OR (b AND c)`, silently un-doing the fix
    // for exactly the OR-shaped queries this rewriter exists to constrain.
    const out = rewriter.rewrite(
      "SELECT id FROM vehicle WHERE base_id = 'tenant-abc' OR 1 = 1",
      'tenant-abc',
    );
    expect(out).toContain("(`base_id` = 'tenant-abc' OR 1 = 1)");
  });

  it('preserved: undefined tenantRef still passes through unchanged (privileged)', () => {
    const sql = 'SELECT id FROM vehicle';
    expect(rewriter.rewrite(sql, undefined)).toBe(sql);
  });

  it('preserved: null tenantRef is still fail-closed (NOT privileged)', () => {
    const out = rewriter.rewrite('SELECT id FROM vehicle', null as unknown as string);
    expect(out).toContain('base_id');
    expect(out).not.toBe('SELECT id FROM vehicle');
  });

  it('preserved: a foreign-tenant predicate at the top level still throws tenant mismatch', () => {
    expect(() =>
      rewriter.rewrite("SELECT id FROM vehicle WHERE base_id = 'other'", 'mine'),
    ).toThrow(/tenant mismatch/);
  });

  it('preserved (design decision): a foreign-tenant predicate under an OR still throws tenant mismatch', () => {
    // This is the deliberate split from the plan: coverage is computed from the AND spine only
    // (so `OR` never suppresses the constraint), but the MISMATCH check still walks the whole
    // tree — a query that so much as *names* a foreign tenant, anywhere, is rejected outright
    // rather than silently AND-ed down to zero rows.
    expect(() =>
      rewriter.rewrite("SELECT id FROM vehicle WHERE base_id = 'other-tenant' OR 1 = 1", 'mine'),
    ).toThrow(/tenant mismatch/);
  });
});
