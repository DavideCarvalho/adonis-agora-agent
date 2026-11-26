import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { type OkpJwk, openWith, sealTo } from '../crypto-kit/index.js';
import {
  canonicalJson,
  resolveTenantToken,
  resolveTenantVerifier,
  type TenantTokenSource,
  type TenantVerifierInput,
  type VerifiedTenant,
} from './tenant_auth.js';

/**
 * The Redis channel the federated console talks to another app over: the console publishes a
 * command on `<prefix>-agent-console`, every instance of the owning app hears it, the one that wins
 * `SET <prefix>-agent-console-claim:<id> NX PX` runs it, and the answer comes back on
 * `<prefix>-agent-console-reply`. Same design as `@adonis-agora/config`'s and
 * `@adonis-agora/durable`'s console commands, on channels of its own (`-agent-`), so all of them can
 * share an app's prefix. Ported from `@adonis-agora/config`'s channel (only {@link CONSOLE_TOPIC}
 * and the names differ).
 *
 * Redis is not a trust boundary: anyone who can publish there could otherwise approve a pending tool
 * call as any approver or rewrite prices. Every command is authenticated (one of three modes, see
 * {@link RedisConsoleChannel}), refused when older than a minute, claimed once (a replay reuses the
 * id and loses the claim), and every answer is MACed so a forged one is ignored.
 */

/** This package's part of the channel names. */
export const CONSOLE_TOPIC = 'agent';
const PACKAGE = `@adonis-agora/${CONSOLE_TOPIC}`;

/** One command sent to the owning app. Arguments and answer are plain JSON. */
export interface AgentConsoleCommand {
  id: string;
  verb: string;
  args: unknown[];
  /** Who acted in the console, recorded by the owning app as the deciding actor. */
  actor?: string;
  /**
   * What the console's `authorize` granted that viewer. Only narrows: in token mode the token's
   * capabilities cap it, and a command without it is never taken to mean "everything".
   */
  capabilities?: string[];
  /** The console that sent it (its `appLabel`), for the owning app's log. */
  via?: string;
  /** When it was sent (ms since the epoch): a command older than a minute is refused. */
  ts?: number;
  /** Shared-secret mode: HMAC of every field above (set by {@link RedisConsoleChannel}). */
  mac?: string;
  /**
   * Token mode: who the owning app verified the console as (its token's partition and
   * capabilities). Set by the channel after verification, never taken from the wire.
   */
  verified?: Pick<VerifiedTenant, 'partition' | 'capabilities' | 'clientId' | 'audienceBound'>;
}

/** The owning app's answer to a {@link AgentConsoleCommand}. */
export type AgentConsoleReply = (
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { message: string; code?: string; status?: number } }
) & { mac?: string };

/** How far a command's `ts` may be from this clock (and so how long a replay could live). */
const MAX_COMMAND_SKEW_MS = 60_000;

/** A shared secret: a string, or a Secret-like object (`env.get('X')` in AdonisJS). */
export type ChannelSecret = string | { release(): string };

