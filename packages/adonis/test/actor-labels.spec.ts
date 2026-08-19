import { describe, expect, it } from 'vitest';
import type { ActorDirectory } from '../src/index.js';
import { withActorLabel, withActorLabels } from '../src/index.js';
import { InMemoryActorDirectory } from '../src/testing/index.js';

/**
 * The read-side identity seam was configurable long before anything consumed it: `actorDirectory`
 * resolved into a provider field that was written, cleared, and never read, so every governance
 * surface rendered raw opaque refs no matter what the app bound. These tests pin the decoration
 * itself — the batching, the omission of unknown refs, and the fail-soft posture — so the seam stays
 * wired rather than drifting back into a config key that does nothing.
 */
describe('withActorLabels', () => {
  const directory = new InMemoryActorDirectory({ u_1: 'Ada Lovelace', u_2: 'Alan Turing' });

  it('attaches a display label to every row whose ref the directory knows', async () => {
    const rows = await withActorLabels(
      [
        { actorRef: 'u_1', costUsd: 1 },
        { actorRef: 'u_2', costUsd: 2 },
      ],
      directory,
    );

    expect(rows).toEqual([
      { actorRef: 'u_1', actorLabel: 'Ada Lovelace', costUsd: 1 },
      { actorRef: 'u_2', actorLabel: 'Alan Turing', costUsd: 2 },
    ]);
  });

  it('omits the field entirely for an unknown ref rather than echoing the raw ref', async () => {
    const [row] = await withActorLabels([{ actorRef: 'u_unknown' }], directory);

    // Absent, not `null` and not a copy of the ref: consumers render `actorLabel ?? actorRef`, and a
    // fabricated label would make an unresolved ref indistinguishable from a resolved one.
    expect(row).toEqual({ actorRef: 'u_unknown' });
    expect(row !== undefined && 'actorLabel' in row).toBe(false);
  });

  it('asks the directory ONCE, for the distinct refs in the page', async () => {
    const seen: string[][] = [];
    const counting: ActorDirectory = {
      async resolveDisplay(refs) {
        seen.push([...refs]);
        return { u_1: 'Ada Lovelace' };
      },
    };

    await withActorLabels(
      [{ actorRef: 'u_1' }, { actorRef: 'u_1' }, { actorRef: 'u_9' }],
      counting,
    );

    // One batched lookup, deduped — not one query per row, which is what turns a 200-row governance
    // page into 200 round trips against the host's user table.
    expect(seen).toEqual([['u_1', 'u_9']]);
  });

  it('leaves rows untouched when no directory is bound', async () => {
    expect(await withActorLabels([{ actorRef: 'u_1' }], null)).toEqual([{ actorRef: 'u_1' }]);
    expect(await withActorLabels([{ actorRef: 'u_1' }], undefined)).toEqual([{ actorRef: 'u_1' }]);
  });

  it('does not call a directory at all for an empty page', async () => {
    let called = false;
    const spy: ActorDirectory = {
      async resolveDisplay() {
        called = true;
        return {};
      },
    };

    expect(await withActorLabels([], spy)).toEqual([]);
    expect(called).toBe(false);
  });

  it('falls back to raw refs when the directory throws (a label is never worth a 500)', async () => {
    const broken: ActorDirectory = {
      async resolveDisplay() {
        throw new Error('user service unavailable');
      },
    };

    await expect(withActorLabels([{ actorRef: 'u_1' }], broken)).resolves.toEqual([
      { actorRef: 'u_1' },
    ]);
  });
});

describe('withActorLabel', () => {
  const directory = new InMemoryActorDirectory({ u_1: 'Ada Lovelace' });

  it('decorates a single row', async () => {
    expect(await withActorLabel({ actorRef: 'u_1', title: 'Onboarding' }, directory)).toEqual({
      actorRef: 'u_1',
      actorLabel: 'Ada Lovelace',
      title: 'Onboarding',
    });
  });

  it('passes `null` straight through (an unknown thread/run stays null)', async () => {
    expect(await withActorLabel(null, directory)).toBeNull();
  });
});
