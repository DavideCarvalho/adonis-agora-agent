import type { ApplicationService } from '@adonisjs/core/types';
import type { A2aActionPolicy, A2aTurnService } from '../a2a/turn.js';
import type { Actor } from '../types.js';
import type { PoppyAuthenticate, PoppyPrincipal } from './auth.js';
import type { PoppyDirectHooks, PoppyHandoffHooks, PoppyTexts } from './conversations.js';
import type { PoppyStore } from './store.js';

/**
 * Shape of `config/poppy.ts`. Exposes an agent as the Company Agent of Personal Agent Protocol
 * ("Poppy", Draft 0.1) conversations — https://personalagentprotocol.org, §7:
 *
 * ```ts
 * import { definePoppyConfig } from '@adonis-agora/agent/poppy'
 *
 * export default definePoppyConfig({
 *   path: 'poppy/conversations',
 *   agent: 'support',
 * })
 * ```
 *
 * Session Tokens are verified by the resolver `@adonis-agora/authkit-server` installs in
 * `Symbol.for('@adonis-agora/poppy:authenticate')`, or by `authenticate`. Advertise the endpoint
 * in `poppy.json` as `agent.protocols: [{ type: 'poppy', endpoint: 'https://…/poppy/conversations' }]`.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */
export interface PoppyConfig {
  /** The endpoint path. Default `'poppy/conversations'`. */
  path?: string;
  /**
   * Public origin of this app — the URL a DPoP proof is checked against. Set it in production
   * (behind a proxy); the fallback is the request's own protocol and Host.
   */
  baseUrl?: string;
  /** The registered agent that answers. Default: the agent provider's default agent. */
  agent?: string;
  /** Verifies Session Tokens; overrides the global resolver. Neither → the endpoint answers 501. */
  authenticate?: PoppyAuthenticate;
  /**
   * The actor of a principal the resolver gave none (`principal.actor`). Gets the default
   * (`poppy:<hash of client and user>`). `personal_agent` and the token's `scope:<id>` roles are
   * added whatever this returns.
   */
  actorFor?: (principal: PoppyPrincipal, defaults: Actor) => Actor | Promise<Actor>;
  /**
   * Where conversations and their events live. Default `'lucid'` (tables created on first use);
   * `'memory'` for a single process; or your own {@link PoppyStore} (e.g. `redisPoppyStore(…)`).
   */
  store?: 'lucid' | 'memory' | PoppyStore;
  /** Lucid connection for the `'lucid'` store. Default: the primary. */
  connection?: string;
  /** Create the `'lucid'` store's tables on first use. Default `true`. */
  autoCreateTables?: boolean;
  /** What happens to `action` calls that park for approval. Default `'approve-delegated'`. */
  actions?: A2aActionPolicy;
  /** Bring a person in (§7.9). Without it, a handoff is declined by the Company Agent. */
  handoff?: PoppyHandoffHooks;
  /** Notified when a Direct Conversation opens or closes (§7.10). */
  direct?: PoppyDirectHooks;
  /** What the Company Agent says on its own. */
  texts?: Partial<PoppyTexts>;
  /** Give up on a turn after this many ms. Default 120 000. */
  timeoutMs?: number;
  /** Largest accepted request body, in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Cap on a read's `wait`, in seconds. Default 30. */
  maxWaitSeconds?: number;
  /** Close an event stream after this long (the Personal Agent reconnects). Default 5 min. */
  streamMaxMs?: number;
  /** Prune events older than this (a cursor there is `cursor_expired`). Default: keep them. */
  retentionMs?: number;
  /**
   * Execute, in this process, a durable run its dispatcher left `pending` while a reply is read
   * (`AgentService.drive`). Default `true`.
   */
  drive?: boolean;
  /** What runs a turn. Default: the agent provider's `AgentService` (see `A2aConfig.service`). */
  service?:
    | A2aTurnService
    | ((ctx: { app: ApplicationService }) => A2aTurnService | Promise<A2aTurnService>);
}

/**
 * Identity helper giving `config/poppy.ts` full type-checking.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */
export function definePoppyConfig(config: PoppyConfig): PoppyConfig {
  return config;
}
