/**
 * Memory: what the assistant has concluded about a person or an organisation, carried across turns
 * and across threads.
 *
 * HOW A READER TELLS IT FROM RAG. Retrieval answers "what do the documents say"; memory answers
 * "what did I decide about you". A passage is content a person authored and can correct at its
 * source, and it is cited. A memory has no source to go and fix: it is the agent's own inference,
 * which is why every record carries an {@link MemoryOrigin} (who wrote it, in which conversation),
 * why the block tells the model to treat it as fallible, and why `forget` is a REQUIRED method on
 * the provider rather than an optional one. A wrong document is a content problem. A wrong memory is
 * the assistant being confidently wrong about someone with nobody aware it is there, so the whole
 * design is arranged around making it visible and removable.
 *
 * WHAT IT COSTS THE PROMPT. One line per memory, capped by `maxMemories`, and each line capped by
 * `maxFactChars` at WRITE time — so the block a turn can carry is the product of two numbers an
 * operator sets, rather than however much the model felt like writing down. Unlike a skill, a memory
 * has no body/catalog split: a fact that cannot be stated in a line is not a memory, it is a
 * document, and documents are retrieval's job.
 *
 * WHAT IT IS NOT: recall over a TRANSCRIPT. Searching what was said earlier is retrieval, and this
 * library already has `Retriever`/`Reranker` for that.
 *
 * RECALL OVER THE MEMORIES THEMSELVES IS A DIFFERENT QUESTION, and it is answered here. The prompt
 * budget must be bounded; the store has no reason to be. A person accumulates preferences over
 * months and an organisation publishes facts for everyone in it, so the applicable set outgrows
 * `maxMemories` quickly — and once it does, WHICH of them the block carries is a decision somebody
 * has to make. Making it by scope starves the widest scopes first, which is precisely backwards: the
 * facts that apply to the most people are the ones nobody sees. So a provider MAY supply
 * {@link MemoryProvider.search}, and where it does, the block is filled by relevance to the turn
 * (see {@link resolveMemoryDigest}) with scope still a hard filter and never a ranking signal.
 * `maxMemories` then means "how many matter right now" rather than "how many a person may have".
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  actorScope,
  defaultScopeResolver,
  type ScopeContext,
  type ScopeResolver,
} from './skills.js';
import type { Actor, ToolDefinition } from './types.js';

/** Who wrote a memory, and out of what. Kept so a person reading it back can ask "says who?". */
export interface MemoryOrigin {
  /** `'agent'` — a turn concluded it. `'human'` — a person wrote it in the host's own console. */
  author: 'agent' | 'human';
  /**
   * The conversation the conclusion was drawn in. MAY name a thread whose messages the history
   * ceiling has since dropped: a memory deliberately outlives its source, so this is a pointer that
   * is allowed to dangle, and a read-back that cannot resolve it says so rather than hiding the row.
   */
  threadId?: string;
  runId?: string;
  actorRef?: string;
}

/** One thing the assistant believes, at one scope. */
export interface MemoryRecord {
  /** The host's row id — what `forget` takes and what a read-back offers a delete button for. */
  id: string;
  /**
   * What the fact is ABOUT. The handle that makes a conflict mechanically detectable: two memories
   * sharing a key at different scopes are one question answered twice, and the narrower wins. A
   * keyless store could only ever hope its facts did not contradict each other.
   */
  key: string;
  /** The fact itself, as the model reads it. */
  text: string;
  /** The opaque scope token it is held at — see `ScopeResolver` in `skills.ts`. */
  scope: string;
  origin: MemoryOrigin;
  /** ISO-8601, so the ceiling can keep the newest with a string comparison it can do purely. */
  updatedAt: string;
  /**
   * Always-on: this fact is in the block whether or not the turn is about it. The difference between
   * working memory and recall, drawn per record — "they report on the calendar year" must not depend
   * on the turn mentioning dates, while "they prefer the shorter runway" can wait until it comes up.
   *
   * A PROPERTY OF THE ROW, NOT OF A WRITE. This library reads it and never sets it, the same way it
   * never mints an `id`: an agent deciding its own conclusions are always-on is an agent deciding
   * how much of every future prompt it gets, so pinning is an operator's act in the host's console.
   * That is also why {@link StoreMemoryInput} carries no `pinned` — the `remember` tool has no
   * parameter to refuse. A host whose upsert drops the flag has silently unpinned the row; preserve
   * it across an upsert on (`scope`, `key`).
   */
  pinned?: boolean;
}

