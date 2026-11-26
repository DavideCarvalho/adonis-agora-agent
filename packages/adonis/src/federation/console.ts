import { randomUUID } from 'node:crypto';
import type { AgentService } from '../agent-service.js';
import { deriveKeyPair, type OkpJwk, publicJwk } from '../crypto-kit/index.js';
import {
  type ConsoleCapabilityTable,
  consoleCapabilityAllows,
} from '../dashboard/console_capabilities.js';
import { parseModelPriceInput } from '../pricing/price-input.js';
import type { AgentGovernanceQueries } from '../spi/governance-queries.js';
import type { AgentPricingStore } from '../spi/pricing-store.js';
import type { GovernanceQueriesFactory, PricingFactory, StoreContext } from '../stores/factory.js';
import { decideToolCall, type ToolCallDecision } from '../tool-call-decision.js';
import {
  type AgentConsoleCommand,
  type AgentConsoleReply,
  APP_UNREACHABLE,
  type ChannelSecret,
  type ConsoleCryptoOptions,
  RedisConsoleChannel,
  resolveRedisConnection,
  TOKEN_UNAVAILABLE,
} from './redis_channel.js';
import { AGENT_CONSOLE_SCOPES, type TenantTokenSource } from './tenant_auth.js';

/**
 * The agent's console capabilities, for the shared matcher (`../dashboard/console_capabilities.ts`):
 * both are writes; the agent has no console reads (its console reads the other app's tables).
 */
export const AGENT_CONSOLE_CAPABILITY_TABLE: ConsoleCapabilityTable = {
  [AGENT_CONSOLE_SCOPES.decide]: 'write',
  [AGENT_CONSOLE_SCOPES.pricingWrite]: 'write',
};

/** Whether `granted` allows `capability`, by the one matcher every Agora lib uses. */
function grants(granted: readonly unknown[], capability: string): boolean {
  return consoleCapabilityAllows(granted, capability, AGENT_CONSOLE_CAPABILITY_TABLE);
}

/**
 * The federated agent console: one app's agent console also shows the governance data of other
 * apps (runs, tool calls, threads, spend, approvals), each of which keeps its own tables and runs
 * its own agent. The console reads an app's governance read-model straight from that app's tables,
 * and sends what only that app can do (settling a pending approval, changing a model price) to the
 * app itself over Redis.
 */

/** One other app shown in this console (`config/agent.ts` → `dashboard.apps`). */
export interface FederatedConsoleApp {
  /** The name shown in the app selector. Defaults to the key. */
  label?: string | undefined;
  /**
   * That app's governance read-model: `governanceQueries.lucid({ connection, schema })` naming where
   * ITS agent tables are. Only read (never created or altered): give the role `SELECT` on them.
   */
  governance: GovernanceQueriesFactory | AgentGovernanceQueries;
  /**
   * That app's model prices: `pricingStores.lucid({ connection, schema })`. Prices the spend
   * rollups and fills the Pricing page. Omit and costs show as that app's tables recorded them, and
   * the Pricing page says it is not available.
   */
  pricing?: PricingFactory | AgentPricingStore | undefined;
  /**
   * Where that app answers (its `consoleCommands` in `config/agent.ts`): the `@adonisjs/redis`
   * connection to publish on, the app's `prefix`, and how this console proves itself to it — one
   * of `crypto`, `token` (+ `publicKey` without crypto) or `secret`. Without one, actions answer
   * `503` (the channel refuses to send).
   */
  controlPlane?: FederatedControlPlane | RedisConsoleChannel | undefined;
  /**
   * Send actions (approvals, price changes) to that app. Default `true`, and then the console must
   * authenticate to it (automatic with `@adonis-agora/crypto` or authkit, else `controlPlane`'s
   * `secret`/`token`/`crypto`): a boot error says so otherwise. `false`: browse-only, no
   * `controlPlane` needed, and every action on that app answers `403`.
   */
  actions?: boolean | undefined;
  /**
   * That app's name for `@adonis-agora/crypto` and authkit (its crypto partition, its authkit app):
   * the automatic modes seal its commands with its key and ask authkit for a token for it. Default:
   * this entry's key.
   */
  partition?: string | undefined;
  /** How long an action waits for the app to answer, in ms. Default 15 000. */
  timeoutMs?: number | undefined;
}

