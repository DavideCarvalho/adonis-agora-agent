import { randomUUID } from 'node:crypto';
import type { AgentService } from '../agent-service.js';
import { parseModelPriceInput } from '../pricing/price-input.js';
import type { AgentGovernanceQueries } from '../spi/governance-queries.js';
import type { AgentPricingStore } from '../spi/pricing-store.js';
import type { GovernanceQueriesFactory, PricingFactory, StoreContext } from '../stores/factory.js';
import { decideToolCall, type ToolCallDecision } from '../tool-call-decision.js';
import {
  type AgentConsoleCommand,
  APP_UNREACHABLE,
  RedisConsoleChannel,
  resolveRedisConnection,
} from './redis_channel.js';

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
   * connection to publish on and the app's `prefix`.
   */
  controlPlane: { connection?: string | undefined; prefix: string } | RedisConsoleChannel;
  /** How long an action waits for the app to answer, in ms. Default 15 000. */
  timeoutMs?: number | undefined;
}

export { FEDERATED_APP_KEY } from './app_key.js';

/**
 * Checks one `dashboard.apps` entry at boot, so a misconfigured app fails the boot instead of every
 * request that picks it. `redisConnections` are the names in `config/redis.ts` (`undefined`: none).
 */
export function validateFederatedConsoleApp(
  key: string,
  entry: FederatedConsoleApp,
  redisConnections: { names: string[]; default: string | undefined } | undefined,
): void {
  const fail = (message: string): never => {
    throw new Error(`[@adonis-agora/agent] dashboard.apps["${key}"]: ${message}`);
  };
  if (!entry || typeof entry !== 'object') fail('must be an object');
  if (!entry.governance) fail("`governance` is required (that app's governance read-model)");
  const plane = entry.controlPlane;
  if (!(plane instanceof RedisConsoleChannel)) {
    if (!plane || typeof plane !== 'object') {
      fail('`controlPlane` is required ({ connection, prefix })');
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
 * Run the commands another app's federated console sends this app. A `decide` settles a pending
 * tool call under the same rules as `POST <path>/tool-call/approve|reject`, with the console viewer
 * as the deciding actor and cross-actor privilege (that console's `authorize` already let them in);
 * an approval that names its own approver still asks the approval policy. Each command is logged
 * with who sent it.
 */
export function agentConsoleCommandHandler(options: {
  service: AgentService;
  pricing?: AgentPricingStore | undefined;
  log?: ((line: string) => void) | undefined;
}): (command: AgentConsoleCommand) => Promise<unknown> {
  return async (command) => {
    const by = command.actor ?? 'unknown';
    if (command.verb === 'decide') {
      const args = (command.args[0] ?? {}) as Partial<DecideCommandArgs>;
      const kind = args.decision?.kind;
      if (typeof args.toolCallId !== 'string' || (kind !== 'approve' && kind !== 'reject')) {
        throw Object.assign(new Error('a decision needs a toolCallId and approve or reject'), {
          status: 400,
        });
      }
      options.log?.(`[agent] federated console: ${kind} ${args.toolCallId} by ${by}`);
      const outcome = await decideToolCall(options.service, {
        actor: { id: by },
        toolCallId: args.toolCallId,
        runId: args.runId,
        decision: args.decision as ToolCallDecision,
        privileged: async () => true,
      });
      if (outcome.ok) return { ok: true, runId: outcome.runId };
      const { status, message, code } = outcome.refusal;
      throw Object.assign(new Error(message), { status, ...(code !== undefined ? { code } : {}) });
    }
    if (command.verb === 'upsertPrice') {
      if (options.pricing === undefined) {
        throw Object.assign(new Error('no pricing store is configured'), { status: 501 });
      }
      const price = parseModelPriceInput(command.args[0]);
      if (price === null) {
        throw Object.assign(new Error('not a model price'), { status: 400 });
      }
      options.log?.(`[agent] federated console: upsertPrice ${price.modelId} by ${by}`);
      await options.pricing.upsertModelPrice(price);
      return { ok: true };
    }
    throw Object.assign(
      new Error(`this app does not answer the agent console command ${command.verb}`),
      {
        code: UNSUPPORTED,
      },
    );
  };
}

/** Another app as the console sees it: its read-model, its prices and its command channel. */
export class FederatedApp {
  readonly id: string;
  readonly label: string;
  readonly governance: AgentGovernanceQueries;
  readonly pricing: AgentPricingStore | undefined;
  readonly channel: RedisConsoleChannel;
  readonly timeoutMs: number | undefined;

  constructor(options: {
    id: string;
    label?: string | undefined;
    governance: AgentGovernanceQueries;
    pricing?: AgentPricingStore | undefined;
    channel: RedisConsoleChannel;
    timeoutMs?: number | undefined;
  }) {
    this.id = options.id;
    this.label = options.label ?? options.id;
    this.governance = options.governance;
    this.pricing = options.pricing;
    this.channel = options.channel;
    this.timeoutMs = options.timeoutMs;
  }

  /**
   * Send `verb` to the app and return its answer. `503` (naming the app) when it does not answer,
   * `501` for a command it does not run, the app's own status for its refusals, else `502`.
   */
  async send(verb: AgentConsoleVerb, args: unknown[], actor?: string): Promise<unknown> {
    let reply: Awaited<ReturnType<RedisConsoleChannel['send']>>;
    try {
      reply = await this.channel.send(
        { id: randomUUID(), verb, args, ...(actor !== undefined ? { actor } : {}) },
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
    await this.channel.close();
  }
}

/** Build one configured app: its read-model and prices (read-only) and its command channel. */
export async function buildFederatedAgentApp(
  id: string,
  config: FederatedConsoleApp,
  app: StoreContext['app'],
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
  const channel =
    config.controlPlane instanceof RedisConsoleChannel
      ? config.controlPlane
      : new RedisConsoleChannel({
          client: await resolveRedisConnection(
            app.container as never,
            config.controlPlane.connection,
          ),
          prefix: config.controlPlane.prefix,
        });
  return new FederatedApp({
    id,
    ...(config.label !== undefined ? { label: config.label } : {}),
    governance,
    ...(pricing !== undefined ? { pricing } : {}),
    channel,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  });
}
