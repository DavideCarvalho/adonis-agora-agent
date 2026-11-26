import type { OkpJwk } from '../crypto-kit/index.js';
import type { AgentConsoleCommandsConfig } from '../define_config.js';
import {
  type AuthkitClientLike,
  appCallToken,
  appCallVerifier,
  CONSOLE_KEY_PURPOSE,
  type CryptoRuntimeLike,
  consoleEncryptCipher,
  consoleSealCipher,
  ensureConsoleCryptoKey,
  watchTenantConsoleKey,
} from './auto_crypto.js';
import type { FederatedConsoleApp, FederatedControlPlane } from './console.js';
import {
  CONSOLE_CRYPTO_KEY,
  type ConsoleCryptoOptions,
  RedisConsoleChannel,
} from './redis_channel.js';
import type { TenantTokenSource, TenantVerifierInput } from './tenant_auth.js';

/**
 * How each side of the federated console authenticates, resolved from configuration and from the
 * sibling libs booted in the app (`@adonis-agora/crypto` as `'agora.crypto'`, authkit-client as
 * `'authkit.client'`). Pure: the provider applies the result (creates the crypto key, opens the
 * channel, fails the boot), the doctor reports it.
 *
 * Explicit options win: any of `secret`, `crypto`, `verifyTenant` (app) / `secret`, `crypto`,
 * `token` (console) is used as given and nothing automatic is added. `crypto: false`,
 * `verifyTenant: false` and `token: false` turn one automatic piece off.
 */

const PACKAGE = '@adonis-agora/agent';

/** The siblings found in the app. */
export interface ConsoleAuthEnv {
  crypto?: CryptoRuntimeLike | undefined;
  authkit?: AuthkitClientLike | undefined;
  /** Where the console side warns that a command went without its optional token (§13b). */
  warn?: ((line: string) => void) | undefined;
  /** The same, at `info`: when the reason is only a missing grant (§13b). */
  info?: ((line: string) => void) | undefined;
}

/** What the app side (`consoleCommands`) resolved. */
export interface AppConsoleAuth {
  /** One line per accepted mode, e.g. `crypto (auto, key console-agent)`. Empty: unauthenticated. */
  modes: string[];
  /** Why an automatic mode did not apply (for the boot error), when none resolved. */
  notes?: string[];
  secret?: AgentConsoleCommandsConfig['secret'];
  crypto?: ConsoleCryptoOptions;
  verifyTenant?: TenantVerifierInput;
  /** Token mode without crypto: commands arrive sealed to the APP_KEY-derived key pair. */
  sealedToAppKey: boolean;
  /** Crypto mode with a fallback verifier: a command without a token is accepted. */
  tokenOptional?: boolean;
  /** Explicit `crypto` + explicit `verifyTenant`: every crypto command must carry a token. */
  tokenRequired?: boolean;
  /** Automatic crypto mode: the key, in this app's crypto partition. */
  auto?: { key: string; partition: string; embedded: boolean } | undefined;
  /**
   * Automatic crypto mode on a crypto tenant, with `logKey`: checks the key once (call it when the
   * channel starts); later commands' decrypts are the retry ({@link watchTenantConsoleKey}).
   */
  checkKey?: (() => Promise<void>) | undefined;
}

/**
 * The label of a key read from authkit's directory: it is fetched on the first command (never at
 * boot, so a console does not depend on authkit, or on the app having booted first).
 */
export const DIRECTORY_KEY_LABEL = 'sealed to the key the app publishes';

/** Where the federated console's authentication is documented. */
export const CONSOLE_AUTH_DOCS =
  'https://davidecarvalho.github.io/agora/docs/agent/governance/federated-console#authenticating-the-console';

/** A side of the federated console that cannot authenticate: thrown at boot (web processes). */
export class ConsoleAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsoleAuthConfigError';
  }
}

/** The boot error of an app side that resolves no mode (the same wording in every Agora lib). */
export function appUnauthenticatedMessage(notes: readonly string[] = []): string {
  return `[${PACKAGE}] consoleCommands needs authentication: install and boot @adonis-agora/crypto in this app (automatic, key ${CONSOLE_CRYPTO_KEY}), or configure authkit-client's \`service\` (automatic: the console uses an authkit app-call token; grant it agent:console:* on this app), or set consoleCommands.secret (shared with the console), or consoleCommands.verifyTenant (your own verifier; needs an APP_KEY). Run \`node ace agora:doctor\` to see every Agora lib's console auth at once. Docs: ${CONSOLE_AUTH_DOCS}${notesOf(notes)}`;
}

