import type { LucidDatabaseLike } from '../../src/index.js';
import { rowsOf } from '../../src/stores/lucid-schema.js';

/** What went to the database through a {@link countingDb}: statements sent, and rows they returned. */
export interface DbTraffic {
  statements: number;
  rows: number;
}

const TERMINAL = new Set(['first', 'select', 'update', 'delete', 'insert', 'multiInsert']);

/**
 * `db`, counting every statement sent through it and every row those statements returned. Builders
 * are proxied so a chain (`from().where().select()`) counts once, at the call that runs it.
 */
export function countingDb(db: LucidDatabaseLike): { db: LucidDatabaseLike; traffic: DbTraffic } {
  const traffic: DbTraffic = { statements: 0, rows: 0 };
  const wrapBuilder = (builder: object): object =>
    new Proxy(builder, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          if (TERMINAL.has(String(prop))) {
            traffic.statements += 1;
            return Promise.resolve(result).then((rows: unknown) => {
              if (Array.isArray(rows)) traffic.rows += rows.length;
              else if (prop === 'first' && rows !== null && rows !== undefined) traffic.rows += 1;
              return rows;
            });
          }
          return result === target ? wrapBuilder(target) : result;
        };
      },
    });
  const wrapped = new Proxy(db as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'from' || prop === 'table') {
        return (table: string) => wrapBuilder((value as (t: string) => object).call(target, table));
      }
      if (prop === 'rawQuery') {
        return async (sql: string, bindings?: unknown) => {
          traffic.statements += 1;
          const result = await (value as (s: string, b?: unknown) => Promise<unknown>).call(
            target,
            sql,
            bindings,
          );
          traffic.rows += rowsOf(result).length;
          return result;
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as LucidDatabaseLike;
  return { db: wrapped, traffic };
}