/** A same-key memory a narrower scope outranked, with the value it holds. */
export interface OverriddenMemory {
  scope: string;
  text: string;
  /**
   * Who asserted the beaten value. Travels because precedence is blind to it: an agent's own
   * inference at `actor:` outranks an administrator's published policy at `global`, and an agent
   * that knew only that a wider value existed could not tell the two apart — one is a stale guess,
   * the other is what the organisation decided.
   */
  author: MemoryOrigin['author'];
}

/** One memory as the model and a read-back both meet it. */
export interface MemoryDigestEntry extends MemoryRecord {
  /**
   * Same-key memories this one outranks, widest last. Present ONLY where something was outranked.
   *
   * Carries the beaten TEXT, which is where memory departs from a skill's `shadows`. A skill only
   * has to say which scope it beat — the agent follows one procedure either way. A memory is a
   * VALUE, and an agent that knows only that a wider value existed cannot tell the user what the
   * difference is; it can only choose, silently, which is the thing this is meant to prevent.
   */
  overrides?: OverriddenMemory[];
}

/** What a turn resolved — journaled whole, so its prompt is reconstructible from its journal alone. */
export interface MemoryDigest {
  /** The scope tokens this turn drew from, most specific first. */
  scopes: string[];
  /** The memories in the block, most specific first then by key. */
  entries: MemoryDigestEntry[];
  /**
   * Applicable memories `maxMemories` left out. Non-zero means the block is not the whole truth —
   * and under {@link recalled} it counts what the SEARCH offered and the ceiling dropped, not what
   * the store holds, because nothing asked the store for a total.
   */
  omitted: number;
  /**
   * Of {@link omitted}, how many were ALWAYS-ON. Reported separately because it means something else
   * entirely: ordinary omission is the budget doing its job, while an always-on memory the ceiling
   * dropped is a deployment's own standing policies having silently stopped reaching any prompt.
   * Non-zero is a misconfiguration — more was pinned than the block holds — and the fix is to unpin
   * something or raise `maxMemories`, not to wait for it to come back.
   */
  pinnedOmitted: number;
  /**
   * Whether the entries were selected by relevance to this turn rather than read whole. The model is
   * told (see {@link buildMemoryBlock}), because a partial set read as a whole one turns an absence
   * into evidence: "you never told me that" about a fact it simply was not shown.
   *
   * Optional so a digest journaled before recall existed reads back as the plain scoped read it was.
   */
  recalled?: boolean;
}

/** What a write asks the host to store. `id` and `updatedAt` are the host's to mint. */
export interface MemoryFact {
  key: string;
  text: string;
  scope: string;
  origin: MemoryOrigin;
}

/** Arguments to {@link MemoryProvider.list}. */
export interface ListMemoriesInput {
  /** The scope tokens that apply to this turn, most specific first. */
  scopes: readonly string[];
  ctx: ScopeContext;
}

/**
 * Arguments to {@link MemoryProvider.search}.
 *
 * `scopes` GATES, AND IT GATES FIRST. A search that ranks before it filters is a cross-tenant leak
 * wearing a relevance score: the nearest neighbour to "what is our rollback policy" is another
 * base's rollback policy. Filter in the query, not after it. Records returned outside `scopes` are
 * dropped rather than trusted, so a mistake here costs throughput rather than privacy — but the
 * drop is a backstop, not the boundary.
 */
export interface SearchMemoriesInput {
  /** The scope tokens that apply to this turn, most specific first. A HARD FILTER. */
  scopes: readonly string[];
  /** What this turn is about. Never blank — a blank query is served by `list` instead. */
  query: string;
  /**
   * At most this many distinct KEYS may be ranked in, which is the block's own unit: precedence
   * resolves a key to one line, so `limit` keys is `limit` lines. Pinned records are returned in
   * addition and do not count against it.
   */
  limit: number;
  ctx: ScopeContext;
}