/** What an automatic mode would have given, and why it did not: appended to a boot error. */
const notesOf = (notes: readonly string[]) => (notes.length ? ` Note: ${notes.join('; ')}.` : '');

/** The app side's boot log line: its modes, then whether it takes actions. */
export function appConsoleModesLine(modes: readonly string[], actions: boolean): string {
  return `[${PACKAGE}] console commands: ${modes.join(' + ')}; ${actions ? 'actions on' : 'actions off (set consoleCommands.actions to let the console act)'}`;
}

/**
 * The app side's modes. Tokens: an explicit `verifyTenant` only; else (unless `verifyTenant: false`)
 * authkit's app-call verifier. Explicit `crypto` / `secret` never suppress that fallback. Crypto:
 * explicit `crypto` as given; automatic crypto only when nothing is explicit. A crypto command must
 * carry a token only with explicit `crypto` + explicit `verifyTenant`; with a fallback verifier a
 * token is checked when sent. Token mode (sealed to the APP_KEY-derived key) is available, beside
 * crypto, whenever there is a verifier and an APP_KEY.
 */
export function resolveAppConsoleAuth(
  options: AgentConsoleCommandsConfig,
  env: ConsoleAuthEnv & {
    hasAppKey: boolean;
    /** The short id of the APP_KEY-derived public key (token mode's label); never its material. */
    appKeyId?: string | undefined;
    /** Where the tenant key check logs (automatic crypto on a crypto tenant). */
    logKey?: ((note: { level: 'info' | 'warn'; line: string }) => void) | undefined;
  },
): AppConsoleAuth {
  const explicitCrypto = options.crypto === false ? undefined : options.crypto;
  const explicitVerifier = options.verifyTenant === false ? undefined : options.verifyTenant;
  const explicit =
    options.secret !== undefined || explicitCrypto !== undefined || explicitVerifier !== undefined;
  const modes: string[] = [];

  const fallback =
    explicitVerifier === undefined && options.verifyTenant !== false
      ? appCallVerifier(env.authkit)
      : undefined;
  const verifier: TenantVerifierInput | undefined = explicitVerifier ?? fallback;
  const tokenSource =
    explicitVerifier !== undefined
      ? 'verifyTenant'
      : fallback !== undefined
        ? 'authkit app-call, auto'
        : '';

  let crypto: ConsoleCryptoOptions | undefined;
  let auto: AppConsoleAuth['auto'];
  let checkKey: AppConsoleAuth['checkKey'];
  if (explicitCrypto !== undefined) {
    crypto = explicitCrypto;
  } else if (!explicit && options.crypto !== false && env.crypto !== undefined) {
    const runtime = env.crypto;
    const service = runtime.service;
    if (service !== undefined) {
      // Crypto embedded here: the key is created in this app's partition before the first use, and
      // a failure (crypto's database down at boot) is retried by the next command.
      const ready = retryOnFailure(() =>
        ensureConsoleCryptoKey(service, runtime.partition, CONSOLE_CRYPTO_KEY),
      );
      crypto = {
        cipher: async () => {
          await ready();
          return runtime.operations;
        },
        key: CONSOLE_CRYPTO_KEY,
      };
      checkKey = () =>
        ready().catch((error: unknown) =>
          env.logKey?.({
            level: 'warn',
            line: `[@adonis-agora/agent] console commands: could not create the crypto key "${CONSOLE_CRYPTO_KEY}" in partition ${runtime.partition} (${error instanceof Error ? error.message : String(error)}); retried on the next command`,
          }),
        );
    } else {
      const watch =
        env.logKey !== undefined ? watchTenantConsoleKey(runtime, env.logKey) : undefined;
      crypto = {
        cipher:
          watch !== undefined
            ? { encrypt: (input) => runtime.operations.encrypt(input), decrypt: watch.decrypt }
            : runtime.operations,
        key: CONSOLE_CRYPTO_KEY,
      };
      checkKey = watch?.atBoot;
    }
    auto = {
      key: CONSOLE_CRYPTO_KEY,
      partition: env.crypto.partition,
      embedded: env.crypto.service !== undefined,
    };
  }
  const tokenRequired = explicitCrypto !== undefined && explicitVerifier !== undefined;
  if (crypto !== undefined) {
    modes.push(
      `crypto (${auto !== undefined ? 'auto, ' : ''}key ${crypto.key ?? CONSOLE_CRYPTO_KEY})`,
    );
    if (verifier !== undefined) {
      modes.push(
        tokenRequired
          ? `token required (${tokenSource})`
          : `token checked when sent (${tokenSource})`,
      );
    }
  }
  const sealedToAppKey = verifier !== undefined && env.hasAppKey;
  if (sealedToAppKey) {
    modes.push(`token (${tokenSource}; sealed to ${env.appKeyId ?? 'key (derived from APP_KEY)'})`);
  }
  if (options.secret !== undefined) modes.push('secret');
  const notes =
    modes.length > 0
      ? []
      : [
          ...(verifier !== undefined && !env.hasAppKey
            ? [
                `a token verifier is available (${tokenSource}), but token mode needs an APP_KEY (commands are sealed to a key derived from it)`,
              ]
            : []),
          ...(options.crypto === false
            ? ['`crypto: false` turned the automatic crypto mode off']
            : []),
        ];

  return {
    modes,
    ...(notes.length > 0 ? { notes } : {}),
    ...(options.secret !== undefined ? { secret: options.secret } : {}),
    ...(crypto !== undefined ? { crypto } : {}),
    ...(verifier !== undefined && (crypto !== undefined || sealedToAppKey)
      ? { verifyTenant: verifier }
      : {}),
    ...(crypto !== undefined && verifier !== undefined && !tokenRequired
      ? { tokenOptional: true }
      : {}),
    ...(crypto !== undefined && verifier !== undefined && tokenRequired
      ? { tokenRequired: true }
      : {}),
    sealedToAppKey,
    ...(auto !== undefined ? { auto } : {}),
    ...(checkKey !== undefined ? { checkKey } : {}),
  };
}

