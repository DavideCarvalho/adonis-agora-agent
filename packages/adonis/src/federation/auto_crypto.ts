import { CONSOLE_CRYPTO_KEY, type ConsoleCipher } from './redis_channel.js';
import type { TenantToken, TenantVerifier } from './tenant_auth.js';

/**
 * Automatic crypto mode: when `@adonis-agora/crypto` is booted in the same app, console commands
 * are sealed with its key `console-agent` without a line of configuration. Crypto is detected by
 * its container binding (`'agora.crypto'`), never imported: the shape below is all this lib reads.
 */

/** What this lib reads of `@adonis-agora/crypto`'s runtime (`'agora.crypto'`). */
export interface CryptoRuntimeLike {
  topology: 'standalone' | 'control-plane' | 'tenant';
  /** This app's crypto partition (its app name on a server, its partition on a tenant). */
  partition: string;
  /** Present where crypto is embedded in this app (standalone, control plane). */
  service?: CryptoServiceLike | undefined;
  /** This app's own operations, in-process or over HTTP (or a broker). */
  operations: CryptoOperationsLike;
}

/** What this lib calls on `runtime.operations`. */
export interface CryptoOperationsLike extends ConsoleCipher {
  encrypt(input: {
    key: string;
    plaintext: string;
    aad?: string;
    context?: string;
    /** Seal with another partition's key (a crypto tenant holding `crypto:seal:<key>`). */
    partition?: string;
  }): Promise<{ ciphertext: string }>;
  getKey?(name: string): Promise<unknown>;
  /**
   * Whether this app's partition holds `key` (SECURITY-UNIFORM-SPEC §13f): answered with the same
   * auth as `decrypt`, not audited as an error, a missing key is `false`. Optional: older crypto
   * clients do not have it, and the key check then probes with a dummy decrypt.
   */
  hasKey?(input: { key: string }): Promise<boolean>;
  createKey?(input: { name: string; type: string; description?: string }): Promise<unknown>;
}

/** The principal crypto's service checks each call against. */
export interface CryptoPrincipalLike {
  partition: string;
  capabilities: string[];
  actor: string;
}

/** The few `CryptoService` calls auto mode makes. */
export interface CryptoServiceLike {
  encrypt(
    principal: CryptoPrincipalLike,
    input: { key: string; plaintext: string; aad?: string },
  ): Promise<{ ciphertext: string }>;
  decrypt(
    principal: CryptoPrincipalLike,
    input: { key: string; ciphertext: string; aad?: string; context?: string },
  ): Promise<{ plaintext: string }>;
  createKey(
    principal: CryptoPrincipalLike,
    input: { name: string; type: string; description?: string },
  ): Promise<unknown>;
  store: {
    getKey(
      partition: string,
      name: string,
    ): Promise<{ type?: string; deletedAt?: unknown } | null | undefined>;
  };
}

/** The actor auto mode acts as, in crypto's audit trail. */
export const AUTO_CRYPTO_ACTOR = 'agent:console';

/** `@adonis-agora/crypto`'s runtime, when it is booted in this app. */
export async function cryptoRuntimeOf(container: {
  hasBinding(binding: never): boolean;
  make(binding: never): Promise<unknown>;
}): Promise<CryptoRuntimeLike | undefined> {
  if (!container.hasBinding('agora.crypto' as never)) return undefined;
  const runtime = (await container.make('agora.crypto' as never)) as Partial<CryptoRuntimeLike>;
  if (
    !runtime ||
    typeof runtime.partition !== 'string' ||
    typeof runtime.operations?.encrypt !== 'function' ||
    typeof runtime.operations?.decrypt !== 'function'
  ) {
    return undefined;
  }
  return runtime as CryptoRuntimeLike;
}

/**
 * Create the `aes256-gcm` key `key` in `partition` unless it exists (idempotent, and safe when
 * another instance creates it at the same time). Throws when a key of that name is of another
 * type or deleted, naming it.
 */