/** Arguments to {@link MemoryProvider.forget}. */
export interface ForgetMemoryInput {
  id: string;
  ctx: ScopeContext;
}

/**
 * Arguments to {@link MemoryProvider.write}. An object rather than positional arguments because
 * `key`, `text` and `scope` are all strings: transposed, a positional call compiles clean and writes
 * a fact whose key is its value, at a scope nobody meant.
 */
export interface StoreMemoryInput extends MemoryFact {
  ctx: ScopeContext;
}

/**
 * Where memories live. The host owns the rows, for the same reason it owns skill rows: the axes a
 * deployment scopes by, the console that edits them and the audit trail are all the host's, and a
 * table this package created at boot would put a consumer's migrations in the path of the schema
 * heal that manages the `agent_*` tables.
 *
 * `forget` is REQUIRED, unlike `write`. A deployment may reasonably populate memory from its own
 * pipeline and offer the agent no write tool; no deployment may reasonably hold conclusions about a
 * person that the person cannot have deleted. Making it optional would make forgetting a wiring
 * choice, and it is not one.
 */
export interface MemoryProvider {
  /**
   * Every memory visible at `scopes`, in any order — this library resolves precedence and the
   * ceiling. Asked on EVERY turn, so keep it cheap. A provider MAY return records outside `scopes`;
   * they are dropped rather than trusted, so a filter bug in a host cannot widen what an actor sees.
   */
  list(input: ListMemoriesInput): MemoryRecord[] | Promise<MemoryRecord[]>;
  /** Delete one record by id. `false` where there was nothing by that id to delete. */
  forget(input: ForgetMemoryInput): boolean | Promise<boolean>;
  /**
   * Upsert on (`scope`, `key`) and return the stored record. Omit to serve memory read-only — the
   * `remember` tool is then never offered, and a turn's tool list is the same on every pod.
   */
  write?(input: StoreMemoryInput): MemoryRecord | Promise<MemoryRecord>;
  /**
   * The memories worth putting in front of a turn about `query`, MOST RELEVANT FIRST. Omit and every
   * turn is served by {@link list} — a deployment with twenty memories must not have to stand up an
   * index to keep working, and one with two thousand uses whatever it already runs (pgvector, a
   * full-text index, a hybrid service). The host owns the index for the same reason it owns the
   * rows.
   *
   * THREE CLAUSES, and the third is the one that is easy to miss:
   *
   * 1. Filter to `scopes` before ranking — see {@link SearchMemoriesInput}.
   * 2. Rank the KEYS visible at those scopes and take the best `limit` of them.
   * 3. Return EVERY record sharing a returned key, plus every `pinned` record at those scopes.
   *
   * Clause three is what keeps precedence intact. Precedence resolves a conflict between two records
   * at one key, narrower winning and the beaten value riding along; a search that returned the
   * `global` half of a conflict and not the `actor:` half would render the org default as the answer
   * — the exact failure memory exists to prevent, and one nothing downstream can detect. It is one
   * query either way:
   *
   * ```sql
   * SELECT * FROM agent_memory
   *  WHERE scope IN (:scopes)
   *    AND (pinned OR key IN (SELECT key FROM agent_memory
   *                            WHERE scope IN (:scopes)
   *                         ORDER BY embedding <=> :queryVector
   *                            LIMIT :limit))
   * ```
   */
  search?(input: SearchMemoriesInput): MemoryRecord[] | Promise<MemoryRecord[]>;
}

/**
 * How many memories the block carries. The same ceiling shape as `maxSkills`, and for the same
 * reason: a prompt that grows with how much the agent has written down is a prompt whose cost nobody
 * set. A budget on the PROMPT and never on the store — with a provider that can
 * {@link MemoryProvider.search}, it is how many matter right now rather than how many a person may
 * have.
 */
export const DEFAULT_MAX_MEMORIES = 20;