/** {@link FederatedConsoleApp.controlPlane} as configuration. */
export interface FederatedControlPlane {
  connection?: string | undefined;
  prefix: string;
  /**
   * Shared-secret mode: the secret shared with that app (its `consoleCommands.secret`), 16+
   * characters. Use it when there is no authkit and no `@adonis-agora/crypto`.
   */
  secret?: ChannelSecret | undefined;
  /**
   * Token mode: this console's token for that app, e.g. `authkitTenantToken({ issuer, clientId,
   * clientSecret, resource: 'urn:agora:agent' })` of a service-tenant client whose `partition` is
   * that app and whose capabilities say what this console may do there
   * (`agent:approvals:decide`, `agent:pricing:write`). The app checks it with its
   * `consoleCommands.verifyTenant`. Without `crypto`, commands travel sealed to `publicKey`.
   */
  token?: TenantTokenSource | false | undefined;
  /**
   * Token mode without `crypto`: that app's console-command public key, as printed by
   * `node ace agent:console-key` on that app (a JWK, or its JSON text from an env var). Taken from
   * configuration only, never from Redis.
   */
  publicKey?: OkpJwk | string | (() => Promise<OkpJwk>) | undefined;
  /**
   * Sealed with `@adonis-agora/crypto`: the cipher this console encrypts with, for a key
   * (`console-agent` by default) it may `encrypt` with and that app may `decrypt`. Where crypto is
   * embedded in this app (the Hub): `() => serviceCipher(crypto.service, '<that app>')`; on a
   * tenant of a crypto server: `() => crypto.client!`. Combine with `token` when the app also
   * checks one. `false` turns off the automatic crypto mode for that app.
   */
  crypto?: ConsoleCryptoOptions | false | undefined;
  /**
   * Filled by the automatic modes, not by configuration: crypto mode's token is optional, and this
   * is told why when minting it failed (the command went crypto-only).
   * @internal
   */
  onTokenSkipped?: ((reason: string, error?: unknown) => void) | undefined;
  /**
   * Filled by the automatic modes, not by configuration (§13a): crypto and authkit's key directory
   * are both possible; each command picks token mode when the app publishes a key, else crypto.
   * @internal
   */
  autoMode?: { hasDirectoryKey(): Promise<boolean> } | undefined;
}

/** What a federated app sends its commands through: one channel, or the per-app mode chooser. */
export interface ConsoleCommandSender {
  send(
    command: AgentConsoleCommand,
    options?: { timeoutMs?: number | undefined },
  ): Promise<AgentConsoleReply>;
  close(): Promise<void>;
}

/** How long a per-app mode choice holds before it is made again. */
const MODE_TTL_MS = 5 * 60_000;

/**
 * The console side's per-app mode (SECURITY-UNIFORM-SPEC §13a), chosen on the first command and
 * cached: token mode when the app publishes a key in authkit's directory (an app publishes only
 * when it answers in token mode), else crypto. Chosen again after 5 minutes, or when the app did
 * not answer (it may not accept the mode it was sent in).
 */
export class AutoModeChannel implements ConsoleCommandSender {
  #choice: { mode: 'token' | 'crypto'; at: number } | undefined;
  constructor(
    readonly channels: { token: ConsoleCommandSender; crypto: ConsoleCommandSender },
    readonly hasDirectoryKey: () => Promise<boolean>,
    readonly now: () => number = Date.now,
    /**
     * Told why when token mode's app-call token cannot be minted (a stale published key, no grant,
     * authkit down): that command, and the next ones for 5 minutes, go by crypto instead (§13b).
     */
    readonly onTokenUnavailable?: ((reason: string, error?: unknown) => void) | undefined,
  ) {}

