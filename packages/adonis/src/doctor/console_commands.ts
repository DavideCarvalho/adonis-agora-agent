import type { ApplicationService } from '@adonisjs/core/types';
import { appKeyOf } from '../app_key_of.js';
import { resolveDashboardConfig } from '../dashboard/define_config.js';
import type { AgentConsoleCommandsConfig } from '../define_config.js';
import {
  authkitClientOf,
  type ConsoleKeyOutcome,
  type CryptoRuntimeLike,
  classifyConsoleKeyError,
  consoleKeyNote,
  cryptoRuntimeOf,
  hasKeyOrUnknown,
} from '../federation/auto_crypto.js';
import { consoleCommandKeys, type FederatedConsoleApp } from '../federation/console.js';
import {
  appConsoleModesLine,
  appUnauthenticatedMessage,
  type ConsoleAuthEnv,
  consoleUnauthenticatedMessage,
  resolveAppConsoleAuth,
  resolveFederatedAppAuth,
} from '../federation/console_auth.js';
import type { ConsoleCipher, ConsoleCipherSource } from '../federation/redis_channel.js';
import type { AgoraDoctorResult } from './agora_doctor.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/agent/governance/federated-console';

/** What `agent.console-commands` reads: the config and the siblings found in the app. */
export interface ConsoleCommandsInput {
  consoleCommands?: AgentConsoleCommandsConfig | undefined;
  apps: Record<string, FederatedConsoleApp>;
  env: ConsoleAuthEnv;
  hasAppKey: boolean;
  /** The APP_KEY-derived public key's short id, for the token label (the boot log's). */
  appKeyId?: string | undefined;
  /**
   * The deep check: report only the sides in crypto mode, each with a probe of the key (it exists,
   * and this process can encrypt and decrypt with it). Otherwise: every side's mode, no probe.
   */
  deep: boolean;
}