/**
 * How long one memory may be, enforced when it is WRITTEN rather than when it is rendered. Enforcing
 * it at render time would make the prompt disagree with the store; enforcing it at write time makes
 * the block's whole ceiling a multiplication an operator can do — `maxMemories × maxFactChars` — and
 * pushes back on the model at the moment it is writing an essay instead of a fact.
 */
export const DEFAULT_MAX_FACT_CHARS = 240;

/** How a turn reaches its memory. See `AgentLoopDeps.memory`. */
export interface MemoryConfig {
  provider: MemoryProvider;
  /** Undefined → `defaultScopeResolver`: the actor's own, their tenant's, the deployment's. */
  scopes?: ScopeResolver;
  /** Undefined → {@link DEFAULT_MAX_MEMORIES}. Always-on memories are taken from it first. */
  maxMemories?: number;
  /** Undefined → {@link DEFAULT_MAX_FACT_CHARS}. */
  maxFactChars?: number;
}

/**
 * Resolve a provider's records against an ordered scope list: most specific wins a key, and the
 * losers' values are carried rather than discarded.
 *
 * Pure, and separately exported, because the loop and the read-back endpoint must reach the same
 * answer — a person has to be shown what the model was shown, or "see what it believes about you"
 * means nothing.
 */
/** Arguments to {@link resolveMemoryDigest}. */
export interface ResolveMemoryDigestInput {
  records: readonly MemoryRecord[];
  /** The scope tokens that apply, most specific first — the precedence order. */
  scopes: readonly string[];
  /** Undefined → {@link DEFAULT_MAX_MEMORIES}. */
  maxMemories?: number;
  /**
   * Whether `records` arrived most-relevant-first, from {@link MemoryProvider.search}. A key's rank
   * is its best-placed record's. Undefined/false → the ceiling selects by scope and recency, which
   * is the right order only while nothing is being starved.
   */
  ranked?: boolean;
}

export function resolveMemoryDigest({
  records,
  scopes,
  maxMemories = DEFAULT_MAX_MEMORIES,
  ranked = false,
}: ResolveMemoryDigestInput): Omit<MemoryDigest, 'scopes' | 'recalled'> {
  const rank = new Map(scopes.map((scope, index) => [scope, index]));
  const byKey = new Map<string, MemoryRecord[]>();
  for (const entry of records) {
    // A scope the resolver did not return is one this actor has no claim on, whatever the provider
    // thinks. Dropping it here is what makes over-returning a performance mistake, not a leak.
    if (!rank.has(entry.scope)) {
      continue;
    }
    const existing = byKey.get(entry.key);
    if (existing === undefined) {
      byKey.set(entry.key, [entry]);
    } else {
      existing.push(entry);
    }
  }
  const resolved: MemoryDigestEntry[] = [];
  for (const candidates of byKey.values()) {
    const ordered = [...candidates].sort(
      (a, b) => (rank.get(a.scope) ?? 0) - (rank.get(b.scope) ?? 0),
    );
    const winner = ordered[0];
    if (winner === undefined) {
      continue;
    }
    const overrides = ordered.slice(1).map((beaten) => ({
      scope: beaten.scope,
      text: beaten.text,
      author: beaten.origin.author,
    }));
    // A pin belongs to the QUESTION, not to the record that currently answers it: pinning "which
    // fiscal year" and then letting a personal override of it fall out of the block would make
    // always-on mean "always-on until someone disagrees with it".
    const pinned = ordered.some((candidate) => candidate.pinned === true);
    resolved.push({
      ...winner,
      ...(pinned ? { pinned: true } : {}),
      ...(overrides.length > 0 ? { overrides } : {}),
    });
  }
  // Three orders, answering three different questions.
  //
  // ALWAYS-ON FIRST, whatever else is true: a pinned fact is in the block whether or not the turn is
  // about it. It spends the same budget as everything else, so the ceiling stays a product of two
  // numbers an operator set rather than growing with how much got pinned.
  //
  // Then SELECTION among the rest — by relevance where the candidates were ranked, else by narrowest
  // scope and newest within it. That second rule is right only while nothing is being starved, which
  // is the case a host running no index is in: `list` returns the whole applicable set, so a ceiling
  // that bites is dropping what the deployment can best afford to lose. Once the set outgrows the
  // block it is exactly wrong, because the scopes it drops first are the ones shared by the most
  // people — one person's twentieth note would end every chance their organisation's facts had.
  //
  // RENDERING is by scope then key, stable between turns: ordering the block by recency or by score
  // would reshuffle it on every write and throw away the provider's prompt cache. Pinned entries
  // lead, because they are the part of the block that does not move from turn to turn.
  const byPrecedence = (a: MemoryDigestEntry, b: MemoryDigestEntry): number =>
    (rank.get(a.scope) ?? 0) - (rank.get(b.scope) ?? 0) ||
    compare(b.updatedAt, a.updatedAt) ||
    compare(a.key, b.key);
  const selected = resolved
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        pinRank(a.entry) - pinRank(b.entry) ||
        (ranked && a.entry.pinned !== true ? a.index - b.index : byPrecedence(a.entry, b.entry)),
    )
    .slice(0, maxMemories)
    .map((candidate) => candidate.entry);
  const pinnedOmitted =
    resolved.filter((entry) => entry.pinned === true).length -
    selected.filter((entry) => entry.pinned === true).length;
  selected.sort(
    (a, b) =>
      pinRank(a) - pinRank(b) ||
      (rank.get(a.scope) ?? 0) - (rank.get(b.scope) ?? 0) ||
      compare(a.key, b.key),
  );
  return {
    entries: selected,
    omitted: Math.max(0, resolved.length - maxMemories),
    pinnedOmitted,
  };
}

