import { createHash } from 'node:crypto';
import type { AgentEngine, AgentEngineContext } from '../engine.js';
import type { AgentRunner } from '../spi/agent-runner.js';
import type { ProtocolAdapter } from '../spi/protocol-adapter.js';
import {
  InMemoryOpenCodeSessionStore,
  type OpenCodeHost,
  type OpenCodeSessionStore,
} from './host.js';
import { openCodeLog } from './log.js';
import { OpenCodeMcpEndpoint, OpenCodeToolsTokens } from './mcp.js';
import { OpenCodeAgentRunner } from './runner.js';
import { type OpenCodeEngineSettings, OpenCodeTurns } from './turns.js';

/** A class the container builds (`@inject()` its services into the constructor). */
// biome-ignore lint/suspicious/noExplicitAny: a constructor of any arity, as the container builds it.
export type OpenCodeClass<T> = abstract new (...args: any[]) => T;

export interface OpenCodeEngineOptions extends OpenCodeEngineSettings {
  /**
   * The host: an {@link OpenCodeHost} instance, or a class the app's container builds (so it can
   * `@inject()` the services that know where the server is and how to set sessions up).
   */
  host: OpenCodeHost | OpenCodeClass<OpenCodeHost>;
  /** Where each thread's session is kept. Same forms as `host`. Omit → in memory. */
  sessions?: OpenCodeSessionStore | OpenCodeClass<OpenCodeSessionStore>;
}

const DEFAULT_TOOLS_TTL_MS = 7 * 24 * 60 * 60_000;

async function resolve<T extends object>(
  value: T | OpenCodeClass<T>,
  context: AgentEngineContext,
  what: string,
): Promise<T> {
  if (typeof value !== 'function') return value;
  if (context.make === undefined) {
    throw new Error(
      `[@adonis-agora/agent/opencode] the ${what} is a class, and there is no container to build it with: pass an instance.`,
    );
  }
  return context.make<T>(value);
}

/**
 * The OpenCode engine — `engine: openCode({ host })` in `config/agent.ts`. The routes, threads,
 * stream protocol, approvals, questions and queue stay the library's; OpenCode runs the model, the
 * tools, skills and the context, on the server and sessions the host provides.
 */
export class OpenCodeEngine implements AgentEngine {
  readonly name: string = 'opencode';
  readonly durable: boolean = false;
  #turns: OpenCodeTurns | undefined;
  #endpoint: OpenCodeMcpEndpoint | undefined;

  constructor(readonly options: OpenCodeEngineOptions) {}

  /**
   * The engine's turn steps, once the provider built the runner: `pushToSession` (trusted pushes
   * into a session's run) and `liveRuns()` for the host's own use.
   */
  get turns(): OpenCodeTurns {
    if (this.#turns === undefined) {
      throw new Error('[@adonis-agora/agent/opencode] the engine has not been started yet.');
    }
    return this.#turns;
  }

  /** The tools endpoint, when `tools` is set and the engine has started. */
  get endpoint(): OpenCodeMcpEndpoint | undefined {
    return this.#endpoint;
  }

  async createRunner(context: AgentEngineContext): Promise<AgentRunner> {
    const turns = await this.buildTurns(context);
    return new OpenCodeAgentRunner(turns, context.store);
  }

  adapters(): readonly ProtocolAdapter[] {
    return this.#endpoint !== undefined ? [this.#endpoint.adapter()] : [];
  }

  shutdown(): void {
    this.#turns?.close();
  }

  /** The host, the session store, the tools endpoint and the turn steps every OpenCode runner needs. */
  protected async buildTurns(context: AgentEngineContext): Promise<OpenCodeTurns> {
    const { host: hostOption, sessions: sessionsOption, ...settings } = this.options;
    const host = await resolve(hostOption, context, 'host');
    const sessions =
      sessionsOption === undefined
        ? new InMemoryOpenCodeSessionStore()
        : await resolve(sessionsOption, context, 'session store');
    let tokens: OpenCodeToolsTokens | undefined;
    if (settings.tools !== undefined) {
      const secret =
        settings.tools.secret ??
        (context.appKey !== undefined
          ? createHash('sha256').update(`opencode-tools:${context.appKey}`).digest('hex')
          : undefined);
      if (secret === undefined) {
        openCodeLog.warn(
          '`tools` has no `secret` and the app has no APP_KEY: the endpoint signs its tokens with a per-process secret, so it only works with one process.',
        );
      }
      tokens = new OpenCodeToolsTokens(secret, settings.tools.ttlMs ?? DEFAULT_TOOLS_TTL_MS);
    }
    const turns = new OpenCodeTurns({
      host,
      sessions,
      settings,
      factory: context.factory,
      store: context.store,
      sink: context.sink,
      registry: context.registry,
      queue: context.queue,
      ...(tokens !== undefined
        ? { mintToolsToken: (actor, serverKey) => tokens.mint(actor, serverKey) }
        : {}),
    });
    this.#turns = turns;
    this.#endpoint = tokens !== undefined ? new OpenCodeMcpEndpoint(turns, tokens) : undefined;
    return turns;
  }
}

/**
 * Run the agent's turns on OpenCode 2 — `engine: openCode({ host })` in `config/agent.ts`. In
 * memory: a turn parked on a person lives in this process (single replica); see
 * `openCodeDurable()` (`@adonis-agora/agent/opencode/durable`) for turns that survive restarts.
 */
export function openCode(options: OpenCodeEngineOptions): OpenCodeEngine {
  return new OpenCodeEngine(options);
}