function sameMac(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function fresh(ts: unknown): boolean {
  return typeof ts === 'number' && Math.abs(Date.now() - ts) <= MAX_COMMAND_SKEW_MS;
}

/**
 * Signs and checks the messages of one channel under a secret both sides share: every command and
 * reply carries an HMAC over its fields, bound to this channel's prefix.
 */
class ChannelSigner {
  readonly #key: Buffer;
  constructor(secret: ChannelSecret, prefix: string) {
    const raw = typeof secret === 'string' ? secret : secret?.release?.();
    if (typeof raw !== 'string' || raw.length < 16) {
      throw new Error(
        `[${PACKAGE}] console channel: the shared secret must be at least 16 characters`,
      );
    }
    this.#key = createHmac('sha256', raw)
      .update(`agora:console-commands:${CONSOLE_TOPIC}:${prefix}`)
      .digest();
  }

  #mac(kind: 'command' | 'reply', fields: unknown): string {
    return createHmac('sha256', this.#key)
      .update(`${kind}\n${canonicalJson(fields)}`)
      .digest('base64url');
  }

  #commandFields(command: AgentConsoleCommand) {
    return [
      command.id,
      command.verb,
      command.args ?? [],
      command.actor ?? null,
      command.capabilities ?? null,
      command.via ?? null,
      command.ts ?? null,
    ];
  }

  #replyFields(reply: AgentConsoleReply) {
    return [reply.id, reply.ok, reply.ok ? (reply.data ?? null) : reply.error];
  }

  signCommand(command: AgentConsoleCommand): AgentConsoleCommand {
    const { mac: _mac, verified: _verified, ...rest } = command;
    const stamped = { ...rest, ts: Date.now() };
    return { ...stamped, mac: this.#mac('command', this.#commandFields(stamped)) };
  }

  verifyCommand(command: AgentConsoleCommand): boolean {
    return fresh(command.ts) && this.verifyMac(command);
  }

  verifyMac(command: AgentConsoleCommand): boolean {
    return sameMac(this.#mac('command', this.#commandFields(command)), command.mac);
  }

  signReply(reply: AgentConsoleReply): AgentConsoleReply {
    const { mac: _mac, ...rest } = reply;
    return {
      ...rest,
      mac: this.#mac('reply', this.#replyFields(rest as AgentConsoleReply)),
    } as AgentConsoleReply;
  }

  verifyReply(reply: AgentConsoleReply): boolean {
    return sameMac(this.#mac('reply', this.#replyFields(reply)), reply.mac);
  }
}

/** The owning app refused the console's token (the console drops its cached token). */
export const UNAUTHORIZED_CONSOLE = 'federated-console-unauthorized';

/** What one sent command needs from the channel's authentication. */
interface OutgoingMessage {
  wire: unknown;
  verifyReply(reply: AgentConsoleReply): boolean;
}

/** A command that arrived, once its authentication is checked. */
interface IncomingMessage {
  /** The command to run, or `undefined` when it must be refused with `error`. */
  command?: AgentConsoleCommand;
  error?: { message: string; code: string; status: number };
  id: string;
  signReply(reply: AgentConsoleReply): AgentConsoleReply;
}

interface ChannelAuth {
  wrap?(command: AgentConsoleCommand): Promise<OutgoingMessage>;
  unwrap?(wire: Record<string, unknown>): Promise<IncomingMessage | null>;
  unauthorized?(): void;
}

/** Shared-secret mode: both sides hold the same secret and HMAC every command and reply. */
class SecretAuth implements ChannelAuth {
  readonly #signer: ChannelSigner;
  constructor(secret: ChannelSecret, prefix: string) {
    this.#signer = new ChannelSigner(secret, prefix);
  }

  async wrap(command: AgentConsoleCommand): Promise<OutgoingMessage> {
    return {
      wire: this.#signer.signCommand(command),
      verifyReply: (reply) => this.#signer.verifyReply(reply),
    };
  }

  async unwrap(wire: Record<string, unknown>): Promise<IncomingMessage | null> {
    if (typeof wire.mac !== 'string') return null;
    const command = wire as unknown as AgentConsoleCommand;
    if (typeof command.id !== 'string' || typeof command.verb !== 'string') return null;
    // Tampered or forged: not from the console that holds the secret; stale: over a minute old. A
    // replay inside the window reuses the id, and the claim (kept 2 minutes) refuses it.
    if (!this.#signer.verifyMac(command)) throw refusedCommand('bad signature');
    if (!fresh(command.ts)) throw refusedCommand('stale');
    const { mac: _mac, ts: _ts, verified: _verified, ...fields } = command;
    return {
      id: command.id,
      command: fields,
      signReply: (reply) => this.#signer.signReply(reply),
    };
  }
}

/**
 * How a sealed command is encrypted: to the app's command key derived from its `APP_KEY`, or with
 * a key of `@adonis-agora/crypto` (the Hub's, or the app's own). Either way only the owning app
 * opens it, and the AAD binds it to this channel and this command id.
 */
export interface ConsoleSealer {
  /** Whether `sealed` is this sealer's ciphertext (so the app knows which one opens it). */
  owns(sealed: string): boolean;
  seal(plaintext: string, aad: string): Promise<string>;
  open(sealed: string, aad: string): Promise<string>;
}

/** The `encrypt`/`decrypt` pair `@adonis-agora/crypto` exposes (`crypto.client`, `serviceCipher`). */
export interface ConsoleCipher {
  encrypt(input: {
    key: string;
    plaintext: string;
    aad?: string;
    context?: string;
  }): Promise<{ ciphertext: string }>;
  decrypt(input: {
    key: string;
    ciphertext: string;
    aad?: string;
    context?: string;
  }): Promise<{ plaintext: string }>;
}

/**
 * A cipher, or a function returning one: `config/agent.ts` is read before `@adonis-agora/crypto` is
 * ready, so `() => crypto.client!` (or `() => serviceCipher(crypto.service, 'app')`) defers it to
 * the first command.
 */
export type ConsoleCipherSource = ConsoleCipher | (() => ConsoleCipher | Promise<ConsoleCipher>);

/**
 * The `@adonis-agora/crypto` key console commands are sealed with, unless another is named. Every
 * Agora lib names its key `console-<lib>` (an app opens its own `console-*` keys with no grant).
 */
export const CONSOLE_CRYPTO_KEY = 'console-agent';

/** `crypto` on either side: a cipher, the key (default `console-agent`), and an optional `owns`. */
export interface ConsoleCryptoOptions {
  cipher: ConsoleCipherSource;
  key?: string | undefined;
  /**
   * Whether a ciphertext is this cipher's, so the app knows which mode opens a command. Default: the
   * `@adonis-agora/crypto` format (`agora:ct1:<key>:`). Set it for a cipher of your own (a KMS, Vault
   * transit, an HSM) whose ciphertext looks different.
   */
  owns?: ((ciphertext: string) => boolean) | undefined;
}

/** Seals with an `@adonis-agora/crypto` key: whoever may `encrypt` with it sends, the app opens. */
export function cryptoConsoleSealer(options: ConsoleCryptoOptions): ConsoleSealer {
  const key = options.key ?? CONSOLE_CRYPTO_KEY;
  const source = options.cipher;
  const cipher = async (): Promise<ConsoleCipher> => {
    const resolved = typeof source === 'function' ? await source() : source;
    if (
      !resolved ||
      typeof resolved.encrypt !== 'function' ||
      typeof resolved.decrypt !== 'function'
    ) {
      throw new Error(
        `[${PACKAGE}] console channel: \`crypto.cipher\` is not ready (is @adonis-agora/crypto booted?)`,
      );
    }
    return resolved;
  };
  return {
    // `agora:ct1:<key>:<version>:…`: only this key's ciphertext is taken as a crypto command.
    owns: (sealed) =>
      options.owns !== undefined ? options.owns(sealed) : sealed.startsWith(`agora:ct1:${key}:`),
    async seal(plaintext, aad) {
      const { ciphertext } = await (await cipher()).encrypt({ key, plaintext, aad, context: aad });
      return ciphertext;
    },
    async open(sealed, aad) {
      const { plaintext } = await (await cipher()).decrypt({
        key,
        ciphertext: sealed,
        aad,
        context: aad,
      });
      return plaintext;
    },
  };
}

/** Seals to the app's X25519 command key: the console side (the app's public key, configured). */
export function appKeySealerTo(recipient: OkpJwk | (() => Promise<OkpJwk>)): ConsoleSealer {
  const key = typeof recipient === 'function' ? recipient : async () => recipient;
  return {
    owns: (sealed) => sealed.startsWith('agora:pk1:'),
    seal: async (plaintext, aad) => sealTo(await key(), plaintext, { aad }),
    open: async () => {
      throw new Error('the console side cannot open commands');
    },
  };
}

/** Opens with the app's X25519 command key pair (derived from its `APP_KEY`): the app side. */
export function appKeySealer(keys: { publicKey: OkpJwk; privateKey: OkpJwk }): ConsoleSealer {
  return {
    owns: (sealed) => sealed.startsWith('agora:pk1:'),
    seal: async (plaintext, aad) => sealTo(keys.publicKey, plaintext, { aad }),
    open: async (sealed, aad) => openWith(keys.privateKey, sealed, { aad }),
  };
}

/** The key that MACs the replies to one command: a secret only the console and the app know. */
function replyKey(secret: string, prefix: string, id: string): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(`agora:console-reply:${CONSOLE_TOPIC}:${prefix}:${id}`)
    .digest();
}

function replyMac(key: Buffer, reply: AgentConsoleReply): string {
  const fields = [reply.id, reply.ok, reply.ok ? (reply.data ?? null) : reply.error];
  return createHmac('sha256', key)
    .update(`reply\n${canonicalJson(fields)}`)
    .digest('base64url');
}

const commandAad = (prefix: string, id: string) =>
  JSON.stringify(['agora:console-command', CONSOLE_TOPIC, prefix, id]);

/**
 * Sealed mode (console side): the whole command, with the console's token when it has one, travels
 * sealed so only the owning app opens it. A Redis reader sees an id and ciphertext: no token to
 * lift and replay, no command to alter. The sealed payload also carries a one-off secret the app
 * MACs its answer with, so a forged answer (from someone who cannot open the command) is ignored.
 */
class SealedSenderAuth implements ChannelAuth {
  readonly #token: ReturnType<typeof resolveTenantToken> | undefined;
  /** Crypto mode with an automatic token: until when a failed mint is not retried. */
  #skipTokenUntil = 0;
  constructor(
    readonly sealer: ConsoleSealer,
    token: TenantTokenSource | undefined,
    readonly prefix: string,
    /** The token is optional (crypto mode): a failed mint sends without it, retried in 5 min. */
    readonly onTokenSkipped?: ((reason: string, error?: unknown) => void) | undefined,
  ) {
    this.#token = token === undefined ? undefined : resolveTenantToken(token);
  }

  /**
   * The token for this command. Optional (crypto mode, §13b): a token that fails to mint is left
   * out, said (the callback dedupes per reason), and asked for again after 5 minutes. Required
   * (token mode): its error stands, coded {@link TOKEN_UNAVAILABLE} so a console that can also
   * reach the app by crypto falls back (§13a).
   */
  async #tokenFor(): Promise<string | undefined> {
    if (!this.#token) return undefined;
    const optional = this.onTokenSkipped !== undefined;
    if (optional && Date.now() < this.#skipTokenUntil) return undefined;
    try {
      return await this.#token.get();
    } catch (error) {
      const reason = String(
        (error as { reason?: unknown } | null)?.reason ??
          (error instanceof Error ? error.message : String(error)),
      );
      if (!this.onTokenSkipped) {
        // The full message (with the grant hint) stands; the raw reason is for the §13b warning.
        const message = error instanceof Error ? error.message : reason;
        throw Object.assign(new AgentConsoleChannelError(message, TOKEN_UNAVAILABLE, reason), {
          cause: error,
        });
      }
      this.#skipTokenUntil = Date.now() + TOKEN_RETRY_MS;
      try {
        this.onTokenSkipped(reason, error);
      } catch {
        // a logger that throws must not block the command
      }
      return undefined;
    }
  }

  async wrap(command: AgentConsoleCommand): Promise<OutgoingMessage> {
    const token = await this.#tokenFor();
    const secret = randomBytes(32).toString('base64url');
    const { mac: _mac, verified: _verified, ...fields } = command;
    const sealed = await this.sealer.seal(
      JSON.stringify({
        command: { ...fields, ts: Date.now() },
        ...(token !== undefined ? { token } : {}),
        replySecret: secret,
      }),
      commandAad(this.prefix, command.id),
    );
    const key = replyKey(secret, this.prefix, command.id);
    return {
      wire: { id: command.id, sealed },
      verifyReply: (reply) => sameMac(replyMac(key, reply), reply.mac),
    };
  }

  unauthorized(): void {
    this.#token?.reset?.();
  }
}

/**
 * Sealed mode (owning app side): open, check freshness, and — when `verifyTenant` is set — verify
 * the token the command carries. With a token the command's capabilities come from it; a command
 * without one is accepted only when no `verifyTenant` is set (crypto mode: whoever may encrypt with
 * the key is the console, like a shared secret).
 */
class SealedReceiverAuth implements ChannelAuth {
  readonly #verify: ReturnType<typeof resolveTenantVerifier> | undefined;
  constructor(
    readonly sealer: ConsoleSealer,
    verifyTenant: TenantVerifierInput | undefined,
    readonly prefix: string,
    readonly app: string | undefined,
    /** A command without a token is accepted (crypto authenticates the console); one with a token must pass it. */
    readonly tokenOptional = false,
  ) {
    this.#verify = verifyTenant === undefined ? undefined : resolveTenantVerifier(verifyTenant);
  }

  async unwrap(wire: Record<string, unknown>): Promise<IncomingMessage | null> {
    if (typeof wire.sealed !== 'string' || typeof wire.id !== 'string') return null;
    if (!this.sealer.owns(wire.sealed)) return null;
    const id = wire.id;
    let payload: { command?: AgentConsoleCommand; token?: unknown; replySecret?: unknown };
    try {
      payload = JSON.parse(
        await this.sealer.open(wire.sealed, commandAad(this.prefix, id)),
      ) as typeof payload;
    } catch {
      throw refusedCommand("did not open with this app's key");
    }
    const command = payload?.command;
    if (
      !command ||
      command.id !== id ||
      typeof command.verb !== 'string' ||
      typeof payload.replySecret !== 'string' ||
      !fresh(command.ts)
    ) {
      throw refusedCommand(
        command && command.id === id && !fresh(command.ts)
          ? 'stale'
          : "did not open with this app's key",
      );
    }
    const key = replyKey(payload.replySecret, this.prefix, id);
    const signReply = (reply: AgentConsoleReply): AgentConsoleReply => {
      const { mac: _mac, ...rest } = reply;
      return { ...rest, mac: replyMac(key, rest as AgentConsoleReply) } as AgentConsoleReply;
    };
    const { mac: _mac, ts: _ts, verified: _claimed, ...fields } = command;
    if (!this.#verify) return { id, signReply, command: fields };
    const carriesToken = typeof payload.token === 'string' && payload.token !== '';
    // A verifier from a fallback (authkit's app-call verifier): crypto alone authenticates a
    // command without a token, and a token, when sent, must still pass and caps the command.
    if (!carriesToken && this.tokenOptional) return { id, signReply, command: fields };

    let verified: VerifiedTenant | null = null;
    try {
      verified =
        typeof payload.token === 'string' && payload.token !== ''
          ? await this.#verify({
              token: payload.token,
              app: this.app,
              partition: this.app,
              tenant: this.app,
              headers: {},
            })
          : null;
    } catch {
      verified = null;
    }
    if (!verified) {
      return {
        id,
        signReply,
        error: {
          message: `the console's token was refused by the "${this.prefix}" app`,
          code: UNAUTHORIZED_CONSOLE,
          status: 401,
        },
      };
    }
    return {
      id,
      signReply,
      command: {
        ...fields,
        verified: {
          partition: verified.partition,
          capabilities: verified.capabilities,
          ...(verified.clientId !== undefined ? { clientId: verified.clientId } : {}),
          ...(verified.audienceBound === true ? { audienceBound: true } : {}),
        },
      },
    };
  }
}

/** How one channel authenticates: what it sends with, and every way it accepts commands. */
export interface ConsoleChannelAuthOptions {
  /** Shared-secret mode: the same value on the console and on the app (16+ characters). */
  secret?: ChannelSecret | undefined;
  /**
   * Sealed mode with `@adonis-agora/crypto`, both sides: the cipher (`crypto.client`, or
   * `serviceCipher(crypto.service, partition)` where crypto is embedded) and the key
   * (`console-agent` by default). The console needs `encrypt` on it, the app `decrypt`.
   */
  crypto?: ConsoleCryptoOptions | undefined;
  /** Console side: the token each command carries (`authkitTenantToken(...)`). */
  token?: TenantTokenSource | undefined;
  /**
   * Console side, crypto mode: the token is optional (the app accepts crypto alone). When minting
   * it fails, the command is sent without it, this is called with the reason, and minting is
   * retried after 5 minutes. Without it (or without crypto), a failed mint fails the command.
   */
  onTokenSkipped?: ((reason: string, error?: unknown) => void) | undefined;
  /**
   * Console side, without `crypto`: the app's command public key (`node ace agent:console-key` on
   * that app prints it). Configured, never read from Redis.
   */
  recipient?: OkpJwk | (() => Promise<OkpJwk>) | undefined;
  /** App side, without `crypto`: this app's command key pair (derived from its `APP_KEY`). */
  keys?: { publicKey: OkpJwk; privateKey: OkpJwk } | undefined;
  /** App side: verifies the console's token (`authkitTenantVerifier(...)`). */
  verifyTenant?: TenantVerifierInput | undefined;
  /**
   * App side, crypto mode with `verifyTenant`: accept a sealed command that carries no token (one
   * that carries a token must still pass it). Set for a fallback verifier (authkit's app-call one);
   * an explicit `crypto` + `verifyTenant` keeps the token mandatory. Token-only mode always requires it.
   */
  tokenOptional?: boolean | undefined;
  /** App side: this app's partition, handed to `verifyTenant` as the app the command is for. */
  app?: string | undefined;
}

/** An `ioredis` client: pub/sub needs a dedicated connection, made with `duplicate()`. */
export interface IoredisLike {
  publish(channel: string, message: string): Promise<unknown>;
  set?(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<unknown>;
  duplicate(): IoredisSubscriberLike;
}

export interface IoredisSubscriberLike {
  subscribe(...channels: string[]): unknown;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  disconnect?(): void;
}

/** An `@adonisjs/redis` connection: it keeps its own subscriber and hands each payload over. */
export interface AdonisRedisLike {
  publish(channel: string, message: string): Promise<unknown>;
  set?(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<unknown>;
  subscribe(channel: string, handler: (message: string) => void): unknown;
  unsubscribe?(channel: string): unknown;
}

export type RedisLike = IoredisLike | AdonisRedisLike;

/** How long a command waits for its answer by default. */
export const AGENT_CONSOLE_TIMEOUT_MS = 15_000;
/** How long the claim on a command lives (longer than any answer is waited for). */
const CLAIM_TTL_MS = 120_000;
/** How long a console waits before minting a failed optional token again. */
const TOKEN_RETRY_MS = 5 * 60_000;
/** How many claimed command ids an instance remembers to recognise a replay. */
const MAX_RAN_IDS = 10_000;

function isIoredis(client: RedisLike): client is IoredisLike {
  return typeof (client as IoredisLike).duplicate === 'function';
}

/** `SET key value PX ttl NX` on either client: `'OK'` for the one caller that wins the key. */
function claimOf(
  client: RedisLike,
): ((key: string, value: string) => Promise<unknown>) | undefined {
  const target =
    typeof client.set === 'function'
      ? client
      : (client as { ioConnection?: { set?: IoredisLike['set'] } }).ioConnection;
  const set = target?.set;
  if (typeof set !== 'function') return undefined;
  return (key, value) => set.call(target, key, value, 'PX', CLAIM_TTL_MS, 'NX');
}

/** A command the owning app refused or failed, or that nobody answered. */
export class AgentConsoleChannelError extends Error {
  readonly code: string;
  /** Set when this app refused an incoming command: the uniform reason the app logs. */
  readonly reason: string | undefined;
  constructor(message: string, code: string, reason?: string) {
    super(message);
    this.name = 'AgentConsoleChannelError';
    this.code = code;
    this.reason = reason;
  }
}

/**
 * An incoming command this app refused, with the uniform reason every Agora lib logs: `not JSON`,
 * `no command id`, `did not open with this app's key`, `bad signature`, `stale`, `token refused`,
 * `capabilities-required`, or `mode not accepted here (…)`.
 */
export function refusedCommand(reason: string): AgentConsoleChannelError {
  return new AgentConsoleChannelError(`refused a command (${reason})`, UNSIGNED_CHANNEL, reason);
}

/** Token mode: the console's app-call token could not be minted (no grant, authkit down). */
export const TOKEN_UNAVAILABLE = 'federated-console-token-unavailable';
/** Nobody listens on the app's channel, or nobody answered in time. */
export const APP_UNREACHABLE = 'federated-app-unreachable';
/** The channel has no authentication, or a command arrived without valid authentication. */
export const UNSIGNED_CHANNEL = 'federated-channel-unsigned';

export class RedisConsoleChannel {
  readonly prefix: string;
  readonly #client: RedisLike;
  readonly #subscriptions: Array<() => void> = [];
  readonly #handlers = new Map<string, (payload: string) => void>();
  readonly #pending = new Map<string, (reply: AgentConsoleReply) => void>();
  #subscriber: IoredisSubscriberLike | undefined;
  #replies: Promise<void> | undefined;
  #answering = false;
  #closed = false;
  /** How commands are sent (one mode). */
  readonly #sender: ChannelAuth | undefined;
  /** How commands are accepted (each configured mode; an app may accept several while migrating). */
  readonly #receivers: ChannelAuth[];
  /** Command ids this instance claimed, until their claim expires: how a replay is told apart. */
  readonly #ran = new Map<string, number>();
  /** The modes this channel accepts, for the "mode not accepted here" reason. */
  readonly #acceptedModes: string[];

  /**
   * Redis is not a trust boundary, so a channel neither sends nor answers commands without one of:
   *
   * - `crypto` — commands sealed with an `@adonis-agora/crypto` key (the console may encrypt with it,
   *   the app decrypt), optionally with a `token` the app checks with `verifyTenant`;
   * - a `token` sealed to the app's command key (`recipient` / `keys`, from its `APP_KEY`), checked
   *   with `verifyTenant` (authkit, typically);
   * - `secret` — shared by the console and the app (the same value on both sides).
   */
  constructor(options: { client: RedisLike; prefix: string } & ConsoleChannelAuthOptions) {
    if (!options.prefix) throw new Error(`[${PACKAGE}] console channel: prefix is required`);
    this.#client = options.client;
    this.prefix = options.prefix;
    const secret =
      options.secret === undefined ? undefined : new SecretAuth(options.secret, options.prefix);
    const crypto = options.crypto ? cryptoConsoleSealer(options.crypto) : undefined;

    // Sending: crypto when configured, else a token sealed to the app's key, else the secret.
    if (options.token !== undefined && !crypto && !options.recipient) {
      throw new Error(
        `[${PACKAGE}] console channel: a \`token\` needs \`crypto\` or the app's \`publicKey\``,
      );
    }
    const sendSealer =
      crypto ?? (options.recipient ? appKeySealerTo(options.recipient) : undefined);
    const sealedSender =
      sendSealer && (crypto || options.token !== undefined)
        ? new SealedSenderAuth(
            sendSealer,
            options.token,
            options.prefix,
            crypto ? options.onTokenSkipped : undefined,
          )
        : undefined;
    this.#sender = sealedSender ?? secret;

    // Answering: every configured way. Without crypto, sealed commands need a token check.
    const receivers: ChannelAuth[] = [];
    if (crypto) {
      receivers.push(
        new SealedReceiverAuth(
          crypto,
          options.verifyTenant,
          options.prefix,
          options.app,
          options.tokenOptional === true,
        ),
      );
    }
    if (options.keys && options.verifyTenant !== undefined) {
      receivers.push(
        new SealedReceiverAuth(
          appKeySealer(options.keys),
          options.verifyTenant,
          options.prefix,
          options.app,
        ),
      );
    }
    if (secret) receivers.push(secret);
    this.#acceptedModes = [
      ...(crypto ? ['crypto'] : []),
      ...(options.keys && options.verifyTenant !== undefined ? ['token'] : []),
      ...(secret ? ['secret'] : []),
    ];
    this.#receivers = receivers;
  }

  /** Remember that this instance claimed `id` (bounded: expired ids go first, then the oldest). */
  #remember(id: string): void {
    const now = Date.now();
    for (const [ran, expires] of this.#ran) {
      if (expires > now && this.#ran.size < MAX_RAN_IDS) break;
      this.#ran.delete(ran);
    }
    this.#ran.set(id, now + CLAIM_TTL_MS);
  }

  /** Whether this instance claimed `id` within the claim's lifetime. */
  #ranHere(id: string): boolean {
    const expires = this.#ran.get(id);
    return expires !== undefined && expires > Date.now();
  }

  /** Whether this channel can send commands (crypto, a token and the app's key, or a secret). */
  get signed(): boolean {
    return this.#sender !== undefined;
  }

  #unsigned(): AgentConsoleChannelError {
    return new AgentConsoleChannelError(
      `the "${this.prefix}" ${CONSOLE_TOPIC} console channel has no authentication; use @adonis-agora/crypto (\`crypto\` on both sides), authkit (a \`token\` on the console, \`verifyTenant\` on the app) or the same \`secret\` on both`,
      UNSIGNED_CHANNEL,
    );
  }

  get commandChannel(): string {
    return `${this.prefix}-${CONSOLE_TOPIC}-console`;
  }

  get replyChannel(): string {
    return `${this.prefix}-${CONSOLE_TOPIC}-console-reply`;
  }

  /** Subscribe `handler` to `channel`; resolves once the subscription is in place. */
  async #subscribe(channel: string, handler: (payload: string) => void): Promise<void> {
    const client = this.#client;
    if (isIoredis(client)) {
      if (!this.#subscriber) {
        const sub = client.duplicate();
        this.#subscriber = sub;
        sub.on('message', (ch, payload) => this.#handlers.get(ch)?.(payload));
      }
      this.#handlers.set(channel, handler);
      await this.#subscriber.subscribe(channel);
      return;
    }
    await client.subscribe(channel, handler);
    this.#subscriptions.push(() => void client.unsubscribe?.(channel));
  }

  /**
   * Send `command` to the owning app and wait for its answer. Rejects at once when the channel has
   * no authentication or no instance listens (`PUBLISH` reached nobody), and after `timeoutMs` when
   * nobody answers. An answer without this command's MAC is ignored.
   */
  async send(
    command: AgentConsoleCommand,
    options: { timeoutMs?: number | undefined } = {},
  ): Promise<AgentConsoleReply> {
    if (this.#closed) {
      throw new AgentConsoleChannelError('console channel closed', APP_UNREACHABLE);
    }
    const sender = this.#sender;
    if (!sender?.wrap) throw this.#unsigned();
    let outgoing: OutgoingMessage;
    try {
      outgoing = await sender.wrap(command);
    } catch (error) {
      if (error instanceof AgentConsoleChannelError) throw error;
      throw new AgentConsoleChannelError(
        `could not prepare the ${CONSOLE_TOPIC} console command for "${this.prefix}": ${error instanceof Error ? error.message : String(error)}`,
        APP_UNREACHABLE,
      );
    }
    if (!this.#replies) {
      const replies = this.#subscribe(this.replyChannel, (payload) => {
        let reply: AgentConsoleReply;
        try {
          reply = JSON.parse(payload) as AgentConsoleReply;
        } catch {
          return;
        }
        if (typeof reply?.id !== 'string') return;
        this.#pending.get(reply.id)?.(reply);
      });
      this.#replies = replies;
      // A failed subscribe (a Redis blip) is retried by the next send, not kept for good.
      replies.catch(() => {
        if (this.#replies === replies) this.#replies = undefined;
      });
    }
    try {
      await this.#replies;
    } catch (error) {
      throw new AgentConsoleChannelError(
        `could not subscribe to the "${this.prefix}" app's console replies: ${error instanceof Error ? error.message : String(error)}`,
        APP_UNREACHABLE,
      );
    }
    const timeoutMs = options.timeoutMs ?? AGENT_CONSOLE_TIMEOUT_MS;
    return new Promise<AgentConsoleReply>((resolve, reject) => {
      const fail = (message: string) => {
        clearTimeout(timer);
        this.#pending.delete(command.id);
        reject(new AgentConsoleChannelError(message, APP_UNREACHABLE));
      };
      const timer = setTimeout(
        () =>
          fail(
            `no instance of "${this.prefix}" answered within ${Math.round(timeoutMs / 100) / 10}s — the app may have refused the command (check its logs, or run \`node ace agora:doctor\` there)`,
          ),
        timeoutMs,
      );
      timer.unref?.();
      this.#pending.set(command.id, (reply) => {
        // `close()` settles with an unsigned reply of its own; anything else must carry the MAC.
        const local = !reply.ok && reply.error.code === APP_UNREACHABLE && this.#closed;
        // A reply without this command's MAC is someone else's (or forged): wait for the real one.
        if (!local && !outgoing.verifyReply(reply)) return;
        clearTimeout(timer);
        this.#pending.delete(command.id);
        if (!reply.ok && reply.error.code === UNAUTHORIZED_CONSOLE) sender.unauthorized?.();
        resolve(reply);
      });
      this.#client.publish(this.commandChannel, JSON.stringify(outgoing.wire)).then(
        (receivers) => {
          // Redis says how many subscribers got it: none means no instance answers commands.
          if (receivers === 0) {
            fail(
              `no instance of the "${this.prefix}" app listens for ${CONSOLE_TOPIC} console commands (is it up, with \`consoleCommands\` in config/${CONSOLE_TOPIC}.ts?)`,
            );
          }
        },
        (err: unknown) => fail(err instanceof Error ? err.message : String(err)),
      );
    });
  }

  /**
   * Answer the commands other apps' consoles send this app. Every instance subscribes; the one that
   * wins `SET <prefix>-agent-console-claim:<id> NX` runs the command and publishes the answer, so a
   * command runs once however many processes the app has. Throws when the channel has no
   * authentication, or when the client cannot run that `SET`: a command never runs without both.
   */
  async answer(
    handler: (command: AgentConsoleCommand) => Promise<unknown>,
    options: { onError?: (error: unknown) => void } = {},
  ): Promise<void> {
    if (this.#answering) return;
    if (this.#receivers.length === 0) throw this.#unsigned();
    const claim = claimOf(this.#client);
    if (!claim) {
      throw new Error(
        `the "${this.prefix}" Redis connection cannot run \`SET key value PX ms NX\`, so ${CONSOLE_TOPIC} console commands cannot be claimed by one instance; refusing to answer them`,
      );
    }
    this.#answering = true;
    const instance = randomUUID();
    await this.#subscribe(this.commandChannel, (payload) => {
      // Never crash on a bad message: every failure is handed to `onError` and the message dropped.
      void this.#run(payload, instance, claim, handler).catch((error) => {
        try {
          options.onError?.(error);
        } catch {
          // A failing logger must not take the process down either.
        }
      });
    });
  }

  async #run(
    payload: string,
    instance: string,
    claim: (key: string, value: string) => Promise<unknown>,
    handler: (command: AgentConsoleCommand) => Promise<unknown>,
  ): Promise<void> {
    let wire: Record<string, unknown>;
    try {
      wire = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      throw refusedCommand('not JSON');
    }
    if (!wire || typeof wire !== 'object' || typeof wire.id !== 'string') {
      throw refusedCommand('no command id');
    }
    let incoming: IncomingMessage | null = null;
    for (const receiver of this.#receivers) {
      incoming = (await receiver.unwrap?.(wire)) ?? null;
      if (incoming) break;
    }
    if (!incoming) {
      throw refusedCommand(
        `mode not accepted here (this app accepts: ${this.#acceptedModes.join(', ')}; the command came as ${modeOfWire(wire)})`,
      );
    }
    // One instance runs (or refuses) it; a replay inside the freshness window reuses the id, and
    // the claim (kept 2 minutes) refuses it.
    const claimed = await claim(
      `${this.prefix}-${CONSOLE_TOPIC}-console-claim:${incoming.id}`,
      instance,
    );
    if (claimed !== 'OK') {
      // Another instance won the claim (the normal case): silent. A command id this instance
      // already ran is a replay.
      if (this.#ranHere(incoming.id)) throw refusedCommand('replayed');
      return;
    }
    this.#remember(incoming.id);
    if (!incoming.command) {
      await this.#client.publish(
        this.replyChannel,
        JSON.stringify(
          incoming.signReply({
            id: incoming.id,
            ok: false,
            error: incoming.error ?? { message: 'refused', code: UNSIGNED_CHANNEL, status: 401 },
          }),
        ),
      );
      // Answered (the console fetches a new token); logged here too, once per reason.
      throw refusedCommand('token refused');
    }
    const command = incoming.command;
    let reply: AgentConsoleReply;
    try {
      const data = await handler({
        ...command,
        args: Array.isArray(command.args) ? command.args : [],
        ...(command.capabilities !== undefined
          ? {
              capabilities: Array.isArray(command.capabilities)
                ? command.capabilities.filter((c) => typeof c === 'string')
                : [],
            }
          : {}),
      });
      // `undefined` (an action with no answer) travels as `null`.
      reply = { id: command.id, ok: true, data: data === undefined ? null : data };
    } catch (err) {
      const { code, status } = (err ?? {}) as { code?: unknown; status?: unknown };
      reply = {
        id: command.id,
        ok: false,
        error: {
          message: err instanceof Error ? err.message : String(err),
          ...(typeof code === 'string' ? { code } : {}),
          ...(typeof status === 'number' ? { status } : {}),
        },
      };
    }
    // MAC'd in its wire form (a `Date` becomes a string, `undefined` fields vanish), or the
    // console would compute another MAC and drop a genuine answer.
    await this.#client.publish(
      this.replyChannel,
      JSON.stringify(incoming.signReply(JSON.parse(JSON.stringify(reply)))),
    );
    if (!reply.ok && reply.error.code === 'capabilities-required') {
      throw refusedCommand('capabilities-required');
    }
  }

  /** Stop listening and fail the commands still waiting for an answer. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const [id, settle] of this.#pending) {
      settle({
        id,
        ok: false,
        error: { message: 'console channel closed', code: APP_UNREACHABLE },
      });
    }
    this.#pending.clear();
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
    this.#subscriber?.disconnect?.();
    this.#subscriber = undefined;
  }
}

/**
 * The Redis client for `connection` (an `@adonisjs/redis` connection name; omit for its default),
 * resolved through the container's `redis` binding.
 */
export async function resolveRedisConnection(
  container: { make(binding: string): Promise<unknown> },
  connection: string | undefined,
): Promise<RedisLike> {
  let redis: { connection(name?: string): unknown };
  try {
    redis = (await container.make('redis')) as typeof redis;
  } catch (error) {
    throw new Error(
      `[${PACKAGE}] the federated console needs @adonisjs/redis (no "redis" binding: ${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return redis.connection(connection) as RedisLike;
}

/** How a command arrived on the wire, for the refusal reason. */
function modeOfWire(wire: Record<string, unknown>): string {
  if (typeof wire.sealed === 'string') {
    if (wire.sealed.startsWith('agora:pk1:')) return 'token';
    if (wire.sealed.startsWith('agora:ct1:')) return 'crypto';
    return 'sealed with an unknown cipher';
  }
  if (typeof wire.mac === 'string') return 'secret';
  return 'unsigned';
}
