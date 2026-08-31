import { beforeAll, describe, expect, it } from 'vitest';
import type { SqlParserLike } from '../src/index.js';
import { loadSqlParser, SqlValidationError, SqlValidator } from '../src/index.js';

let validator: SqlValidator;

beforeAll(async () => {
  const parser: SqlParserLike = await loadSqlParser();
  validator = new SqlValidator(parser);
});

describe('SqlValidator (data satellite)', () => {
  it('accepts a SELECT and returns its referenced tables', () => {
    const result = validator.validate(
      'SELECT v.id, b.name FROM vehicle v JOIN base b ON b.id = v.base_id',
    );
    expect(result.tables.sort()).toEqual(['base', 'vehicle']);
  });

  it('rejects INSERT', () => {
    expect(() => validator.validate("INSERT INTO vehicle (id) VALUES ('x')")).toThrow(
      SqlValidationError,
    );
  });

  it('rejects UPDATE', () => {
    expect(() => validator.validate("UPDATE vehicle SET name = 'x' WHERE id = 1")).toThrow(
      SqlValidationError,
    );
  });

  it('rejects DELETE', () => {
    expect(() => validator.validate('DELETE FROM vehicle WHERE id = 1')).toThrow(
      SqlValidationError,
    );
  });

  it('rejects DDL (DROP)', () => {
    expect(() => validator.validate('DROP TABLE vehicle')).toThrow(/DDL is not allowed/);
  });

  it('rejects DDL (CREATE)', () => {
    expect(() => validator.validate('CREATE TABLE t (id INT)')).toThrow(/DDL is not allowed/);
  });

  it('rejects a multi-statement string', () => {
    expect(() => validator.validate('SELECT 1; SELECT 2')).toThrow(/single statement/);
  });

  it('rejects a CTE-wrapped DML (INSERT via WITH)', () => {
    expect(() =>
      validator.validate('WITH x AS (SELECT 1 AS id) INSERT INTO vehicle (id) SELECT id FROM x'),
    ).toThrow(SqlValidationError);
  });
});
