/**
 * The `createdAt` / `updatedAt` every Agora console reads the same way. A store hands back whatever
 * its driver gave it — epoch ms (the agent tables' `BIGINT`, possibly as a string or a bigint), a
 * `Date`, an ISO string, a Luxon `DateTime` — and these turn it into a `Date`, or the ISO 8601 string
 * (`null` when unknown) the JSON APIs send.
 */

/** `value` as a `Date`, or `undefined` when it is absent or not a time. */
export function toDate(value: unknown): Date | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  let date: Date | undefined;
  if (value instanceof Date) date = new Date(value.getTime());
  else if (typeof value === 'number') date = new Date(value);
  else if (typeof value === 'bigint') date = new Date(Number(value));
  else if (typeof value === 'string') {
    // Epoch ms read back as a string (Postgres `BIGINT` through pg) or an ISO timestamp.
    date = /^-?\d+$/.test(value) ? new Date(Number(value)) : new Date(value);
  } else if (typeof (value as { toJSDate?: unknown }).toJSDate === 'function') {
    date = (value as { toJSDate: () => Date }).toJSDate();
  }
  return date === undefined || Number.isNaN(date.getTime()) ? undefined : date;
}

/** `value` as an ISO 8601 string, or `null` when it is absent or not a time. */
export function toIsoOrNull(value: unknown): string | null {
  return toDate(value)?.toISOString() ?? null;
}