async function cipherOf(source: ConsoleCipherSource): Promise<ConsoleCipher> {
  return typeof source === 'function' ? await source() : source;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Encrypt then decrypt a probe with `cipher`/`key`; the error text, or `undefined` when it round-trips. */
async function roundTrip(cipher: ConsoleCipher, key: string): Promise<string | undefined> {
  const aad = 'agora:doctor:console-commands';
  try {
    const { ciphertext } = await cipher.encrypt({
      key,
      plaintext: 'probe',
      aad,
      context: 'doctor',
    });
    const { plaintext } = await cipher.decrypt({ key, ciphertext, aad, context: 'doctor' });
    return plaintext === 'probe' ? undefined : 'the probe did not decrypt to itself';
  } catch (error) {
    // A decrypt-only grant cannot encrypt the probe: that refusal is expected, not a problem.
    return classifyConsoleKeyError(error) === 'refused' ? undefined : errorText(error);
  }
}

/** The boot check's decrypt probe, classified the same way (never creates the key). */
async function probeTenantKey(runtime: CryptoRuntimeLike, key: string): Promise<ConsoleKeyOutcome> {
  try {
    const exists = await hasKeyOrUnknown(runtime, key);
    if (exists !== undefined) return exists ? 'usable' : 'missing';
    await runtime.operations.decrypt({
      key,
      ciphertext: `agora:ct1:${key}:1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      aad: 'agora:console-key-check',
    });
    return 'usable';
  } catch (error) {
    return classifyConsoleKeyError(error);
  }
}

/** The crypto runtime's service as a full cipher in `partition` (doctor only: encrypt and decrypt). */
function serviceCipher(runtime: CryptoRuntimeLike, partition: string, key: string): ConsoleCipher {
  const service = runtime.service!;
  const principal = {
    partition,
    capabilities: [`crypto:encrypt:${key}`, `crypto:decrypt:${key}`],
    actor: 'agent:doctor',
  };
  return {
    encrypt: (input) => service.encrypt(principal, input),
    decrypt: (input) => service.decrypt(principal, input),
  };
}

/**
 * `agent.console-commands`: how each side of the federated console authenticates. Error when a
 * side would take actions unauthenticated (the web process refuses to start then); with `deep`, the
 * crypto key is probed (it exists, and this process can use it).
 */
export async function checkConsoleCommands(
  input: ConsoleCommandsInput,
): Promise<AgoraDoctorResult[]> {
  const results: AgoraDoctorResult[] = [];
  const options = input.consoleCommands;
  if (options !== undefined) {
    const auth = resolveAppConsoleAuth(options, {
      ...input.env,
      hasAppKey: input.hasAppKey,
      ...(input.appKeyId !== undefined ? { appKeyId: input.appKeyId } : {}),
    });
    if (auth.modes.length === 0) {
      if (!input.deep)
        results.push({
          status: 'error',
          message: `consoleCommands ("${options.prefix}") resolves no authentication; the web process will not start.`,
          fix: appUnauthenticatedMessage(auth.notes).replace(/^\[[^\]]+\] /, ''),
          docs: `${DOCS}#authenticating-the-console`,
        });
    } else if (!input.deep || auth.crypto !== undefined) {
      let status: AgoraDoctorResult['status'] = 'ok';
      let detail = '';
      if (input.deep && auth.crypto !== undefined) {
        const key = auth.crypto.key ?? 'console-agent';
        const runtime = input.env.crypto;
        const embedded = auth.auto?.embedded === true && runtime?.service !== undefined;
        let problem: string | undefined;
        let note: string | undefined;
        if (embedded) {
          const record = await runtime
            .service!.store.getKey(runtime.partition, key)
            .catch(() => null);
          problem =
            record === null || record === undefined
              ? `the key "${runtime.partition}/${key}" does not exist yet (it is created when the web process starts)`
              : await roundTrip(serviceCipher(runtime, runtime.partition, key), key);
        } else if (runtime !== undefined && auth.auto !== undefined) {
          // A crypto tenant: the same decrypt probe and classifier as the boot check (a
          // decrypt-only grant is enough, and is all such an app usually holds).
          const outcome = await probeTenantKey(runtime, key);
          if (outcome === 'missing') {
            // Expected on a crypto tenant: the server provisions it on the console's first seal.
            note = ` ${consoleKeyNote(runtime, outcome, key)?.line.replace(/^\[[^\]]+\] /, '') ?? ''}`;
          } else if (outcome !== 'usable') {
            problem = consoleKeyNote(runtime, outcome, key)?.line ?? outcome;
          }
        } else {
          problem = await roundTrip(await cipherOf(auth.crypto.cipher), key).catch(errorText);
        }
        if (problem !== undefined) {
          status = 'warn';
          detail = ` The crypto probe on "${key}" failed: ${problem}.`;
        } else {
          detail = note ?? ` The key "${key}" is usable here.`;
        }
      }
      results.push({
        status,
        // The boot log's sentence, as the web process prints it (and, for information, why the
        // token-mode key is not in authkit's directory: crypto reaches this app).
        message: `${appConsoleModesLine(auth.modes, options.actions === true).replace(/^\[[^\]]+\] /, '')}.${detail}${
          auth.sealedToAppKey && auth.crypto !== undefined && auth.tokenRequired !== true
            ? " This app's token key is not published: crypto is enough to reach it."
            : ''
        }`,
        ...(status === 'warn'
          ? {
              fix: 'Check this app reaches its crypto server (an app opens its own console-* keys with no grant), or check `consoleCommands.crypto`.',
            }
          : {}),
        docs: `${DOCS}#authenticating-the-console`,
      });
    }
  }
  for (const [key, entry] of Object.entries(input.apps)) {
    const auth = resolveFederatedAppAuth(key, entry, input.env);
    if (!auth.actions) {
      if (!input.deep) {
        results.push({
          status: 'ok',
          message: `console commands to "${key}": browse-only (actions: false).`,
        });
      }
      continue;
    }
    if (auth.modes.length === 0) {
      if (input.deep) continue;
      results.push({
        status: 'error',
        message: `dashboard.apps["${key}"] cannot authenticate its actions; the web process will not start.`,
        fix: consoleUnauthenticatedMessage(key, auth.notes).replace(/^\[[^\]]+\] [^:]+: /, ''),
        docs: `${DOCS}#authenticating-the-console`,
      });
      continue;
    }
    let status: AgoraDoctorResult['status'] = 'ok';
    let detail = '';
    const runtime = input.env.crypto;
    if (input.deep && (auth.ensureKey === undefined || runtime?.service === undefined)) continue;
    if (input.deep && auth.ensureKey !== undefined && runtime?.service !== undefined) {
      const { key: name, partition } = auth.ensureKey;
      const record = await runtime.service.store.getKey(partition, name).catch(() => null);
      const problem =
        record === null || record === undefined
          ? `the key "${partition}/${name}" does not exist yet (it is created when the web process starts)`
          : await roundTrip(serviceCipher(runtime, partition, name), name);
      if (problem !== undefined) {
        status = 'warn';
        detail = ` The crypto probe failed: ${problem}.`;
      } else {
        detail = ` The key "${partition}/${name}" encrypts and decrypts here.`;
      }
    }
    results.push({
      status,
      message: `console commands to "${key}": ${auth.modes.join(' + ')}.${detail}`,
      docs: `${DOCS}#authenticating-the-console`,
    });
  }
  if (results.length === 0) {
    return [
      {
        status: 'skip',
        message: input.deep
          ? 'No side of the federated console seals with a crypto key this process holds: nothing to probe.'
          : 'No consoleCommands and no dashboard.apps: nothing to check.',
      },
    ];
  }
  return results;
}

/** Reads the app for {@link checkConsoleCommands}. */
export async function consoleCommandsInput(
  app: ApplicationService,
  deep: boolean,
): Promise<ConsoleCommandsInput> {
  const config = app.config.get<Record<string, unknown> | undefined>('agent', undefined) ?? {};
  const released = await appKeyOf(app);
  return {
    consoleCommands: config.consoleCommands as AgentConsoleCommandsConfig | undefined,
    apps: resolveDashboardConfig(config.dashboard as never).apps,
    env: {
      crypto: await cryptoRuntimeOf(app.container as never).catch(() => undefined),
      authkit: await authkitClientOf(app.container as never).catch(() => undefined),
    },
    hasAppKey: typeof released === 'string' && released.length > 0,
    ...(typeof released === 'string' &&
    released.length > 0 &&
    (config.consoleCommands as AgentConsoleCommandsConfig | undefined)?.prefix !== undefined
      ? {
          appKeyId: `key ${consoleCommandKeys(released, (config.consoleCommands as AgentConsoleCommandsConfig).prefix).publicKey.kid.slice(0, 8)}`,
        }
      : {}),
    deep,
  };
}