  /** The mode the next command goes in (`undefined` until the first one). */
  get mode(): 'token' | 'crypto' | undefined {
    return this.#choice?.mode;
  }

  async #decide(): Promise<'token' | 'crypto'> {
    const choice = this.#choice;
    if (choice !== undefined && this.now() - choice.at < MODE_TTL_MS) return choice.mode;
    const published = await this.hasDirectoryKey().catch(() => false);
    const mode = published ? 'token' : 'crypto';
    this.#choice = { mode, at: this.now() };
    return mode;
  }

  async send(
    command: AgentConsoleCommand,
    options: { timeoutMs?: number | undefined } = {},
  ): Promise<AgentConsoleReply> {
    const mode = await this.#decide();
    try {
      const reply = await this.channels[mode].send(command, options);
      if (!reply.ok && /mode not accepted here/.test(reply.error.message)) this.#choice = undefined;
      return reply;
    } catch (error) {
      // Token mode, but the token cannot be minted: crypto reaches the app too, so this command
      // (and the next ones, for a while) goes that way instead (§13b). One mint per command.
      if (mode === 'token' && (error as { code?: unknown } | null)?.code === TOKEN_UNAVAILABLE) {
        const reason = (error as { reason?: unknown }).reason;
        try {
          this.onTokenUnavailable?.(
            typeof reason === 'string' ? reason : String(error),
            (error as { cause?: unknown }).cause ?? error,
          );
        } catch {
          // a logger that throws must not block the command
        }
        this.#choice = { mode: 'crypto', at: this.now() };
        return this.channels.crypto.send(command, options);
      }
      // Any other send failure or timeout (the app may not accept this mode: it logs "mode not
      // accepted here" and answers nothing): choose again on the next command.
      this.#choice = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.channels.token.close(), this.channels.crypto.close()]);
  }
}

export { FEDERATED_APP_KEY } from './app_key.js';

/**
 * The X25519 key pair an app's console commands are sealed to in token mode, derived from its
 * `APP_KEY` (so every instance has the same one, and a new APP_KEY makes a new one).
 */
export function consoleCommandKeys(
  appKey: string | { release(): string },
  prefix: string,
): { publicKey: OkpJwk; privateKey: OkpJwk } {
  return deriveKeyPair('x25519', appKey, `agent:console-commands:${prefix}`);
}

/**
 * A configured `controlPlane.publicKey` (a JWK or its JSON text) as an X25519 public JWK; throws
 * on anything else, and never keeps a private part.
 */
export function parseConsolePublicKey(value: OkpJwk | string): OkpJwk {
  let jwk: unknown = value;
  if (typeof value === 'string') {
    try {
      jwk = JSON.parse(value);
    } catch {
      throw new Error(
        '`controlPlane.publicKey` is not JSON (paste what `agent:console-key` prints)',
      );
    }
  }
  const key = jwk as Partial<OkpJwk> | null;
  if (
    !key ||
    typeof key !== 'object' ||
    key.kty !== 'OKP' ||
    key.crv !== 'X25519' ||
    typeof key.x !== 'string' ||
    typeof key.kid !== 'string'
  ) {
    throw new Error(
      '`controlPlane.publicKey` must be an X25519 public JWK (what `agent:console-key` prints)',
    );
  }
  return publicJwk(key as OkpJwk);
}

/**
 * Checks one `dashboard.apps` entry at boot, so a misconfigured app fails the boot instead of every
 * request that picks it. `redisConnections` are the names in `config/redis.ts` (`undefined`: none).
 */