export async function ensureConsoleCryptoKey(
  service: CryptoServiceLike,
  partition: string,
  key: string = CONSOLE_CRYPTO_KEY,
): Promise<'created' | 'present'> {
  const existing = await service.store.getKey(partition, key);
  if (existing) {
    if ((existing.type !== undefined && existing.type !== 'aes256-gcm') || existing.deletedAt) {
      throw new Error(
        `[@adonis-agora/agent] the crypto key "${partition}/${key}" exists but is not a live aes256-gcm key; console commands cannot be sealed with it`,
      );
    }
    return 'present';
  }
  try {
    await service.createKey(
      { partition, capabilities: [`crypto:keys:manage:${key}`], actor: AUTO_CRYPTO_ACTOR },
      {
        name: key,
        type: 'aes256-gcm',
        description: "Seals the federated agent console's commands (consoleCommands, crypto mode)",
      },
    );
    return 'created';
  } catch (error) {
    // Another instance created it first.
    if ((error as { code?: unknown } | null)?.code === 'conflict') return 'present';
    throw error;
  }
}

/**
 * The console side's cipher for the app whose crypto partition is `partition`, where crypto is
 * embedded in the console app: it may only encrypt, with `key`, in that partition.
 */
export function consoleEncryptCipher(
  service: CryptoServiceLike,
  partition: string,
  key: string = CONSOLE_CRYPTO_KEY,
): ConsoleCipher {
  const principal = {
    partition,
    capabilities: [`crypto:encrypt:${key}`],
    actor: AUTO_CRYPTO_ACTOR,
  };
  return {
    encrypt: async (input) => {
      try {
        return await service.encrypt(principal, input);
      } catch (error) {
        // The key could not be made at boot (or was deleted since): make it now, once, and retry.
        if (!isNotFound(error)) throw error;
        await ensureConsoleCryptoKey(service, partition, key);
        return service.encrypt(principal, input);
      }
    },
    decrypt: async () => {
      throw new Error('the console side never opens commands');
    },
  };
}

/**
 * The console side's cipher for the app whose crypto partition is `partition`, where this console
 * app is a TENANT of a separate crypto server: the channel `config/crypto.ts` already set up, asked
 * to seal with that app's key (`partition`), which the server allows only for encryption and only
 * when this app's token holds `crypto:seal:<key>`.
 */
export function consoleSealCipher(
  operations: CryptoOperationsLike,
  partition: string,
  key: string = CONSOLE_CRYPTO_KEY,
): ConsoleCipher {
  return {
    encrypt: async (input) => {
      try {
        return await operations.encrypt({ ...input, partition });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `the crypto server would not seal with "${partition}/${key}" (${message}); grant this app \`crypto:seal:console-*\` in authkit, upgrade @adonis-agora/crypto on the crypto server, or configure \`controlPlane.crypto\` explicitly`,
        );
      }
    },
    decrypt: async () => {
      throw new Error('the console side never opens commands');
    },
  };
}

/** What a crypto tenant answers when the key is missing (`not_found`, or a 404). */
function isNotFound(error: unknown): boolean {
  const value = error as { code?: unknown; status?: unknown; statusCode?: unknown } | null;
  return value?.code === 'not_found' || value?.status === 404 || value?.statusCode === 404;
}

/** The package the lines below name (the ported block's only difference besides the key). */
const PACKAGE = '@adonis-agora/agent';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/* ------------------------------------------------------------------------------------------- */
/* App side on a crypto tenant: is the console key there, and usable?                          */
/*                                                                                             */
/* Self-contained on purpose: every Agora lib ports this block as is (only PACKAGE and the     */
/* key default differ). Rules (SECURITY-UNIFORM-SPEC §10.7, §10.14):                           */
/* - ask `operations.hasKey({ key })` when crypto offers it (no audit noise); else probe with a */
/*   dummy decrypt, which an app may always do on its own console keys; never getKey (it needs */
/*   crypto:keys:read);                                                                        */
/* - only "not found" means missing: try to create it (servers with provisioning off), else     */
/*   one INFO line (the crypto server provisions console-* keys on the console's first seal);  */
/* - any other failure (forbidden, unauthenticated, server down) logs one WARN line: never     */
/*   silent, never a boot failure;                                                             */
/* - checked once at boot; after a warning, the next command's own decrypt is the retry (its  */
/*   error is classified the same way), so a command never makes two failing calls.          */
/* ------------------------------------------------------------------------------------------- */