/** What the console side resolved for one `dashboard.apps` entry. */
export interface FederatedAppAuth {
  /** `false`: browse-only (`actions: false`), no command is sent. */
  actions: boolean;
  /** One line per sending mode. Empty with `actions` on: unauthenticated (a boot error). */
  modes: string[];
  /** Why an automatic mode did not apply (for the boot error), when none resolved. */
  notes?: string[];
  /** The entry with what was resolved automatically filled in (unchanged otherwise). */
  entry: FederatedConsoleApp;
  /** Automatic crypto mode with crypto embedded in this app: the key to ensure in `partition`. */
  ensureKey?: { key: string; partition: string } | undefined;
}

/** The boot error of a console entry that resolves no mode while it may take actions. */
export function consoleUnauthenticatedMessage(key: string, notes: readonly string[] = []): string {
  const entry = `dashboard.apps["${key}"]`;
  return `[${PACKAGE}] ${entry}: commands to this app need authentication: boot @adonis-agora/crypto in this app (automatic), or set ${entry}.controlPlane.secret, or ${entry}.controlPlane.token — or actions: false to only browse it. Run \`node ace agora:doctor\` to see every Agora lib's console auth at once.${notesOf(notes)}`;
}

/** The console side's mode for one other app (see the module comment for what wins). */
export function resolveFederatedAppAuth(
  key: string,
  entry: FederatedConsoleApp,
  env: ConsoleAuthEnv,
): FederatedAppAuth {
  if (entry.actions === false) return { actions: false, modes: [], entry };
  const plane = entry.controlPlane;
  if (plane === undefined) return { actions: true, modes: [], entry };
  if (plane instanceof RedisConsoleChannel) {
    return { actions: true, modes: plane.signed ? ['a channel of your own'] : [], entry };
  }
  const explicitCrypto = plane.crypto === false ? undefined : plane.crypto;
  const explicitToken = plane.token === false ? undefined : plane.token;
  // authkit's key directory: the key that app publishes, when no `publicKey` is configured.
  const directory = directoryKey(env.authkit, entry.partition ?? key);
  if (plane.secret !== undefined || explicitCrypto !== undefined || explicitToken !== undefined) {
    // The automatic authkit token joins an explicit `crypto` (no explicit token, no `secret`,
    // `token` not `false`): the app checks it when sent, and it caps the command.
    const autoToken =
      explicitCrypto !== undefined &&
      explicitToken === undefined &&
      plane.secret === undefined &&
      plane.token !== false
        ? appCallToken(env.authkit, entry.partition ?? key)
        : undefined;
    const modes: string[] = [];
    if (explicitCrypto !== undefined) {
      modes.push(`crypto (key ${explicitCrypto.key ?? CONSOLE_CRYPTO_KEY})`);
      if (explicitToken !== undefined) modes.push('token (controlPlane.token)');
      else if (autoToken !== undefined) modes.push('token (authkit app-call, auto)');
    } else if (explicitToken !== undefined && plane.publicKey !== undefined) {
      modes.push(`token (controlPlane.token; sealed to ${publicKeyId(plane.publicKey)})`);
    } else if (explicitToken !== undefined && directory !== undefined) {
      modes.push(`token (controlPlane.token, authkit key directory; ${DIRECTORY_KEY_LABEL})`);
    }
    if (plane.secret !== undefined) modes.push('secret');
    const viaDirectory =
      explicitCrypto === undefined &&
      explicitToken !== undefined &&
      plane.publicKey === undefined &&
      directory !== undefined;
    return {
      actions: true,
      modes,
      entry:
        autoToken !== undefined || viaDirectory
          ? {
              ...entry,
              controlPlane: {
                ...plane,
                ...(autoToken !== undefined
                  ? {
                      token: autoToken,
                      onTokenSkipped: tokenSkipped(env, key, entry.partition ?? key),
                    }
                  : {}),
                ...(viaDirectory ? { publicKey: directory } : {}),
              },
            }
          : entry,
    };
  }

  const partition = entry.partition ?? key;
  const runtime = plane.crypto === false ? undefined : env.crypto;
  let crypto: ConsoleCryptoOptions | undefined;
  let ensureKey: FederatedAppAuth['ensureKey'];
  if (runtime?.service !== undefined) {
    crypto = {
      cipher: consoleEncryptCipher(runtime.service, partition, CONSOLE_CRYPTO_KEY),
      key: CONSOLE_CRYPTO_KEY,
    };
    ensureKey = { key: CONSOLE_CRYPTO_KEY, partition };
  } else if (runtime?.topology === 'tenant') {
    crypto = {
      cipher: consoleSealCipher(runtime.operations, partition, CONSOLE_CRYPTO_KEY),
      key: CONSOLE_CRYPTO_KEY,
    };
  }
  const tokenSource = plane.token === false ? undefined : appCallToken(env.authkit, partition);
  const token: TenantTokenSource | undefined = tokenSource;
  // Without crypto, a token still travels sealed: to the app's key, from this console's config.
  const sealable = crypto !== undefined || plane.publicKey !== undefined || directory !== undefined;
  if (crypto === undefined && (token === undefined || !sealable)) {
    const notes = [
      ...(plane.crypto === false ? ['`crypto: false` turned the automatic crypto mode off'] : []),
      ...(plane.token === false ? ['`token: false` turned the automatic authkit token off'] : []),
      ...(token !== undefined && !sealable
        ? [
            "an authkit app-call token is available, but without crypto it travels sealed to that app's key: set controlPlane.publicKey (`node ace agent:console-key` on that app prints it), or update authkit-client so its key directory serves it",
          ]
        : []),
    ];
    return { actions: true, modes: [], entry, ...(notes.length > 0 ? { notes } : {}) };
  }
  // §13a: crypto and the directory both reach that app; each command picks (cached 5 minutes).
  const choose =
    crypto !== undefined &&
    token !== undefined &&
    directory !== undefined &&
    plane.publicKey === undefined &&
    typeof env.authkit?.appKey === 'function';
  const cryptoLabel = `crypto (auto, key ${CONSOLE_CRYPTO_KEY}, partition ${partition})`;
  const modes = choose
    ? [`auto (authkit key directory if the app publishes one, else ${cryptoLabel})`]
    : crypto !== undefined
      ? [cryptoLabel, ...(token !== undefined ? ['token (authkit app-call, auto)'] : [])]
      : [
          plane.publicKey !== undefined
            ? `token (authkit app-call, auto; sealed to ${publicKeyId(plane.publicKey)})`
            : `token (authkit app-call, auto, authkit key directory; ${DIRECTORY_KEY_LABEL})`,
        ];
  const resolved: FederatedControlPlane = {
    ...plane,
    ...((crypto === undefined || choose) && plane.publicKey === undefined && directory !== undefined
      ? { publicKey: directory }
      : {}),
    ...(crypto !== undefined ? { crypto } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(crypto !== undefined && token !== undefined
      ? { onTokenSkipped: tokenSkipped(env, key, partition) }
      : {}),
    ...(choose
      ? { autoMode: { hasDirectoryKey: () => directoryHas(env.authkit, partition) } }
      : {}),
  };
  return {
    actions: true,
    modes,
    entry: { ...entry, controlPlane: resolved },
    ...(ensureKey !== undefined ? { ensureKey } : {}),
  };
}

/** Runs `work` once; a failure is retried by the next call (never two calls for one command). */
function retryOnFailure(work: () => Promise<unknown>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= work().then(
      () => undefined,
      (error: unknown) => {
        pending = undefined;
        throw error;
      },
    );
    return pending;
  };
}

