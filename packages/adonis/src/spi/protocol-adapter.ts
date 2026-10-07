import type { HttpContext } from '@adonisjs/core/http';
import type { AgentService } from '../agent-service.js';
import type { Actor } from '../types.js';
import type { AttachmentStagingStore } from './attachment-staging.js';

/**
 * A wire protocol other than the native one, served over the same runs — what `adapters` in the
 * config takes. An adapter mounts its own routes and translates; the runs, the store, the approvals
 * and the quota are the library's, unchanged.
 *
 * `agUiAdapter()` (`@adonis-agora/agent/ag-ui`) is the one that ships. Write your own the same way.
 */
export interface ProtocolAdapter {
  /** For logs and diagnostics. */
  name: string;
  /** Mount the adapter's routes. Called once, when the provider registers the agent's routes. */
  mount(host: ProtocolAdapterHost): void | Promise<void>;
}

type RouteHandler = (ctx: HttpContext) => unknown;

/**
 * What the provider hands an adapter: the service, and the SAME gates the native routes pass
 * through. Every `boolean`-answering gate has already written the refusal when it answers `false`
 * (or `null`) — the adapter just returns.
 */
export interface ProtocolAdapterHost {
  service: AgentService;
  defaultAgentName: string;
  /** Mount `POST <path>/<suffix>`, under the agent's configured path. */
  post(suffix: string, handler: RouteHandler): void;
  /** Mount `GET <path>/<suffix>`. */
  get(suffix: string, handler: RouteHandler): void;
  /**
   * Who is calling, by the configured actor resolver (the named agent's own, when it has one).
   * `null` after a `401` was written.
   */
  resolveActor(ctx: HttpContext, agentName?: string): Promise<Actor | null>;
  /** May `actor` act on a run or thread owned by `ownerRef`? As `chat` and `chat/:runId/stream` check. */
  assertOwner(
    ctx: HttpContext,
    actor: Actor,
    ownerRef: string | null,
    kind: 'run' | 'thread',
  ): Promise<boolean>;
  /** May `actor` settle this approval — the approval policy's approver, not yet lapsed? */
  mayDecide(ctx: HttpContext, actor: Actor, runId: string, toolCallId: string): Promise<boolean>;
  /**
   * Answer an error `service.send` / `service.chat` / a proposal decision threw the way
   * `POST <path>/chat` does (a refused attachment or model, a busy thread, an exhausted budget, a
   * proposal the caller may not decide). `false` when it is none of those: rethrow it.
   */
  refuseSend(ctx: HttpContext, error: unknown): boolean;
  /** Answer `409` for a decision nothing is waiting for; rethrows anything else. */
  conflictOnMismatch(ctx: HttpContext, error: unknown): void;
  /** The attachment store and its limits. Absent → attachments are off. */
  attachments?: {
    store: AttachmentStagingStore;
    maxBytes: number;
    allowedContentTypes: readonly string[];
    maxPerMessage: number;
  };
}