function pinRank(entry: MemoryDigestEntry): number {
  return entry.pinned === true ? 0 : 1;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Arguments to {@link offerMemories}. */
export interface OfferMemoriesInput {
  config: MemoryConfig;
  ctx: ScopeContext;
  /**
   * What this turn is about — the loop passes the user's own message, and nothing else. Given, and
   * with a provider that has an index, the block is filled by relevance to it. Absent, the scope is
   * read whole: that is what the read-back endpoint wants, since a person must be shown every belief
   * held about them rather than the slice one turn happened to need.
   */
  query?: string;
}

/**
 * Resolve the scopes and the digest for one turn. Called INSIDE the loop's `memory:digest` step, and
 * that placement is the whole of its determinism: a search is the most re-derivable thing in this
 * library — the index moves, a neighbour is written, embeddings are recomputed — so its result has
 * to be part of the checkpoint every replay reads back, never something a replaying process asks
 * again.
 */
export async function offerMemories({
  config,
  ctx,
  query,
}: OfferMemoriesInput): Promise<MemoryDigest> {
  const scopes = await (config.scopes ?? defaultScopeResolver).resolve(ctx);
  const maxMemories = config.maxMemories ?? DEFAULT_MAX_MEMORIES;
  // A search keyed on nothing ranks on noise, so a turn with no text to search with reads the scope
  // plainly rather than making a worse selection out of it. What carries a fact through a turn like
  // that is `pinned`, not a cleverer query.
  const trimmed = query?.trim() ?? '';
  const search = trimmed.length > 0 ? config.provider.search : undefined;
  const records =
    search !== undefined
      ? await search({ scopes, query: trimmed, limit: maxMemories, ctx })
      : await config.provider.list({ scopes, ctx });
  return {
    scopes,
    recalled: search !== undefined,
    ...resolveMemoryDigest({ records, scopes, maxMemories, ranked: search !== undefined }),
  };
}

/**
 * The block as the model reads it.
 *
 * THREE THINGS IT HAS TO DO THAT A SKILLS CATALOG DOES NOT.
 *
 * It must frame each note by WHO ASSERTED IT, which is why there are two sections rather than one
 * sentence over the whole list. An unlabelled fact in a system prompt reads with the authority of an
 * instruction, and the hazard of an agent's own inference is exactly that authority — so those are
 * hedged. But a memory an administrator published for a whole organisation is not the agent's guess,
 * and telling the model to "prefer what the user says now" about it hands any user an override of
 * their organisation's policy by asserting the opposite. `MemoryOrigin.author` is the axis, and it
 * is the only one that matters here: scope says who a fact applies to, not who decided it.
 *
 * Where a narrower scope won, it must print the value it beat, so the model can tell the user their
 * setting differs from the org's instead of quietly applying one of them.
 *
 * And a block that is a SELECTION must say so. A model reading a partial set as a whole one turns an
 * absence into evidence — "you never told me that" about a fact it simply was not shown.
 */
/** Arguments to {@link buildMemoryBlock}. */
export interface BuildMemoryBlockInput {
  entries: readonly MemoryDigestEntry[];
  /** Whether this deployment offers `remember` — the block names the tool only where it exists. */
  writable: boolean;
  /** Whether applicable memories are missing from `entries` — the ceiling bit, or recall selected. */
  partial: boolean;
}

const ASSERTED_FRAMING =
  'Stated by people. A person wrote each of these deliberately — the user about themselves, or someone administering their organisation. Treat them as you would any other instruction you were given. If the user says something that contradicts one, say which note it conflicts with and at what scope it is held, rather than quietly setting it aside.';

const CONCLUDED_FRAMING =
  'Concluded by you. These are your own notes from earlier turns, not documents anyone wrote: they may be wrong or out of date, so prefer what the user says now, and say where a note came from if you act on it.';

const PARTIAL_FRAMING =
  'You are being shown a selection, not everything on file. Other notes exist that are not in this list, so never read something’s absence from it as evidence that it was never recorded.';

function memorySection(framing: string, entries: readonly MemoryDigestEntry[]): string[] {
  if (entries.length === 0) {
    return [];
  }
  return [
    framing,
    ...entries.flatMap((entry) => [
      `- [${entry.scope}] ${entry.key}: ${entry.text}`,
      ...(entry.overrides ?? []).map(
        (beaten) =>
          `    ↳ [${beaten.scope}] ${beaten.author === 'human' ? 'a person stated' : 'instead has'}: ${beaten.text}`,
      ),
    ]),
  ];
}

export function buildMemoryBlock({ entries, writable, partial }: BuildMemoryBlockInput): string {
  const writeLine = writable
    ? [
        `When you learn something durable about this user, record it with the \`${REMEMBER_TOOL_NAME}\` tool; when one of these turns out to be wrong, record the corrected fact under the same key. What you record that way is one of your own notes, not something stated by a person.`,
      ]
    : [];
  const body = [
    'What is on file about this user and their organisation, carried over from earlier conversations. Each line is a scope, a key and the fact. A narrower scope overrides a wider one; where the wider value is shown underneath, tell the user their setting differs from it rather than silently choosing one.',
    ...(partial ? [PARTIAL_FRAMING] : []),
    ...writeLine,
    // People before inferences: the model meets what it was told before what it worked out.
    ...memorySection(
      ASSERTED_FRAMING,
      entries.filter((entry) => entry.origin.author === 'human'),
    ),
    ...memorySection(
      CONCLUDED_FRAMING,
      entries.filter((entry) => entry.origin.author !== 'human'),
    ),
  ];
  return `<memory>\n${body.join('\n')}\n</memory>`;
}

/** The reserved name of the built-in memory-writing tool. */
export const REMEMBER_TOOL_NAME = 'remember';

/** What the model passes to the `remember` tool. */
export interface RememberToolInput {
  key: string;
  fact: string;
}

const REMEMBER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'fact'],
  properties: {
    key: {
      type: 'string',
      description:
        'A short, stable handle for what this fact is ABOUT (e.g. "fiscal-year", "preferred-units"). Reusing an existing key replaces that fact rather than adding a second one.',
    },
    fact: {
      type: 'string',
      description:
        'The fact itself, in one sentence, stated so it still makes sense in a conversation months from now.',
    },
  },
} as const;