/** What one decrypt failure says about the key. */
export type ConsoleKeyOutcome = 'missing' | 'usable' | 'refused' | 'unreachable';

/**
 * Classifies a decrypt error from @adonis-agora/crypto (its `CryptoError` / client error carry a
 * `code`; the message is the fallback for other clients). `usable`: the key exists and this app
 * may decrypt with it (only the dummy ciphertext was rejected).
 */
export function classifyConsoleKeyError(error: unknown): ConsoleKeyOutcome {
  const code = (error as { code?: unknown } | null)?.code;
  const text = errorText(error);
  if (code === 'not_found' || /no key named|not[ _]found/i.test(text)) return 'missing';
  if (code === 'invalid' || code === 'unreadable') return 'usable';
  if (
    code === 'forbidden' ||
    code === 'unauthenticated' ||
    /forbid|lacks|capabilit|denied|not allowed|unauthori[sz]ed|unauthenticated|\b40[13]\b/i.test(
      text,
    )
  ) {
    return 'refused';
  }
  if (
    /invalid|unreadable|malformed|ciphertext|unable to authenticate|auth(entication)? tag/i.test(
      text,
    )
  )
    return 'usable';
  return 'unreachable';
}

/** A `forbidden` refusal from crypto (its error code, or the message for other clients). */
export function isForbidden(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'forbidden' || /forbid/i.test(errorText(error));
}

/** The one line to log for `outcome`, or `undefined` when all is well. */
export function consoleKeyNote(
  runtime: Pick<CryptoRuntimeLike, 'partition'>,
  outcome: ConsoleKeyOutcome | 'created',
  key: string = CONSOLE_CRYPTO_KEY,
  detail?: string,
): { level: 'info' | 'warn'; line: string } | undefined {
  const where = `the crypto key "${key}" in partition ${runtime.partition}`;
  const create = `\`node ace crypto:keys:create ${key} --type aes256-gcm --application ${runtime.partition}\``;
  const why = detail ? ` (${detail})` : '';
  switch (outcome) {
    case 'usable':
      return undefined;
    case 'created':
      return { level: 'info', line: `[${PACKAGE}] console commands: created ${where}` };
    case 'missing':
      // Not a problem on a crypto tenant: the crypto server provisions `console-*` keys on the
      // console's first seal. Only a server with sealProvisioning off needs the command.
      return {
        level: 'info',
        line: `[${PACKAGE}] console commands: the crypto key "${key}" does not exist in partition ${runtime.partition} yet; the crypto server creates it on the console's first command (if it has sealProvisioning off: ${create.slice(1, -1)})`,
      };
    case 'refused':
      return {
        level: 'warn',
        line: `[${PACKAGE}] console commands: the crypto server refused this app on ${where}${why}; no grant is needed for an app's own console keys (crypto:decrypt:console-* is harmless if present): check this app's crypto token is valid and the crypto server is up to date`,
      };
    case 'unreachable':
      return {
        level: 'warn',
        line: `[${PACKAGE}] console commands: could not check ${where}${why}; is the crypto server up? Retried on the next command`,
      };
  }
}

/**
 * Checks the console key once (a dummy decrypt) and, when it is missing, tries to create it
 * through the channel crypto already configured (works with `crypto:keys:manage:console-*`).
 * Never throws: returns the line to log, or `undefined` when the key is there and usable.
 */
