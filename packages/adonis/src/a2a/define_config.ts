import type { ApplicationService } from '@adonisjs/core/types';
import type { A2aAuth, A2aAuthFactory, A2aCaller } from './auth.js';
import type { A2aCardInput } from './handler.js';
import type { A2aStore } from './store.js';
import type { A2aActionPolicy, A2aTurnService } from './turn.js';

/** One agent exposed over A2A, keyed by its public id (the `{brand}` in `/a2a/{brand}`). */
export interface A2aAgentConfig {
  /** The registered agent that answers. Default: the key. */
  agent?: string;
  /** What the Agent Card says about it. */
  card: A2aCardInput;
}

/**
 * Shape of `config/a2a.ts`. Exposes registered agents to personal agents over A2A 1.0 (HTTP+JSON),
 * the transport of PACT (https://openpactprotocol.org):
 *
 * ```ts
 * import { defineA2aConfig, authKitPersonalAgents } from '@adonis-agora/agent/a2a'
 *
 * export default defineA2aConfig({
 *   baseUrl: 'https://acme.com',
 *   auth: authKitPersonalAgents(),
 *   agents: {
 *     support: { card: { name: 'Acme Support', description: 'Orders and returns.' } },
 *   },
 * })
 * ```
 */
export interface A2aConfig {
  /** Mount prefix. Default `'a2a'` → `/a2a/{agent}/…`. */
  path?: string;
  /**
   * Public origin of this app, for the interface URL on each Agent Card. Set it in production — the
   * fallback (the request's own Host) is whatever the caller sent.
   */
  baseUrl?: string;
  agents: Record<string, A2aAgentConfig>;
  /** Also serve this agent's card at `/.well-known/agent-card.json` (PACT §2.1). */
  rootCard?: string;
  /** How callers authenticate — `authKitPersonalAgents()`, or your own {@link A2aAuth}. */
  auth: A2aAuth | A2aAuthFactory;
  /**
   * Where conversation ownership and `messageId` replies live. Default `'lucid'` (tables created on
   * first use, `CREATE TABLE IF NOT EXISTS`); `'memory'` for a single process; or your own store.
   */
  store?: 'lucid' | 'memory' | A2aStore;
  /** Lucid connection for the `'lucid'` store. Default: the primary. */
  connection?: string;
  /** What happens to `action` calls that park for approval. Default `'approve-delegated'`. */
  actions?: A2aActionPolicy;
  /** Give up on a turn after this many ms (`INTERNAL`). Default 120 000. */
  timeoutMs?: number;
  /** Largest accepted request body, in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
  /**
   * What runs a turn. Default: the agent provider's `AgentService`. An app with its own runtime
   * (a `runAgentLoop` built per request) passes an adapter — or a factory resolved on first use.
   */
  service?:
    | A2aTurnService
    | ((ctx: { app: ApplicationService }) => A2aTurnService | Promise<A2aTurnService>);
  /** Roles of the actor a turn runs as. Default: `personal_agent` plus the delegated scopes. */
  roles?: (caller: A2aCaller) => string[];
}

/** Identity helper giving `config/a2a.ts` full type-checking. */
export function defineA2aConfig(config: A2aConfig): A2aConfig {
  return config;
}
