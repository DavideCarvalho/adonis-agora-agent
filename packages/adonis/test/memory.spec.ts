import { describe, expect, it } from 'vitest';
import type { Actor, MemoryProvider, MemoryRecord, ToolDefinition } from '../src/index.js';
import {
  actorScope,
  buildMemoryBlock,
  DEFAULT_MAX_FACT_CHARS,
  DEFAULT_MAX_MEMORIES,
  GLOBAL_SCOPE,
  memoryForgetVerdict,
  memoryWriteVerdict,
  offerMemories,
  REMEMBER_TOOL_NAME,
  rememberInputSchema,
  rememberToolDefinition,
  resolveMemoryDigest,
  tenantScope,
  withBuiltInTools,
  writeMemory,
} from '../src/index.js';

const actor: Actor = { id: 'u1', tenantRef: 'base-7', roles: ['USER'] };
const ctx = { actor, threadId: 't1' };
const SCOPES = [actorScope(actor), 'sector:logistics', tenantScope('base-7'), GLOBAL_SCOPE];

function record(
  key: string,
  scope: string,
  text: string,
  updatedAt = '2026-09-10T00:00:00.000Z',
): MemoryRecord {
  return {
    id: `${scope}/${key}`,
    key,
    text,
    scope,
    origin: { author: 'agent', threadId: 't0', runId: 'r0', actorRef: 'u1' },
    updatedAt,
  };
}

/** A provider that never forgets anything it was not given, so a test can assert what reached it. */
function provider(records: MemoryRecord[]): MemoryProvider & { written: MemoryRecord[] } {
  const written: MemoryRecord[] = [];
  return {
    written,
    list: ({ scopes }) => records.filter((entry) => scopes.includes(entry.scope)),
    forget: ({ id }) => records.some((entry) => entry.id === id),
    write: (input) => {
      const saved: MemoryRecord = {
        id: `new/${input.key}`,
        key: input.key,
        text: input.text,
        scope: input.scope,
        origin: input.origin,
        updatedAt: '2026-09-10T12:00:00.000Z',
      };
      written.push(saved);
      return saved;
    },
  };
}

