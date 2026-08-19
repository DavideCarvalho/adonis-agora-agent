import type { ActorDirectory } from './spi/actor-directory.js';

/** A row a governance surface renders that carries an opaque `actorRef`. */
export interface ActorRefRow {
  actorRef: string;
}

/**
 * A row decorated with the display label an {@link ActorDirectory} resolved for its `actorRef`. The
 * field is optional and absent (never `null`, never the raw ref) when the directory knows no label,
 * so a consumer's `row.actorLabel ?? row.actorRef` fallback stays the one rendering rule.
 */
export type WithActorLabel<T> = T & { actorLabel?: string };

/**
 * Decorate every row with `actorLabel`, resolved from ONE batched {@link ActorDirectory} lookup over
 * the distinct refs in the page — not one lookup per row, which is what turns a 200-row governance
 * page into 200 queries against the host's user table.
 *
 * Fail-soft by design: no directory bound, or a directory that throws, leaves the rows exactly as
 * they came out of the read-model. A label is cosmetic, and a governance page that renders raw refs
 * is strictly better than one that 500s because the host's user service is down.
 */
export async function withActorLabels<T extends ActorRefRow>(
  rows: T[],
  directory: ActorDirectory | null | undefined,
): Promise<WithActorLabel<T>[]> {
  if (directory === null || directory === undefined || rows.length === 0) return rows;
  const labels = await resolveLabels(
    rows.map((row) => row.actorRef),
    directory,
  );
  if (labels === null) return rows;
  return rows.map((row) => {
    const label = labels[row.actorRef];
    return label === undefined ? row : { ...row, actorLabel: label };
  });
}

/** {@link withActorLabels} for a single row (or `null`, which passes straight through). */
export async function withActorLabel<T extends ActorRefRow>(
  row: T | null,
  directory: ActorDirectory | null | undefined,
): Promise<WithActorLabel<T> | null> {
  if (row === null) return null;
  const [decorated] = await withActorLabels([row], directory);
  return decorated ?? row;
}

/** The distinct-ref lookup, returning `null` when the directory failed (callers then skip labelling). */
async function resolveLabels(
  refs: string[],
  directory: ActorDirectory,
): Promise<Record<string, string> | null> {
  try {
    return await directory.resolveDisplay([...new Set(refs)]);
  } catch {
    return null;
  }
}