function issue(path: (string | number)[], message: string): StandardSchemaV1.Issue {
  return { message, path };
}

/**
 * The `remember` tool's input schema. Hand-written for the same reason `askInputSchema` and
 * `skillInputSchema` are: core depends on no validator and has to publish a JSON Schema a provider
 * can constrain generation against.
 *
 * THERE IS NO SCOPE PARAMETER, and that is the enforcement rather than a simplification. An agent
 * may only ever write the actor it is running for (see {@link memoryWriteVerdict}), so a scope
 * argument could only ever be a request that gets refused — and a refusable request is one a model
 * will keep making, and one a future reader will be tempted to make grantable.
 */
export const rememberInputSchema: StandardSchemaV1<unknown, RememberToolInput> = {
  '~standard': {
    version: 1,
    vendor: 'adonis-agora-agent',
    validate: (value: unknown) => {
      if (typeof value !== 'object' || value === null) {
        return { issues: [issue([], 'must be an object')] };
      }
      const candidate = value as Partial<RememberToolInput>;
      if (typeof candidate.key !== 'string' || candidate.key.length === 0) {
        return { issues: [issue(['key'], 'must be a non-empty string')] };
      }
      if (typeof candidate.fact !== 'string' || candidate.fact.length === 0) {
        return { issues: [issue(['fact'], 'must be a non-empty string')] };
      }
      return { value: { key: candidate.key, fact: candidate.fact } };
    },
    jsonSchema: { input: () => REMEMBER_JSON_SCHEMA },
  },
} as StandardSchemaV1<unknown, RememberToolInput>;

