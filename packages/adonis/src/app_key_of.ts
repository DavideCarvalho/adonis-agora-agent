/**
 * The app's APP_KEY, found the same way in every Agora lib (SECURITY-UNIFORM-SPEC §13c):
 *
 * 1. `config.get('app.appKey')`;
 * 2. `config.get('encryption')` (AdonisJS 7): its default entry (`list[default]`, else the first
 *    entry), whose first usable key is `keys[…]` or `key`; the lazy config providers `defineConfig`
 *    and `drivers.*` return are resolved first, and a flat `{ keys }` / `{ key }` is read as is;
 * 3. `process.env.APP_KEY`.
 *
 * A `Secret` (`.release()`) and a plain string are both accepted, returned released; an empty one,
 * or a source that throws, counts as "no key here". Never logged.
 */
export async function appKeyOf(app: unknown): Promise<string | undefined> {
  let fromApp: unknown;
  try {
    fromApp = (app as AppLike)?.config?.get?.('app.appKey');
  } catch {
    fromApp = undefined;
  }
  return (
    releasedKey(fromApp) ??
    releasedKey(await encryptionKeyOf(app)) ??
    releasedKey(process.env.APP_KEY)
  );
}

interface AppLike {
  config?: { get?(key: string, fallback?: unknown): unknown };
}

/** A `Secret` or a string as a non-empty string, else `undefined` (a throwing `release` too). */
function releasedKey(value: unknown): string | undefined {
  let raw = value;
  if (raw !== null && typeof raw === 'object') {
    const release = (raw as { release?: unknown }).release;
    if (typeof release !== 'function') return undefined;
    try {
      raw = (raw as { release(): unknown }).release();
    } catch {
      return undefined;
    }
  }
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** A config value that may be an AdonisJS config provider (`{ resolver(app) }`), resolved. */
async function resolved(value: unknown, app: unknown): Promise<unknown> {
  if (value === null || typeof value !== 'object') return value;
  const resolver = (value as { resolver?: unknown }).resolver;
  if (typeof resolver !== 'function') return value;
  try {
    return await (resolver as (app: unknown) => unknown).call(value, app);
  } catch {
    return undefined;
  }
}

/** The first usable key of an encryption config entry, whatever its shape (`keys[…]`, `key`). */
function keyOfEntry(entry: unknown): unknown {
  if (entry === null || typeof entry !== 'object') return undefined;
  const { keys, key } = entry as { keys?: unknown; key?: unknown };
  if (Array.isArray(keys)) return keys.find((k) => releasedKey(k) !== undefined);
  return key;
}

/** The key of `config/encryption.ts`: the first key of its default (else first) entry. */
async function encryptionKeyOf(app: unknown): Promise<unknown> {
  let raw: unknown;
  try {
    raw = (app as AppLike)?.config?.get?.('encryption');
  } catch {
    return undefined;
  }
  const config = await resolved(raw, app);
  if (config === null || typeof config !== 'object') return undefined;
  const { list, default: name } = config as { list?: unknown; default?: unknown };
  if (list !== null && typeof list === 'object') {
    const entries = list as Record<string, unknown>;
    const chosen =
      typeof name === 'string' && Object.hasOwn(entries, name) ? name : Object.keys(entries)[0];
    return chosen === undefined ? undefined : keyOfEntry(await resolved(entries[chosen], app));
  }
  return keyOfEntry(config);
}