export async function checkTenantConsoleKey(
  runtime: CryptoRuntimeLike,
  key: string = CONSOLE_CRYPTO_KEY,
): Promise<{ level: 'info' | 'warn'; line: string } | undefined> {
  let outcome: ConsoleKeyOutcome;
  let detail: string | undefined;
  const hasKey = runtime.operations.hasKey;
  if (typeof hasKey === 'function') {
    // Newer crypto servers answer this directly: no decrypt, no error row in the audit. A
    // `forbidden` refusal is the "no permission" outcome; any other throw (an older server
    // without the route) falls back to the decrypt probe below.
    try {
      if (await hasKey.call(runtime.operations, { key })) return undefined;
      return createMissing(runtime, key);
    } catch (error) {
      if (isForbidden(error)) return consoleKeyNote(runtime, 'refused', key, errorText(error));
    }
  }
  try {
    await runtime.operations.decrypt({
      key,
      ciphertext: `agora:ct1:${key}:1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      aad: 'agora:console-key-check',
    });
    return undefined; // a dummy that decrypts: cannot happen, but the key is clearly there
  } catch (error) {
    outcome = classifyConsoleKeyError(error);
    detail = errorText(error);
  }
  if (outcome !== 'missing') return consoleKeyNote(runtime, outcome, key, detail);
  return createMissing(runtime, key);
}

/** The key is missing: create it when this app may (servers with provisioning off), else say so. */
async function createMissing(
  runtime: CryptoRuntimeLike,
  key: string,
): Promise<{ level: 'info' | 'warn'; line: string } | undefined> {
  try {
    if (typeof runtime.operations.createKey !== 'function') throw new Error('no createKey');
    await runtime.operations.createKey({
      name: key,
      type: 'aes256-gcm',
      description: `${PACKAGE}: seals the federated console's commands to this app`,
    });
    return consoleKeyNote(runtime, 'created', key);
  } catch {
    return consoleKeyNote(runtime, 'missing', key);
  }
}

/**
 * The tenant's console key, watched: `atBoot()` runs {@link checkTenantConsoleKey} once;
 * `decrypt` wraps the app's own decrypt so that, while the last check warned, a command's failure
 * is classified and logged (one line, only when it changes) and its success clears the warning.
 * No extra crypto call per command.
 */
export function watchTenantConsoleKey(
  runtime: CryptoRuntimeLike,
  log: (note: { level: 'info' | 'warn'; line: string }) => void,
  key: string = CONSOLE_CRYPTO_KEY,
): { atBoot(): Promise<void>; decrypt: CryptoOperationsLike['decrypt'] } {
  let last: string | undefined;
  let healthy = false;
  const report = (note: { level: 'info' | 'warn'; line: string } | undefined) => {
    healthy = note === undefined || note.level === 'info';
    if (note && note.line !== last) log(note);
    last = note?.line;
  };
  const boot = once(async () => report(await checkTenantConsoleKey(runtime, key)));
  return {
    atBoot: () => boot().catch(() => undefined),
    decrypt: async (input) => {
      try {
        const result = await runtime.operations.decrypt(input);
        if (!healthy && input.key === key) report(undefined);
        return result;
      } catch (error) {
        if (input.key === key) {
          const outcome = classifyConsoleKeyError(error);
          // A command's ciphertext rejected for itself (tampered) says nothing about the key.
          if (outcome !== 'usable') report(consoleKeyNote(runtime, outcome, key, errorText(error)));
        }
        throw error;
      }
    },
  };
}

/** Runs `ensure` once; a failure (crypto's database down at boot) is retried by the next call. */
function once(ensure: () => Promise<unknown>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= ensure().then(
      () => undefined,
      (error: unknown) => {
        pending = undefined;
        throw error;
      },
    );
    return pending;
  };
}

/** What this lib reads of authkit-client's calls between apps (`'authkit.client'`). */
export interface AuthkitClientLike {
  appCallTokens?():
    | { token(app: string): Promise<string>; reset?(app?: string): void }
    | undefined
    | null;
  appCallerVerifier?():
    | {
        verifyToken(token: string): Promise<{
          app: string;
          capabilities: string[];
          clientId: string;
          expiresAt?: number;
        } | null>;
      }
    | null
    | undefined;
  /** authkit's key directory: publish this app's public key (background, retried; never rejects). */
  publishAppKey?(input: { purpose: string; jwk: OkpJwkLike }): Promise<void>;
  /** authkit's key directory: another app's public key for `purpose` (cached), or `null`. */
  appKey?(input: { app: string; purpose: string }): Promise<OkpJwkLike | null>;
}