export const REMEMBER_TOOL_DESCRIPTION =
  'Record one durable fact about this user under a key, so later conversations start knowing it. For things that will still be true another day — how they work, what their organisation requires, a correction they made. Not for what this conversation is about, and not for anything you were not told or could not reasonably infer. The user can read and delete everything you record here.';

/**
 * The `remember` tool as the model sees it. NOT a `ToolSpec` and never registered, exactly like
 * `ask` and `skill`: it has no handler, because the loop serves it against the digest the journal
 * holds. Keeping it out of the `ToolRegistry` is also what keeps its kind off a process-local
 * lookup — see `claimToolCall`.
 */
export function rememberToolDefinition(): ToolDefinition {
  return {
    name: REMEMBER_TOOL_NAME,
    kind: 'memory',
    description: REMEMBER_TOOL_DESCRIPTION,
    inputSchema: rememberInputSchema,
  };
}

/** Who is trying to write a memory. */
export interface MemoryAuthor {
  /**
   * `'human'` is a person acting through a UI; `'agent'` is anything else — a turn, a tool, a batch
   * job. The distinction is the whole of rule three below, so it is not inferable and has to be
   * stated by the caller.
   */
  kind: 'human' | 'agent';
  actorRef?: string;
}

/** A request to write a memory at a scope. */
export interface MemoryWriteRequest {
  scope: string;
  actor: Actor;
  /** The actor's resolved scopes, most specific first — the same list the turn drew its digest from. */
  scopes: readonly string[];
  author: MemoryAuthor;
  /**
   * The host's own answer to "may this person administer that scope". This library cannot know it,
   * and inventing an answer would be a second, weaker authorization model next to the host's real
   * one. Undefined/false → a wider scope is refused.
   */
  elevated?: boolean;
}

export type MemoryVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * May this author write a memory at this scope?
 *
 * The same four rules as `skillWriteVerdict`, deliberately duplicated rather than shared: they are
 * the same rules about two different things, and folding them into one function would mean a future
 * change to how skills are authored silently changing who may edit what the assistant believes about
 * a person. Rule three is the one that matters, and it bites harder here than it does for skills:
 *
 * 1. You may only write into a scope you are yourself in.
 * 2. Your OWN scope is yours. A memory at `actor:<you>` affects exactly one prompt — your own.
 * 3. NOTHING BUT A HUMAN MAY WRITE ABOVE ITS OWN SCOPE, whatever `elevated` says. A skill an agent
 *    could publish at `tenant:` is a procedure anyone in the tenant can edit by talking to the
 *    assistant; a MEMORY it could publish there is a fact everyone in the tenant is then answered
 *    from, with no document to inspect and nobody aware it was written. An agent that has genuinely
 *    learned something the organisation should know proposes it; a person publishes it.
 * 4. A human writing above their own scope needs the host to say so (`elevated`).
 */