/** A configured app public key's short id (its `kid`, cut), for logs: never the key material. */
function publicKeyId(value: unknown): string {
  try {
    const jwk = (typeof value === 'string' ? JSON.parse(value) : value) as { kid?: unknown };
    return typeof jwk?.kid === 'string' && jwk.kid !== ''
      ? `key ${jwk.kid.slice(0, 8)}`
      : 'the app key';
  } catch {
    return 'the app key';
  }
}

/**
 * The recipient key of `app` from authkit's key directory (`appKey`), when authkit-client has one:
 * the APP_KEY-derived public key that app published under `console:agent`. `null` from the
 * directory is an actionable error (thrown on the command, answered `503` naming the app).
 */
function directoryKey(
  authkit: AuthkitClientLike | undefined,
  app: string,
): (() => Promise<OkpJwk>) | undefined {
  const lookup = authkit?.appKey;
  if (typeof lookup !== 'function') return undefined;
  return async () => {
    const jwk = await lookup.call(authkit, { app, purpose: CONSOLE_KEY_PURPOSE });
    if (!jwk) {
      throw new Error(
        `"${app}" has no console key in authkit's key directory: set its controlPlane.publicKey (\`node ace agent:console-key\` on that app prints it); that app publishes it automatically when it has authkit-client's \`service\` configured and token mode on`,
      );
    }
    return jwk as unknown as OkpJwk;
  };
}