/** A public OKP JWK as authkit's key directory holds it. */
export interface OkpJwkLike {
  kty: string;
  crv: string;
  x: string;
  kid?: string;
  [extra: string]: unknown;
}

/** The key directory purpose of the agent's console-command public key. */
export const CONSOLE_KEY_PURPOSE = 'console:agent';

/** Whether authkit-client's key directory is there to read other apps' keys from. */
export function hasKeyDirectory(authkit: AuthkitClientLike | undefined): boolean {
  return typeof authkit?.appKey === 'function';
}

/** authkit-client, when it is booted in this app. */
export async function authkitClientOf(container: {
  hasBinding(binding: never): boolean;
  make(binding: never): Promise<unknown>;
}): Promise<AuthkitClientLike | undefined> {
  if (!container.hasBinding('authkit.client' as never)) return undefined;
  const client = (await container.make('authkit.client' as never)) as AuthkitClientLike | null;
  return client && typeof client === 'object' ? client : undefined;
}

/** The console side's token for `app` from authkit's calls between apps, when configured. */
export function appCallToken(
  authkit: AuthkitClientLike | undefined,
  app: string,
): TenantToken | undefined {
  let tokens: ReturnType<NonNullable<AuthkitClientLike['appCallTokens']>>;
  try {
    tokens = authkit?.appCallTokens?.();
  } catch {
    return undefined;
  }
  if (!tokens || typeof tokens.token !== 'function') return undefined;
  const source = tokens;
  return {
    get: async () => {
      try {
        return await source.token(app);
      } catch (error) {
        // The raw reason (for the crypto-only warning), and the fix (for a required token).
        const reason = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: unknown } | null)?.code;
        throw Object.assign(
          new Error(
            `${reason}. To attach it: grant the console's service client agent:console:* on "${app}" in authkit.`,
          ),
          { reason, ...(code !== undefined ? { code } : {}) },
        );
      }
    },
    ...(typeof source.reset === 'function' ? { reset: () => source.reset?.(app) } : {}),
  };
}

/**
 * The app side's verifier for authkit app-call tokens, when configured: the audience binds the
 * token to this app, so the result is `audienceBound` and its partition is the calling app.
 */
export function appCallVerifier(
  authkit: AuthkitClientLike | undefined,
): TenantVerifier | undefined {
  let verifier: ReturnType<NonNullable<AuthkitClientLike['appCallerVerifier']>>;
  try {
    verifier = authkit?.appCallerVerifier?.();
  } catch {
    return undefined;
  }
  if (!verifier || typeof verifier.verifyToken !== 'function') return undefined;
  const source = verifier;
  return async (request) => {
    if (typeof request.token !== 'string' || request.token === '') return null;
    const caller = await source.verifyToken(request.token);
    if (!caller) return null;
    return {
      partition: caller.app,
      capabilities: Array.isArray(caller.capabilities) ? caller.capabilities : [],
      clientId: caller.clientId,
      label: caller.app,
      audienceBound: true,
      ...(typeof caller.expiresAt === 'number' ? { expiresAt: caller.expiresAt } : {}),
    };
  };
}

/**
 * §13f: whether crypto says `key` exists in this app's partition, or `undefined` when it cannot
 * say and the caller falls back to the decrypt probe (no `hasKey`, or an older crypto server
 * without the route). A refusal (`forbidden`) is thrown as is: it is the "no permission" outcome.
 */
export async function hasKeyOrUnknown(
  runtime: CryptoRuntimeLike,
  key: string,
): Promise<boolean | undefined> {
  if (typeof runtime.operations.hasKey !== 'function') return undefined;
  try {
    return await runtime.operations.hasKey({ key });
  } catch (error) {
    if (isForbidden(error)) throw error;
    return undefined;
  }
}