describe('resolveMemoryDigest', () => {
  it('lets the most specific scope win a key, and carries the loser’s TEXT rather than only its scope', () => {
    const { entries } = resolveMemoryDigest({
      records: [
        record('fiscal-year', GLOBAL_SCOPE, 'the fiscal year starts in October'),
        record('fiscal-year', actorScope(actor), 'they report on the calendar year'),
      ],
      scopes: SCOPES,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe('they report on the calendar year');
    // The whole of point four: a skill only has to say WHICH scope it beat, because the model is
    // following one procedure either way. A memory has to carry the beaten VALUE, or the model
    // cannot tell the user what the difference between them is.
    expect(entries[0]?.overrides).toEqual([
      { scope: GLOBAL_SCOPE, text: 'the fiscal year starts in October', author: 'agent' },
    ]);
  });

  it('omits `overrides` entirely when a key was answered once', () => {
    const { entries } = resolveMemoryDigest({
      records: [record('units', GLOBAL_SCOPE, 'nautical miles')],
      scopes: SCOPES,
    });
    expect(entries[0]).not.toHaveProperty('overrides');
  });

  it('orders the beaten values widest-last, so the org default reads as the outermost', () => {
    const { entries } = resolveMemoryDigest({
      records: [
        record('fiscal-year', GLOBAL_SCOPE, 'october'),
        record('fiscal-year', tenantScope('base-7'), 'july'),
        record('fiscal-year', 'sector:logistics', 'april'),
      ],
      scopes: SCOPES,
    });
    expect(entries[0]?.overrides?.map((beaten) => beaten.scope)).toEqual([
      'tenant:base-7',
      GLOBAL_SCOPE,
    ]);
  });

  it('drops a record published at a scope the resolver did not return', () => {
    const { entries } = resolveMemoryDigest({
      records: [
        record('theirs', 'actor:u9', 'not yours'),
        record('mine', actorScope(actor), 'yours'),
      ],
      scopes: SCOPES,
    });
    expect(entries.map((entry) => entry.key)).toEqual(['mine']);
  });

  it('renders most-specific-first then by key, so the block is stable between turns', () => {
    // `zulu` is the NEWEST, so the order the ceiling selects in (recency) and the order the block is
    // written in (key) disagree here on purpose: a block ordered by recency would reshuffle itself
    // every time the agent wrote something and throw away the provider's prompt cache.
    const { entries } = resolveMemoryDigest({
      records: [
        record('zulu', actorScope(actor), 'z', '2026-09-01T00:00:00.000Z'),
        record('alpha', GLOBAL_SCOPE, 'a', '2026-08-01T00:00:00.000Z'),
        record('bravo', actorScope(actor), 'b', '2026-01-01T00:00:00.000Z'),
      ],
      scopes: SCOPES,
    });
    expect(entries.map((entry) => `${entry.scope}/${entry.key}`)).toEqual([
      'actor:u1/bravo',
      'actor:u1/zulu',
      'global/alpha',
    ]);
  });

  it('keeps the NEWEST when the ceiling bites within a scope, and still renders by key', () => {
    // Selection and rendering are two different orders on purpose: a ceiling that dropped by key
    // would forget whichever fact happens to sort last, and a block ordered by recency would
    // reshuffle on every write and defeat the prompt cache.
    const { entries, omitted } = resolveMemoryDigest({
      records: [
        record('aaa', GLOBAL_SCOPE, 'stale', '2026-01-01T00:00:00.000Z'),
        record('bbb', GLOBAL_SCOPE, 'fresh', '2026-09-01T00:00:00.000Z'),
      ],
      scopes: SCOPES,
      maxMemories: 1,
    });
    expect(entries.map((entry) => entry.key)).toEqual(['bbb']);
    expect(omitted).toBe(1);
  });

  it('drops the WIDEST scopes first, keeping what is about this person', () => {
    const { entries } = resolveMemoryDigest({
      records: [
        record('aaa-wide', GLOBAL_SCOPE, 'org', '2026-09-09T00:00:00.000Z'),
        record('zzz-mine', actorScope(actor), 'them', '2026-01-01T00:00:00.000Z'),
      ],
      scopes: SCOPES,
      maxMemories: 1,
    });
    expect(entries.map((entry) => entry.key)).toEqual(['zzz-mine']);
  });

  it('reports nothing omitted when everything fits, and defaults its ceiling', () => {
    expect(
      resolveMemoryDigest({ records: [record('one', GLOBAL_SCOPE, 'x')], scopes: SCOPES }).omitted,
    ).toBe(0);
    const many = Array.from({ length: DEFAULT_MAX_MEMORIES + 2 }, (_, index) =>
      record(`k-${String(index).padStart(2, '0')}`, GLOBAL_SCOPE, 'x'),
    );
    const { entries, omitted } = resolveMemoryDigest({ records: many, scopes: SCOPES });
    expect(entries).toHaveLength(DEFAULT_MAX_MEMORIES);
    expect(omitted).toBe(2);
  });
});

describe('offerMemories', () => {
  it('asks the provider for exactly the resolved scopes and journals them on the digest', async () => {
    const asked: string[][] = [];
    const digest = await offerMemories({
      config: {
        provider: {
          list: ({ scopes }) => {
            asked.push([...scopes]);
            return [record('units', 'actor:u1', 'nautical miles')];
          },
          forget: () => true,
        },
      },
      ctx,
    });
    expect(asked).toEqual([['actor:u1', 'tenant:base-7', 'global']]);
    expect(digest.scopes).toEqual(['actor:u1', 'tenant:base-7', 'global']);
    expect(digest.entries.map((entry) => entry.key)).toEqual(['units']);
  });

  it('takes precedence from a host resolver naming an axis this library knows nothing about', async () => {
    const digest = await offerMemories({
      config: {
        provider: {
          list: () => [
            record('handover', GLOBAL_SCOPE, 'at 0800'),
            record('handover', 'shift:night', 'at 2000'),
          ],
          forget: () => true,
        },
        scopes: { resolve: () => ['shift:night', GLOBAL_SCOPE] },
      },
      ctx,
    });
    expect(digest.entries[0]?.scope).toBe('shift:night');
    expect(digest.entries[0]?.overrides).toEqual([
      { scope: GLOBAL_SCOPE, text: 'at 0800', author: 'agent' },
    ]);
  });
});

describe('buildMemoryBlock', () => {
  const entry = resolveMemoryDigest({
    records: [
      record('fiscal-year', GLOBAL_SCOPE, 'the fiscal year starts in October'),
      record('fiscal-year', actorScope(actor), 'they report on the calendar year'),
    ],
    scopes: SCOPES,
  }).entries;

  it('states that these are the agent’s own conclusions, not documents anyone wrote', () => {
    // The one line that keeps a reader — and the model — from treating memory as retrieval. A wrong
    // passage is someone's document to fix; a wrong memory is the assistant confidently wrong about
    // a person, so it has to arrive flagged as fallible.
    const block = buildMemoryBlock({ entries: entry, writable: false, partial: false });
    expect(block).toContain('your own notes');
    expect(block).toContain('prefer what the user says now');
  });

  it('prints the winning value with its scope, and the beaten value underneath', () => {
    const block = buildMemoryBlock({ entries: entry, writable: false, partial: false });
    expect(block).toContain('- [actor:u1] fiscal-year: they report on the calendar year');
    expect(block).toContain('[global] instead has: the fiscal year starts in October');
  });

  it('tells the model to name the difference rather than choose between them silently', () => {
    expect(buildMemoryBlock({ entries: entry, writable: false, partial: false })).toContain(
      'differs',
    );
  });

  it('names the write tool only where the deployment allows writing', () => {
    expect(buildMemoryBlock({ entries: entry, writable: true, partial: false })).toContain(
      `\`${REMEMBER_TOOL_NAME}\``,
    );
    expect(buildMemoryBlock({ entries: entry, writable: false, partial: false })).not.toContain(
      `\`${REMEMBER_TOOL_NAME}\``,
    );
  });
});

describe('the remember tool definition', () => {
  it('is offered only where memory is configured AND writable', () => {
    const tools: ToolDefinition[] = [];
    const built = (memory: boolean) =>
      withBuiltInTools({ tools, ask: false, skills: false, memory }).map((tool) => tool.name);
    expect(built(false)).toEqual([]);
    expect(built(true)).toEqual([REMEMBER_TOOL_NAME]);
  });

  it('carries the `memory` kind, so the branch that serves it is settled in the journal', () => {
    expect(rememberToolDefinition().kind).toBe('memory');
  });

  it('takes no scope parameter, so there is no request rule four has to refuse', () => {
    const schema = rememberToolDefinition().inputSchema['~standard'] as unknown as {
      jsonSchema: { input: () => { properties: Record<string, unknown> } };
    };
    expect(Object.keys(schema.jsonSchema.input().properties)).toEqual(['key', 'fact']);
  });

  it('rejects a call missing either half', async () => {
    expect(
      (await rememberInputSchema['~standard'].validate({ fact: 'x' })).issues?.[0]?.message,
    ).toBe('must be a non-empty string');
    expect(
      (await rememberInputSchema['~standard'].validate({ key: 'x' })).issues?.[0]?.message,
    ).toBe('must be a non-empty string');
  });

  it('accepts a keyed fact', async () => {
    const result = await rememberInputSchema['~standard'].validate({
      key: 'units',
      fact: 'metric',
    });
    expect(result.issues).toBeUndefined();
    expect((result as { value: unknown }).value).toEqual({ key: 'units', fact: 'metric' });
  });
});

describe('memoryWriteVerdict', () => {
  const scopes = ['actor:u1', 'sector:logistics', 'tenant:base-7', GLOBAL_SCOPE];

  it('lets a person write their own memory', () => {
    expect(
      memoryWriteVerdict({ scope: 'actor:u1', actor, scopes, author: { kind: 'human' } }),
    ).toEqual({ allowed: true });
  });

  it('refuses a scope the actor is not in, however elevated', () => {
    expect(
      memoryWriteVerdict({
        scope: 'tenant:other',
        actor,
        scopes,
        author: { kind: 'human' },
        elevated: true,
      }),
    ).toEqual({
      allowed: false,
      reason: '"tenant:other" is not a scope this actor belongs to',
    });
  });

  it('refuses a person writing above their own scope without the host saying so', () => {
    expect(
      memoryWriteVerdict({ scope: GLOBAL_SCOPE, actor, scopes, author: { kind: 'human' } }),
    ).toEqual({ allowed: false, reason: 'writing at "global" requires an elevated human author' });
  });

  it('lets an elevated person promote a fact to a wider scope', () => {
    expect(
      memoryWriteVerdict({
        scope: 'sector:logistics',
        actor,
        scopes,
        author: { kind: 'human' },
        elevated: true,
      }),
    ).toEqual({ allowed: true });
  });

  it('lets an agent write the actor it is running for', () => {
    expect(
      memoryWriteVerdict({ scope: 'actor:u1', actor, scopes, author: { kind: 'agent' } }),
    ).toEqual({ allowed: true });
  });

  it('refuses an agent writing above the actor even when the host elevates it', () => {
    // Rule four, and it bites harder here than it does for skills: a tenant memory an agent can
    // write is a tenant prompt anyone in the tenant can edit by talking to the assistant, with
    // nobody in the tenant aware the edit happened.
    expect(
      memoryWriteVerdict({
        scope: 'tenant:base-7',
        actor,
        scopes,
        author: { kind: 'agent' },
        elevated: true,
      }),
    ).toEqual({
      allowed: false,
      reason:
        'only a human may write a memory at "tenant:base-7"; an agent may write only at "actor:u1"',
    });
  });
});

describe('memoryForgetVerdict', () => {
  it('lets a person delete a memory held at their own scope', () => {
    expect(memoryForgetVerdict({ record: record('units', actorScope(actor), 'x'), actor })).toEqual(
      {
        allowed: true,
      },
    );
  });

  it('refuses deleting a wider memory, and says where that is done instead', () => {
    expect(memoryForgetVerdict({ record: record('units', GLOBAL_SCOPE, 'x'), actor })).toEqual({
      allowed: false,
      reason: '"global" is not this actor\'s own scope; deleting it is an administrative action',
    });
  });
});

describe('writeMemory', () => {
  async function digestFor(source: MemoryProvider) {
    return await offerMemories({ config: { provider: source }, ctx });
  }

  it('writes at the actor’s OWN scope, with the turn recorded as the origin', async () => {
    const source = provider([]);
    const digest = await digestFor(source);
    const outcome = await writeMemory({
      config: { provider: source },
      digest,
      call: { key: 'units', fact: 'they report distances in nautical miles' },
      ctx,
      runId: 'run-9',
    });
    expect(outcome).toEqual({
      ok: true,
      record: {
        id: 'new/units',
        key: 'units',
        text: 'they report distances in nautical miles',
        scope: 'actor:u1',
        origin: { author: 'agent', threadId: 't1', runId: 'run-9', actorRef: 'u1' },
        updatedAt: '2026-09-10T12:00:00.000Z',
      },
    });
  });

  it('refuses a fact longer than the deployment’s per-fact ceiling', async () => {
    const source = provider([]);
    const digest = await digestFor(source);
    const outcome = await writeMemory({
      config: { provider: source, maxFactChars: 20 },
      digest,
      call: { key: 'units', fact: 'x'.repeat(21) },
      ctx,
      runId: 'run-9',
    });
    expect(outcome).toEqual({
      ok: false,
      error: 'A memory must be at most 20 characters; that was 21. State the fact more briefly.',
    });
    expect(source.written).toEqual([]);
  });

  it('defaults that ceiling to DEFAULT_MAX_FACT_CHARS', async () => {
    const source = provider([]);
    const digest = await digestFor(source);
    const outcome = await writeMemory({
      config: { provider: source },
      digest,
      call: { key: 'k', fact: 'x'.repeat(DEFAULT_MAX_FACT_CHARS + 1) },
      ctx,
      runId: 'run-9',
    });
    expect(outcome.ok).toBe(false);
  });

  it('refuses when the actor’s own scope is not one the turn resolved', async () => {
    const source = provider([]);
    // A journaled digest from a resolver that never returned the actor's own token — the boundary
    // is the digest the run recorded, not what this process would resolve now.
    const digest = await offerMemories({
      config: { provider: source, scopes: { resolve: () => [GLOBAL_SCOPE] } },
      ctx,
    });
    const outcome = await writeMemory({
      config: { provider: source },
      digest,
      call: { key: 'k', fact: 'v' },
      ctx,
      runId: 'r',
    });
    expect(outcome).toEqual({
      ok: false,
      error: '"actor:u1" is not a scope this actor belongs to',
    });
    expect(source.written).toEqual([]);
  });

  it('refuses where the provider serves memory but cannot write it', async () => {
    const readOnly: MemoryProvider = { list: () => [], forget: () => true };
    const digest = await offerMemories({ config: { provider: readOnly }, ctx });
    const outcome = await writeMemory({
      config: { provider: readOnly },
      digest,
      call: { key: 'k', fact: 'v' },
      ctx,
      runId: 'r',
    });
    expect(outcome).toEqual({ ok: false, error: 'Memory is read-only in this deployment.' });
  });

  it('trims a key and a fact, so the same fact twice is one row rather than two', async () => {
    const source = provider([]);
    const digest = await digestFor(source);
    await writeMemory({
      config: { provider: source },
      digest,
      call: { key: '  units\n', fact: '  metric ' },
      ctx,
      runId: 'r',
    });
    expect(source.written[0]?.key).toBe('units');
    expect(source.written[0]?.text).toBe('metric');
  });

  it('refuses a key that is only whitespace, rather than writing an unaddressable fact', async () => {
    const source = provider([]);
    const digest = await digestFor(source);
    const outcome = await writeMemory({
      config: { provider: source },
      digest,
      call: { key: '   ', fact: 'v' },
      ctx,
      runId: 'r',
    });
    expect(outcome.ok).toBe(false);
    expect(source.written).toEqual([]);
  });
});

/** A memory an operator marked always-on, rather than one a turn has to be reminded of. */
function alwaysOn(base: MemoryRecord): MemoryRecord {
  return { ...base, pinned: true };
}

/** A memory a person wrote deliberately, rather than one the agent concluded. */
function published(key: string, scope: string, text: string): MemoryRecord {
  return {
    ...record(key, scope, text),
    origin: { author: 'human', actorRef: 'admin-1' },
  };
}

describe('resolveMemoryDigest — selection once the store outgrows the block', () => {
  const personal = Array.from({ length: 3 }, (_, index) =>
    record(`mine-${index}`, actorScope(actor), 'a personal note'),
  );
  const organisational = record(
    'rollback-policy',
    tenantScope('base-7'),
    'roll back before 1600 local',
  );

  it('keeps a ranked provider’s order, so a wider scope can outrank a full personal one', () => {
    // The failure this exists to stop: with selection by scope, one person's twentieth note ends
    // every chance the organisation's own facts had of reaching the prompt.
    const { entries } = resolveMemoryDigest({
      records: [organisational, ...personal],
      scopes: SCOPES,
      maxMemories: 1,
      ranked: true,
    });
    expect(entries.map((entry) => entry.key)).toEqual(['rollback-policy']);
  });

  it('falls back to narrowest-then-newest where nothing ranked the candidates', () => {
    const { entries } = resolveMemoryDigest({
      records: [organisational, ...personal],
      scopes: SCOPES,
      maxMemories: 1,
    });
    expect(entries.map((entry) => entry.key)).toEqual(['mine-0']);
  });

  it('drops a nearest match held at a scope the resolver did not return, ranked first or not', () => {
    // Scope is a filter, and it gates before rank: the nearest neighbour to a question about our
    // rollback policy is another base's rollback policy.
    const { entries } = resolveMemoryDigest({
      records: [
        record('rollback-policy', 'tenant:base-42', 'another base’s policy'),
        record('rollback-policy', tenantScope('base-7'), 'ours'),
      ],
      scopes: SCOPES,
      maxMemories: 1,
      ranked: true,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe('ours');
    // Not carried as a beaten value either — an `overrides` line would print it just the same.
    expect(entries[0]?.overrides).toBeUndefined();
  });

  it('keeps an always-on memory the ranking never reached', () => {
    const { entries } = resolveMemoryDigest({
      records: [
        record('coffee', actorScope(actor), 'they take it black'),
        alwaysOn(
          record('fiscal-year', GLOBAL_SCOPE, 'the organisation reports on the calendar year'),
        ),
      ],
      scopes: SCOPES,
      maxMemories: 1,
      ranked: true,
    });
    expect(entries.map((entry) => entry.key)).toEqual(['fiscal-year']);
  });

  it('spends an always-on memory from the same budget, so the ceiling is still two numbers', () => {
    const { entries, omitted } = resolveMemoryDigest({
      records: [
        alwaysOn(record('a', GLOBAL_SCOPE, 'x')),
        alwaysOn(record('b', GLOBAL_SCOPE, 'y')),
        alwaysOn(record('c', GLOBAL_SCOPE, 'z')),
      ],
      scopes: SCOPES,
      maxMemories: 2,
    });
    expect(entries).toHaveLength(2);
    expect(omitted).toBe(1);
  });

  it('names always-on overflow on its own, because that omission is a misconfiguration', () => {
    // Ordinary omission is the budget working. Always-on omission is a deployment's own standing
    // policies having quietly stopped reaching any prompt, which is the failure this whole selection
    // pass exists to remove — so it gets a number an operator can alert on rather than a share of
    // one.
    const { entries, omitted, pinnedOmitted } = resolveMemoryDigest({
      records: [
        alwaysOn(record('a', GLOBAL_SCOPE, 'x')),
        alwaysOn(record('b', GLOBAL_SCOPE, 'y')),
        record('c', actorScope(actor), 'z'),
      ],
      scopes: SCOPES,
      maxMemories: 1,
    });
    expect(entries.map((entry) => entry.key)).toEqual(['a']);
    expect(omitted).toBe(2);
    expect(pinnedOmitted).toBe(1);
  });

  it('reports no always-on overflow while every pin fits', () => {
    const { pinnedOmitted } = resolveMemoryDigest({
      records: [alwaysOn(record('a', GLOBAL_SCOPE, 'x')), record('b', GLOBAL_SCOPE, 'y')],
      scopes: SCOPES,
      maxMemories: 1,
    });
    expect(pinnedOmitted).toBe(0);
  });

  it('carries a pin across precedence, so overriding an always-on fact does not unpin it', () => {
    const { entries } = resolveMemoryDigest({
      records: [
        record('coffee', actorScope(actor), 'they take it black'),
        alwaysOn(record('fiscal-year', GLOBAL_SCOPE, 'the fiscal year starts in October')),
        record('fiscal-year', actorScope(actor), 'they report on the calendar year'),
      ],
      scopes: SCOPES,
      maxMemories: 1,
      ranked: true,
    });
    expect(entries[0]?.key).toBe('fiscal-year');
    expect(entries[0]?.text).toBe('they report on the calendar year');
    expect(entries[0]?.pinned).toBe(true);
  });
});

describe('offerMemories — recall', () => {
  const refuses = (what: string) => () => {
    throw new Error(what);
  };

  it('searches within the resolved scopes, and marks the digest a selection', async () => {
    const asked: Array<{ scopes: readonly string[]; query: string; limit: number }> = [];
    const digest = await offerMemories({
      config: {
        maxMemories: 2,
        provider: {
          list: refuses('a searching provider must not be asked to read the whole scope'),
          forget: () => true,
          search: ({ scopes, query, limit }) => {
            asked.push({ scopes, query, limit });
            return [record('rollback-policy', tenantScope('base-7'), 'ours')];
          },
        },
      },
      ctx,
      query: 'what is our rollback policy',
    });
    expect(asked).toEqual([
      {
        scopes: ['actor:u1', 'tenant:base-7', 'global'],
        query: 'what is our rollback policy',
        limit: 2,
      },
    ]);
    expect(digest.recalled).toBe(true);
    expect(digest.entries.map((entry) => entry.key)).toEqual(['rollback-policy']);
  });

  it('reads the scope plainly where the host runs no index, whatever the turn asked', async () => {
    const digest = await offerMemories({
      config: {
        provider: { list: () => [record('units', GLOBAL_SCOPE, 'metric')], forget: () => true },
      },
      ctx,
      query: 'what is our rollback policy',
    });
    expect(digest.recalled).toBe(false);
    expect(digest.entries.map((entry) => entry.key)).toEqual(['units']);
  });

  it('reads the scope plainly when the turn carries no text to search with', async () => {
    // A search keyed on nothing ranks on noise. `pinned` is what carries a fact through a turn
    // like this, not a cleverer query.
    const digest = await offerMemories({
      config: {
        provider: {
          list: () => [record('units', GLOBAL_SCOPE, 'metric')],
          forget: () => true,
          search: refuses('a blank query must never reach the index'),
        },
      },
      ctx,
      query: '   ',
    });
    expect(digest.recalled).toBe(false);
    expect(digest.entries.map((entry) => entry.key)).toEqual(['units']);
  });

  it('reads the scope plainly when nothing handed it a query at all — the read-back’s path', async () => {
    const digest = await offerMemories({
      config: {
        provider: {
          list: () => [record('units', GLOBAL_SCOPE, 'metric')],
          forget: () => true,
          search: refuses('the read-back must show everything, not the turn’s selection'),
        },
      },
      ctx,
    });
    expect(digest.recalled).toBe(false);
  });

  it('still drops what a search returned outside the resolved scopes', async () => {
    const digest = await offerMemories({
      config: {
        provider: {
          list: refuses('not this path'),
          forget: () => true,
          search: () => [
            record('rollback-policy', 'tenant:base-42', 'another base’s policy'),
            record('units', GLOBAL_SCOPE, 'metric'),
          ],
        },
      },
      ctx,
      query: 'rollback',
    });
    expect(digest.entries.map((entry) => entry.key)).toEqual(['units']);
  });
});

describe('buildMemoryBlock — whose note the model is reading', () => {
  const concluded = resolveMemoryDigest({
    records: [record('units', actorScope(actor), 'they report distances in nautical miles')],
    scopes: SCOPES,
  }).entries;
  const asserted = resolveMemoryDigest({
    records: [published('rollback-policy', tenantScope('base-7'), 'roll back before 1600 local')],
    scopes: SCOPES,
  }).entries;

  it('never tells the model to prefer the user over something a person published', () => {
    // "These are your own notes, prefer what the user says now" is right for an inference and
    // false for an organisational decision — it hands any user an override of it by assertion.
    const block = buildMemoryBlock({ entries: asserted, writable: false, partial: false });
    expect(block).not.toContain('prefer what the user says now');
    expect(block).not.toContain('your own notes');
    expect(block).toContain('- [tenant:base-7] rollback-policy: roll back before 1600 local');
    expect(block).toContain('conflicts with');
  });

  it('keeps the hedge on what the agent concluded by itself', () => {
    const block = buildMemoryBlock({ entries: concluded, writable: false, partial: false });
    expect(block).toContain('your own notes');
    expect(block).toContain('prefer what the user says now');
  });

  it('frames the two kinds under separate headings when a turn carries both', () => {
    const block = buildMemoryBlock({
      entries: [...asserted, ...concluded],
      writable: false,
      partial: false,
    });
    const hedge = block.indexOf('prefer what the user says now');
    expect(hedge).toBeGreaterThan(block.indexOf('rollback-policy'));
    expect(hedge).toBeLessThan(block.indexOf('units'));
  });

  it('says when the value a narrower note beat was one a person published', () => {
    // Precedence is unchanged — the narrower note still wins — but an agent's own inference
    // outranking an administrator's published policy is worth the model being able to NAME. Without
    // the author on the beaten value it can only say a wider value existed, which reads the same
    // whether the organisation decided it or the agent guessed it last week.
    const { entries } = resolveMemoryDigest({
      records: [
        published('fiscal-year', GLOBAL_SCOPE, 'the fiscal year starts in October'),
        record('fiscal-year', actorScope(actor), 'they report on the calendar year'),
      ],
      scopes: SCOPES,
    });
    expect(entries[0]?.overrides).toEqual([
      { scope: GLOBAL_SCOPE, text: 'the fiscal year starts in October', author: 'human' },
    ]);
    expect(buildMemoryBlock({ entries, writable: false, partial: false })).toContain(
      '↳ [global] a person stated: the fiscal year starts in October',
    );
  });

  it('does not dress up a beaten value the agent concluded for itself', () => {
    const { entries } = resolveMemoryDigest({
      records: [
        record('fiscal-year', GLOBAL_SCOPE, 'the fiscal year starts in October'),
        record('fiscal-year', actorScope(actor), 'they report on the calendar year'),
      ],
      scopes: SCOPES,
    });
    expect(buildMemoryBlock({ entries, writable: false, partial: false })).toContain(
      '↳ [global] instead has: the fiscal year starts in October',
    );
  });

  it('tells the model a partial block is a selection, so an absence is not evidence', () => {
    expect(buildMemoryBlock({ entries: concluded, writable: false, partial: true })).toContain(
      'not everything on file',
    );
    expect(buildMemoryBlock({ entries: concluded, writable: false, partial: false })).not.toContain(
      'not everything on file',
    );
  });
});