/**
 * Whether a failed mint means only that the console's client is not granted that app (§13b, the
 * same rule in every lib): the code `invalid_target`, or a message mentioning `invalid_target`,
 * "not granted" or "no grant" (any case). Anything else (`unauthorized_client`, `invalid_client`,
 * authkit unreachable) is not.
 */
export function isMissingGrant(error: unknown): boolean {
  const value = error as { code?: unknown; reason?: unknown; message?: unknown } | null;
  if (value?.code === 'invalid_target') return true;
  const text = [value?.reason, value?.message, typeof error === 'string' ? error : undefined]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  return /invalid_target|not granted|no grant/i.test(text);
}

/** Whether `app` has a console key in authkit's key directory (a lookup failure: no). */
async function directoryHas(authkit: AuthkitClientLike | undefined, app: string): Promise<boolean> {
  try {
    return (await authkit?.appKey?.({ app, purpose: CONSOLE_KEY_PURPOSE })) != null;
  } catch {
    return false;
  }
}

/**
 * §13b: the warning when a crypto-mode command goes without its automatic token (each reason once;
 * the channel itself retries minting after 5 minutes).
 */
function tokenSkipped(
  env: ConsoleAuthEnv,
  key: string,
  app: string,
): (reason: string, error?: unknown) => void {
  const said = new Set<string>();
  return (reason, error) => {
    const line = `[${PACKAGE}] console commands to "${key}": sending without an authkit app-call token (crypto only): ${reason}. To attach it: grant the console's service client agent:console:* on "${app}" in authkit.`;
    if (said.has(line)) return;
    said.add(line);
    // A missing grant is a choice (crypto alone authenticates): info. Anything else: warn.
    if (isMissingGrant(error ?? reason)) (env.info ?? env.warn)?.(line);
    else env.warn?.(line);
  };
}