export function memoryWriteVerdict(request: MemoryWriteRequest): MemoryVerdict {
  const { scope, scopes, author, actor } = request;
  if (!scopes.includes(scope)) {
    return { allowed: false, reason: `"${scope}" is not a scope this actor belongs to` };
  }
  const own = actorScope(actor);
  if (scope === own) {
    return { allowed: true };
  }
  if (author.kind !== 'human') {
    return {
      allowed: false,
      reason: `only a human may write a memory at "${scope}"; an agent may write only at "${own}"`,
    };
  }
  return request.elevated === true
    ? { allowed: true }
    : { allowed: false, reason: `writing at "${scope}" requires an elevated human author` };
}

/**
 * May this actor delete this memory?
 *
 * Narrower than the write rule on purpose, and it takes no `elevated` flag. Deleting what the
 * assistant believes about YOU needs no permission from anyone — that is the point of the read-back
 * — so the endpoint that serves it must not be able to ask a host a question it might answer no to.
 * Deleting what it believes about a tenant is an administrative act on shared state, which belongs
 * in the host's console with the same elevation a write there needs.
 */
/** A request to delete one memory. */
export interface MemoryForgetRequest {
  record: Pick<MemoryRecord, 'scope'>;
  actor: Actor;
}

export function memoryForgetVerdict({ record, actor }: MemoryForgetRequest): MemoryVerdict {
  return record.scope === actorScope(actor)
    ? { allowed: true }
    : {
        allowed: false,
        reason: `"${record.scope}" is not this actor's own scope; deleting it is an administrative action`,
      };
}

/** What a `remember` call resolved to — the stored record, or why nothing was stored. */
export type MemoryWriteOutcome = { ok: true; record: MemoryRecord } | { ok: false; error: string };

/**
 * Serve one `remember` call against the digest THIS TURN resolved.
 *
 * The digest's `scopes` are the authorization boundary, not the resolver: they came out of the
 * `memory:digest` checkpoint, so a write is checked against the scopes the run recorded rather than
 * the ones a replaying process's resolver would produce now. A membership table edited mid-run
 * cannot retroactively widen — or narrow — what a turn already in flight is allowed to write.
 */
/** Arguments to {@link writeMemory}. */
export interface WriteMemoryInput {
  config: MemoryConfig;
  /** The digest THIS TURN journaled — the authorization boundary, never a fresh resolution. */
  digest: MemoryDigest;
  /** The `remember` call as the model made it. */
  call: RememberToolInput;
  ctx: ScopeContext;
  runId: string;
}

export async function writeMemory({
  config,
  digest,
  call,
  ctx,
  runId,
}: WriteMemoryInput): Promise<MemoryWriteOutcome> {
  const write = config.provider.write;
  if (write === undefined) {
    return { ok: false, error: 'Memory is read-only in this deployment.' };
  }
  const key = call.key.trim();
  const text = call.fact.trim();
  if (key.length === 0 || text.length === 0) {
    return { ok: false, error: 'A memory needs both a key and a fact.' };
  }
  const maxFactChars = config.maxFactChars ?? DEFAULT_MAX_FACT_CHARS;
  if (text.length > maxFactChars) {
    return {
      ok: false,
      error: `A memory must be at most ${maxFactChars} characters; that was ${text.length}. State the fact more briefly.`,
    };
  }
  const scope = actorScope(ctx.actor);
  const verdict = memoryWriteVerdict({
    scope,
    actor: ctx.actor,
    scopes: digest.scopes,
    author: { kind: 'agent', actorRef: ctx.actor.id },
  });
  if (!verdict.allowed) {
    return { ok: false, error: verdict.reason };
  }
  const record = await write({
    key,
    text,
    scope,
    origin: { author: 'agent', threadId: ctx.threadId, runId, actorRef: ctx.actor.id },
    ctx,
  });
  return { ok: true, record };
}
