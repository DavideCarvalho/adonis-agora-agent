/**
 * What the agent runs on — its SQL connection, its Redis, its LLM providers, its vector store —
 * described under the global `@adonis-agora/stack` symbol, so a stack view (telescope's
 * Architecture page) reads it off `config/agent.ts` with no code in the app. Nothing here depends
 * on telescope: the symbol is the whole contract. Never put a key, a secret or a URL in a `label`.
 */

/** The symbol a factory (or the config object) carries its {@link StackUse} list under. */
export const STACK_DESCRIPTOR = Symbol.for('@adonis-agora/stack');

/** One piece of infrastructure the agent uses. */
export interface StackUse {
  /** `postgres`, `redis`, `anthropic`, `openai`, `qdrant`, … (lowercase, `[a-z0-9._-]`, ≤ 32). */
  tech: string;
  /** The Lucid or Redis connection it goes through. */
  connection?: string;
  /** What it is for, in a few words (`chat history`, `LLM`). */
  purpose?: string;
  /** For something with no connection: a model family, a collection, a table. */
  label?: string;
  /** For an API or a server: its host, only to tell two apart (hashed by the reader, never sent). */
  host?: string;
}

/** Attach `use` to `target` (replacing what it carried). Returns `target`. */
export function describeStackUse<T extends object>(target: T, use: StackUse | StackUse[]): T {
  try {
    Object.defineProperty(target, STACK_DESCRIPTOR, {
      value: Array.isArray(use) ? use : [use],
      enumerable: false,
      configurable: true,
    });
  } catch {
    // A frozen object: nothing to describe.
  }
  return target;
}

/** The uses `value` carries, or `[]`. */
export function stackUsesOf(value: unknown): StackUse[] {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return [];
  try {
    const uses = (value as Record<symbol, unknown>)[STACK_DESCRIPTOR];
    return Array.isArray(uses) ? (uses as StackUse[]) : [];
  } catch {
    return [];
  }
}

const TECH_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** A tech name the descriptor accepts, from a free-form one (`Amazon Bedrock` → `amazon-bedrock`). */
export function stackTech(raw: string | undefined, fallback: string): string {
  const tech = (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 32);
  return TECH_RE.test(tech) ? tech : fallback;
}

const SQL_TECH: Record<string, string> = {
  pg: 'postgres',
  postgres: 'postgres',
  postgresql: 'postgres',
  'pg-native': 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  'better-sqlite3': 'sqlite',
  sqlite3: 'sqlite',
  sqlite: 'sqlite',
  libsql: 'sqlite',
  mssql: 'mssql',
};

/** The structural slice of Lucid's `Database` the connection name and client are read from. */
interface LucidManagerLike {
  primaryConnectionName?: unknown;
  manager?: { get?(name: string): { config?: { client?: unknown } } | undefined };
}

/**
 * A Lucid-backed factory's use, completed at boot once the `Database` is resolved: the connection
 * an omitted `connection` falls back to, and the technology (`postgres`, `mysql`, `sqlite`) of the
 * one it uses. Best effort — a `db` that does not look like Lucid's leaves the use as it was.
 */
export function refineLucidUse(
  target: object,
  db: unknown,
  connection: string | undefined,
  purpose: string,
  extra: StackUse[] = [],
): void {
  try {
    const manager = db as LucidManagerLike | undefined;
    const name =
      connection ??
      (typeof manager?.primaryConnectionName === 'string'
        ? manager.primaryConnectionName
        : undefined);
    const client = name === undefined ? undefined : manager?.manager?.get?.(name)?.config?.client;
    const tech =
      typeof client === 'string' ? (SQL_TECH[client] ?? stackTech(client, 'sql')) : 'sql';
    describeStackUse(target, [
      { tech, ...(name !== undefined ? { connection: name } : {}), purpose },
      ...extra,
    ]);
  } catch {
    // keep the use it was built with
  }
}

/**
 * A model's family from its id, without the vendor prefix, the version date or the Bedrock suffix:
 * `us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0` → `claude-sonnet-4-5`,
 * `openai/gpt-4o-2024-08-06` → `gpt-4o`, `gpt-4o-mini` → `gpt-4o-mini`.
 */
export function modelFamily(modelId: string): string {
  let id = modelId.slice(modelId.lastIndexOf('/') + 1);
  // Bedrock: `[region.]vendor.model-vN:M`.
  id = id.replace(/-v\d+(:\d+)?$/, '').replace(/:\d+$/, '');
  const dot = id.lastIndexOf('.');
  if (dot >= 0 && /^[a-z]/i.test(id.slice(dot + 1))) id = id.slice(dot + 1);
  id = id.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '').replace(/@.*$/, '');
  return id.slice(0, 80) || modelId.slice(0, 80);
}

/** The LLM uses of the models a provider runs: tech = the provider family, label = the model family. */
export function llmUses(models: ReadonlyArray<{ modelId: string; provider?: string }>): StackUse[] {
  const seen = new Set<string>();
  const uses: StackUse[] = [];
  for (const model of models) {
    const tech = stackTech(model.provider, 'llm');
    const label = modelFamily(model.modelId);
    const key = `${tech}\u0000${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uses.push({ tech, label, purpose: 'LLM' });
  }
  return uses;
}

/**
 * What a resolved model provider runs on: the descriptor it carries (`aiSdkModel` sets one), else
 * its `describeModels()`. `[]` when it says nothing.
 */
export function modelProviderUses(provider: unknown): StackUse[] {
  const own = stackUsesOf(provider);
  if (own.length > 0) return own;
  try {
    const describe = (provider as { describeModels?: () => unknown } | undefined)?.describeModels;
    const models = typeof describe === 'function' ? describe.call(provider) : undefined;
    return Array.isArray(models)
      ? llmUses(
          models.filter(
            (m): m is { modelId: string; provider?: string } =>
              m !== null && typeof m === 'object' && typeof m.modelId === 'string',
          ),
        )
      : [];
  } catch {
    return [];
  }
}