export function validateFederatedConsoleApp(
  key: string,
  entry: FederatedConsoleApp,
  redisConnections: { names: string[]; default: string | undefined } | undefined,
  /** authkit's key directory is available: a token may be sealed to the key that app publishes. */
  keyDirectory = false,
): void {
  const fail = (message: string): never => {
    throw new Error(`[@adonis-agora/agent] dashboard.apps["${key}"]: ${message}`);
  };
  if (!entry || typeof entry !== 'object') fail('must be an object');
  if (!entry.governance) fail("`governance` is required (that app's governance read-model)");
  if (entry.actions !== undefined && typeof entry.actions !== 'boolean') {
    fail('`actions` must be a boolean (`false`: browse-only)');
  }
  if (
    entry.partition !== undefined &&
    (typeof entry.partition !== 'string' || entry.partition.trim() === '')
  ) {
    fail("`partition` must be that app's crypto partition / authkit app name (not empty)");
  }
  const plane = entry.controlPlane;
  if (plane === undefined && entry.actions !== false) {
    fail(
      '`controlPlane` is required ({ connection, prefix }) to send actions; set `actions: false` for browse-only',
    );
  }
  if (plane !== undefined && !(plane instanceof RedisConsoleChannel)) {
    if (!plane || typeof plane !== 'object') {
      fail('`controlPlane` must be { connection, prefix }');
    }
    if (typeof plane.prefix !== 'string' || plane.prefix.trim() === '') {
      fail("`controlPlane.prefix` must be the other app's `consoleCommands.prefix` (not empty)");
    }
    if (
      plane.connection !== undefined &&
      (typeof plane.connection !== 'string' || plane.connection === '')
    ) {
      fail('`controlPlane.connection` must be a connection name of config/redis.ts');
    }
    if (
      plane.token !== undefined &&
      plane.token !== false &&
      (plane.crypto === undefined || plane.crypto === false) &&
      plane.publicKey === undefined &&
      !keyDirectory
    ) {
      fail(
        "`controlPlane.token` needs that app's `publicKey` (`node ace agent:console-key` on it), authkit's key directory (authkit-client's `service` on both apps), or `crypto`",
      );
    }
    if (plane.publicKey !== undefined && typeof plane.publicKey !== 'function') {
      try {
        parseConsolePublicKey(plane.publicKey);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    }
    if (typeof plane.secret === 'string' && plane.secret.length < 16) {
      fail('`controlPlane.secret` must be at least 16 characters');
    }
    if (!redisConnections) {
      fail('the federated console needs @adonisjs/redis (no config/redis.ts found)');
    } else {
      const name = plane.connection ?? redisConnections.default;
      if (name === undefined || !redisConnections.names.includes(name)) {
        fail(
          `\`controlPlane.connection\` "${name ?? '(default)'}" is not a connection of config/redis.ts (${redisConnections.names.join(', ') || 'none'})`,
        );
      }
    }
  }
  if (
    entry.timeoutMs !== undefined &&
    (typeof entry.timeoutMs !== 'number' ||
      !Number.isFinite(entry.timeoutMs) ||
      entry.timeoutMs <= 0)
  ) {
    fail('`timeoutMs` must be a positive number of milliseconds');
  }
}

/** The commands another app's console may send this app. */
export const AGENT_CONSOLE_VERBS = ['decide', 'upsertPrice'] as const;
export type AgentConsoleVerb = (typeof AGENT_CONSOLE_VERBS)[number];

/** The capability each command needs (in the console's token, and in the viewer's grant). */
export const AGENT_CONSOLE_VERB_CAPABILITY: Record<AgentConsoleVerb, string> = {
  decide: AGENT_CONSOLE_SCOPES.decide,
  upsertPrice: AGENT_CONSOLE_SCOPES.pricingWrite,
};

/** Every console capability the agent knows, the set a console narrows a viewer within. */
export const AGENT_CONSOLE_CAPABILITIES: readonly string[] = [
  AGENT_CONSOLE_SCOPES.decide,
  AGENT_CONSOLE_SCOPES.pricingWrite,
];

/**
 * A viewer's capabilities (from the console's `authorize`) narrowed to the agent's console set:
 * each console capability they hold, directly or through a wildcard (`agent:console:*`, `agent:*`,
 * `*`, `agent:console:write`). `undefined` (authorize named none) is the full set.
 */
export function agentConsoleCapabilities(granted: readonly string[] | undefined): string[] {
  if (granted === undefined) return [...AGENT_CONSOLE_CAPABILITIES];
  return AGENT_CONSOLE_CAPABILITIES.filter((capability) => grants(granted, capability));
}

/** The refusal code of a command that carries no `capabilities` array (the same in every lib). */
export const CAPABILITIES_REQUIRED = 'capabilities-required';

/** A command this app does not answer. Answered `501` by the console. */
export const UNSUPPORTED = 'unsupported-request';

/** What a `decide` command carries. */
export interface DecideCommandArgs {
  toolCallId: string;
  runId?: string | undefined;
  decision: ToolCallDecision;
}

/** An error carrying the HTTP status the console answers with. */
export class FederatedAppError extends Error {
  readonly status: number;
  /** The owning app's own message, for this app's log (a `502` does not show it to the browser). */
  readonly detail: string | undefined;
  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = 'FederatedAppError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Run the commands another app's federated console sends this app. Only commands the channel
 * authenticated reach it (shared secret, `@adonis-agora/crypto`, or a verified token), and each one
 * must still pass:
 *
 * - `actions` — this app takes actions from another console at all (off by default);
 * - token mode — the token is for THIS app (`app`) and holds the verb's capability
 *   (`agent:approvals:decide`, `agent:pricing:write`); the viewer capabilities the console sends
 *   can only narrow it;
 * - otherwise — the viewer capabilities the console sends must hold it (none sent: refused).
 *
 * A `decide` settles a pending tool call under the same rules as `POST <path>/tool-call/approve|
 * reject`, with the console viewer as the deciding actor and cross-actor privilege only because
 * the checks above passed; an approval that names its own approver still asks the approval policy.
 * Each command is logged with who sent it.
 */
export function agentConsoleCommandHandler(options: {
  service: AgentService;
  pricing?: AgentPricingStore | undefined;
  /** Take actions (decide, upsertPrice) from another console. Default `false`: refuse them. */
  actions?: boolean | undefined;
  /** This app's partition: a verified token must be for it. */
  app?: string | undefined;
  log?: ((line: string) => void) | undefined;
}): (command: AgentConsoleCommand) => Promise<unknown> {
  return async (command) => {
    const verb = command.verb;
    if (verb !== 'decide' && verb !== 'upsertPrice') {
      throw Object.assign(new Error(`this app does not answer the agent console command ${verb}`), {
        code: UNSUPPORTED,
      });
    }
    const by =
      typeof command.actor === 'string' && command.actor !== '' ? command.actor : 'unknown';
    const verified = command.verified;
    const via =
      typeof command.via === 'string' && command.via !== ''
        ? ` via ${command.via}`
        : verified?.audienceBound === true
          ? ` via ${verified.partition}`
          : verified?.clientId !== undefined
            ? ` via ${verified.clientId}`
            : '';
    const capability = AGENT_CONSOLE_VERB_CAPABILITY[verb];
    // The order every Agora lib checks in: capabilities present → token → viewer → partition →
    // actions. The viewer's grant is required in every mode, token mode included (where it
    // narrows the token): a command without it never means "everything".
    const viewer = command.capabilities;
    if (!Array.isArray(viewer)) {
      throw Object.assign(
        new Error(
          'the console sent no capabilities with this command (the viewer lacks every capability)',
        ),
        { status: 403, code: CAPABILITIES_REQUIRED },
      );
    }
    if (verified && !grants(verified.capabilities, capability)) {
      throw Object.assign(new Error(`the console's token lacks ${capability}`), { status: 403 });
    }
    if (!grants(viewer, capability)) {
      throw Object.assign(new Error(`the viewer lacks ${capability}`), { status: 403 });
    }
    // An app-call token (authkit) names this app in its audience: its partition is the caller.
    if (
      verified &&
      verified.audienceBound !== true &&
      (options.app === undefined || verified.partition !== options.app)
    ) {
      throw Object.assign(
        new Error(
          `the console's token is for "${verified.partition}", not "${options.app ?? '(unnamed)'}"`,
        ),
        { status: 403 },
      );
    }
    if (options.actions !== true) {
      throw Object.assign(
        new Error(
          'this app takes no actions from another console (consoleCommands.actions is off)',
        ),
        { status: 403 },
      );
    }
    if (verb === 'decide') {
      const args = (command.args[0] ?? {}) as Partial<DecideCommandArgs>;
      const kind = args.decision?.kind;
      if (typeof args.toolCallId !== 'string' || (kind !== 'approve' && kind !== 'reject')) {
        throw Object.assign(new Error('a decision needs a toolCallId and approve or reject'), {
          status: 400,
        });
      }
      options.log?.(
        `[@adonis-agora/agent] federated console: ${kind} ${args.toolCallId} by ${by}${via}`,
      );
      const outcome = await decideToolCall(options.service, {
        actor: { id: by },
        toolCallId: args.toolCallId,
        runId: args.runId,
        decision: args.decision as ToolCallDecision,
        // Cross-actor privilege comes from the checks above (an authenticated console, `actions`
        // on, and the decide capability), never from the message alone.
        privileged: async () => true,
      });
      if (outcome.ok) return { ok: true, runId: outcome.runId };
      const { status, message, code } = outcome.refusal;
      throw Object.assign(new Error(message), { status, ...(code !== undefined ? { code } : {}) });
    }
    if (options.pricing === undefined) {
      throw Object.assign(new Error('no pricing store is configured'), { status: 501 });
    }
    const price = parseModelPriceInput(command.args[0]);
    if (price === null) {
      throw Object.assign(new Error('not a model price'), { status: 400 });
    }
    options.log?.(
      `[@adonis-agora/agent] federated console: upsertPrice ${price.modelId} by ${by}${via}`,
    );
    await options.pricing.upsertModelPrice(price);
    return { ok: true };
  };
}

/** Another app as the console sees it: its read-model, its prices and its command channel. */
export class FederatedApp {
  readonly id: string;
  readonly label: string;
  readonly governance: AgentGovernanceQueries;
  readonly pricing: AgentPricingStore | undefined;
  /** Absent for a browse-only app (`actions: false`). */
  readonly channel: ConsoleCommandSender | undefined;
  readonly timeoutMs: number | undefined;
  /** This console's name (its `appLabel`), sent with each command for the app's log. */
  readonly via: string | undefined;

  constructor(options: {
    id: string;
    label?: string | undefined;
    governance: AgentGovernanceQueries;
    pricing?: AgentPricingStore | undefined;
    channel?: ConsoleCommandSender | undefined;
    timeoutMs?: number | undefined;
    via?: string | undefined;
  }) {
    this.id = options.id;
    this.label = options.label ?? options.id;
    this.governance = options.governance;
    this.pricing = options.pricing;
    this.channel = options.channel;
    this.timeoutMs = options.timeoutMs;
    this.via = options.via;
  }

  /**
   * Send `verb` to the app and return its answer. `503` (naming the app) when it does not answer
   * (or this console has no authentication for it), `501` for a command it does not run, the app's
   * own status for its refusals, else `502`. The viewer's grant travels as `capabilities` (what the
   * console's `authorize` returned, narrowed to the agent's console set, or the full set): the app
   * checks the verb's capability in it, against its own rules (and, in token mode, its token's).
   */
  async send(
    verb: AgentConsoleVerb,
    args: unknown[],
    actor?: string,
    /** The viewer's console capabilities (see {@link agentConsoleCapabilities}). Default: the verb's. */
    capabilities?: readonly string[],
  ): Promise<unknown> {
    const channel = this.channel;
    if (channel === undefined) {
      throw new FederatedAppError(
        `${this.label} is browse-only in this console (actions: false)`,
        403,
      );
    }
    let reply: AgentConsoleReply;
    try {
      reply = await channel.send(
        {
          id: randomUUID(),
          verb,
          args,
          capabilities:
            capabilities !== undefined ? [...capabilities] : [AGENT_CONSOLE_VERB_CAPABILITY[verb]],
          ...(actor !== undefined ? { actor } : {}),
          ...(this.via !== undefined ? { via: this.via } : {}),
        },
        this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {},
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new FederatedAppError(`${this.label}: ${message}`, 503);
    }
    if (reply.ok) return reply.data;
    const { message, code, status } = reply.error;
    if (code === APP_UNREACHABLE) throw new FederatedAppError(`${this.label}: ${message}`, 503);
    if (code === UNSUPPORTED) throw new FederatedAppError(message, 501);
    // The app's own refusal (unknown call 404, not allowed 403, expired 410, ended 409…) stands.
    if (typeof status === 'number' && status >= 400 && status < 600 && status !== 500) {
      throw new FederatedAppError(message, status);
    }
    throw new FederatedAppError(`the ${this.label} app answered with an error`, 502, message);
  }

  async close(): Promise<void> {
    await this.channel?.close();
  }
}

/** Build one configured app: its read-model and prices (read-only) and its command channel. */
export async function buildFederatedAgentApp(
  id: string,
  config: FederatedConsoleApp,
  app: StoreContext['app'],
  options: { via?: string | undefined } = {},
): Promise<FederatedApp> {
  const ctx: StoreContext = { app, readOnly: true };
  const pricing =
    config.pricing === undefined
      ? undefined
      : typeof config.pricing === 'function'
        ? await config.pricing(ctx)
        : config.pricing;
  const governance =
    typeof config.governance === 'function'
      ? await config.governance({
          ...ctx,
          ...(pricing !== undefined ? { pricingStore: pricing } : {}),
        })
      : config.governance;
  const plane = config.actions === false ? undefined : config.controlPlane;
  const crypto =
    plane instanceof RedisConsoleChannel || plane?.crypto === false ? undefined : plane?.crypto;
  const token =
    plane instanceof RedisConsoleChannel || plane?.token === false ? undefined : plane?.token;
  let channel: ConsoleCommandSender | undefined;
  if (plane === undefined || plane instanceof RedisConsoleChannel) {
    channel = plane;
  } else {
    const client = await resolveRedisConnection(app.container as never, plane.connection);
    const make = (
      options: Omit<ConstructorParameters<typeof RedisConsoleChannel>[0], 'client' | 'prefix'>,
    ) => new RedisConsoleChannel({ client, prefix: plane.prefix, ...options });
    const recipient =
      plane.publicKey === undefined
        ? undefined
        : typeof plane.publicKey === 'function'
          ? (() => {
              const resolve = plane.publicKey;
              return async () => parseConsolePublicKey(await resolve());
            })()
          : parseConsolePublicKey(plane.publicKey);
    if (
      plane.autoMode !== undefined &&
      crypto !== undefined &&
      token !== undefined &&
      recipient !== undefined
    ) {
      // §13a: both reach that app; each command picks (token when it publishes a key, else crypto).
      channel = new AutoModeChannel(
        {
          token: make({ token, recipient }),
          crypto: make({
            crypto,
            token,
            ...(plane.onTokenSkipped !== undefined ? { onTokenSkipped: plane.onTokenSkipped } : {}),
          }),
        },
        plane.autoMode.hasDirectoryKey,
        Date.now,
        plane.onTokenSkipped,
      );
    } else {
      channel = make({
        ...(plane.secret !== undefined ? { secret: plane.secret } : {}),
        ...(crypto !== undefined ? { crypto } : {}),
        ...(token !== undefined ? { token } : {}),
        ...(crypto !== undefined && plane.onTokenSkipped !== undefined
          ? { onTokenSkipped: plane.onTokenSkipped }
          : {}),
        // The app's APP_KEY-derived key, from this console's configuration: only without crypto.
        ...(token !== undefined && crypto === undefined && recipient !== undefined
          ? { recipient }
          : {}),
      });
    }
  }
  return new FederatedApp({
    id,
    ...(config.label !== undefined ? { label: config.label } : {}),
    governance,
    ...(pricing !== undefined ? { pricing } : {}),
    ...(channel !== undefined ? { channel } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(options.via !== undefined ? { via: options.via } : {}),
  });
}
