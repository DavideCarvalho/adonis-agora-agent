import { createHash, randomUUID } from 'node:crypto';
import type { HttpContext } from '@adonisjs/core/http';
import type { AgentService } from '../agent-service.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { Actor } from '../types.js';
import type { A2aAuth, A2aCaller } from './auth.js';
import { scopeRole } from './gate.js';
import { PERSONAL_AGENT_ROLE } from './permission-tool.js';
import {
  A2A_CONTENT_TYPE,
  A2aError,
  type A2aMessage,
  type A2aSendResult,
  parseSendMessage,
} from './protocol.js';
import type { A2aStore } from './store.js';
import { type A2aActionPolicy, runA2aTurn } from './turn.js';

/** What an Agent Card says about the agent, beyond what the surface fills in. */
export interface A2aCardInput {
  name: string;
  description: string;
  version?: string;
  provider?: { organization: string; url: string };
  documentationUrl?: string;
  iconUrl?: string;
  skills?: {
    id: string;
    name: string;
    description: string;
    tags: string[];
    examples?: string[];
  }[];
}

/** One agent exposed over A2A — a "brand" in PACT terms, at `/{path}/{id}`. */
export interface A2aBrand {
  id: string;
  /** The registered agent that answers. */
  agentName: string;
  card: A2aCardInput;
}

export interface A2aHandlerOptions {
  /** Mount prefix, no slashes (`'a2a'` → `/a2a/{brand}/…`). */
  path: string;
  /** Public origin the card's interface URL is built on. Omitted → the request's. */
  baseUrl?: string;
  brands: ReadonlyMap<string, A2aBrand>;
  /** Serve this brand's card at `/.well-known/agent-card.json` too (PACT §2.1's standard place). */
  rootCardBrand?: string;
  auth: A2aAuth;
  store: A2aStore;
  service: Pick<AgentService, 'chat' | 'subscribe' | 'approve' | 'reject' | 'skip' | 'cancel'>;
  registry: ToolRegistry;
  actions: A2aActionPolicy;
  timeoutMs: number;
  maxBodyBytes: number;
  /** Roles of the actor a turn runs as. Default: the personal-agent role plus the delegated scopes. */
  roles?: (caller: A2aCaller) => string[];
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * The actor of an identity-only turn: stable per (personal agent, its user), never an account id —
 * the `pa:` prefix keeps it from ever colliding with one.
 */
export function personalAgentActorId(issuer: string, sub: string): string {
  return `pa:${createHash('sha256').update(`${issuer}\n${sub}`).digest('hex').slice(0, 40)}`;
}

function actorFor(caller: A2aCaller, options: A2aHandlerOptions): Actor {
  const extra = options.roles?.(caller) ?? (caller.delegation?.scopes ?? []).map(scopeRole);
  return {
    id: caller.delegation?.accountId ?? personalAgentActorId(caller.issuer, caller.sub),
    // `personal_agent` is ALWAYS there: it is what puts the actor behind `personalAgentGate`.
    roles: [...new Set([PERSONAL_AGENT_ROLE, ...extra])],
  };
}

/** What a `messageId` keeps for its retries: the status and the body they get back. */
interface StoredReply {
  status: number;
  body: unknown;
}

/**
 * Where the FIRST message of a conversation is claimed: it has no `contextId` yet, so a retry of it
 * could only be told apart from a new conversation by this per-(brand, personal-agent user) slot.
 */
function newConversationKey(brand: string, caller: A2aCaller): string {
  return `new:${brand}:${personalAgentActorId(caller.issuer, caller.sub)}`;
}

function sendA2a(ctx: HttpContext, status: number, body: unknown): void {
  ctx.response.status(status);
  ctx.response.header('Content-Type', A2A_CONTENT_TYPE);
  ctx.response.send(JSON.stringify(body));
}

/** A bare status, no A2A body — unmatched routes and unknown brands (PACT §2.2). */
function sendBare(ctx: HttpContext, status: 404 | 405): void {
  ctx.response.status(status);
  ctx.response.header('Content-Type', 'text/plain; charset=utf-8');
  ctx.response.send(status === 404 ? 'Not Found' : 'Method Not Allowed');
}

/** The request body, read straight off the socket: no bodyparser runs ahead of this surface. */
async function readBody(ctx: HttpContext, limit: number): Promise<string> {
  const parsed = (ctx.request as { raw?: () => string | null }).raw?.();
  if (typeof parsed === 'string') return parsed;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of ctx.request.request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) throw new A2aError('INVALID_PARAMS', 'Request body is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The request path without the query string. */
function pathOf(ctx: HttpContext): string {
  return (ctx.request.url() ?? '').split('?')[0] ?? '';
}

type Route =
  | { kind: 'card' }
  | { kind: 'send' }
  | { kind: 'listTasks' }
  | { kind: 'task'; taskId: string }
  | { kind: 'unsupported' }
  | { kind: 'push' };

/**
 * Match `rest` (the path after `/{path}/{brand}/`) against the A2A operations. `null` → 404, a
 * method mismatch → 405 — both decided before any authentication (PACT §2.2).
 */
function matchRoute(method: string, rest: string): Route | 404 | 405 {
  const allow = (methods: string[], route: Route) => (methods.includes(method) ? route : 405);
  if (rest === '.well-known/agent-card.json') return allow(['GET'], { kind: 'card' });
  if (rest === 'message:send') return allow(['POST'], { kind: 'send' });
  if (rest === 'message:stream') return allow(['POST'], { kind: 'unsupported' });
  if (rest === 'extendedAgentCard') return allow(['GET'], { kind: 'unsupported' });
  if (rest === 'tasks') return allow(['GET'], { kind: 'listTasks' });

  const segments = rest.split('/');
  if (segments[0] !== 'tasks' || !segments[1]) return 404;
  const [, taskSegment, sub, configId, ...extra] = segments;
  if (extra.length > 0) return 404;
  if (sub === undefined) {
    const action = /^(.+):(cancel|subscribe)$/.exec(taskSegment);
    if (action?.[2] === 'cancel') {
      return allow(['POST'], { kind: 'task', taskId: action[1] ?? taskSegment });
    }
    if (action?.[2] === 'subscribe') return allow(['POST', 'GET'], { kind: 'unsupported' });
    return allow(['GET'], { kind: 'task', taskId: taskSegment });
  }
  if (sub !== 'pushNotificationConfigs') return 404;
  return configId === undefined
    ? allow(['GET', 'POST'], { kind: 'push' })
    : allow(['GET', 'DELETE'], { kind: 'push' });
}

/**
 * The A2A 1.0 HTTP+JSON surface (PACT §2, §4, §5.5) over the agent runtime. Returns a request
 * handler that answers everything under `/{path}/` and reports `false` for anything else, so it can
 * sit in front of the router.
 */
export function createA2aHandler(options: A2aHandlerOptions) {
  const prefix = `/${options.path}/`;

  const interfaceUrl = (ctx: HttpContext, brand: A2aBrand): string => {
    const origin =
      options.baseUrl?.replace(/\/+$/, '') ??
      `${ctx.request.protocol()}://${ctx.request.host() ?? 'localhost'}`;
    return `${origin}/${options.path}/${encodeURIComponent(brand.id)}`;
  };

  async function card(ctx: HttpContext, brand: A2aBrand) {
    const url = interfaceUrl(ctx, brand);
    ctx.response.header('Content-Type', 'application/json');
    ctx.response.header('Access-Control-Allow-Origin', '*');
    ctx.response.send(
      JSON.stringify({
        name: brand.card.name,
        description: brand.card.description,
        supportedInterfaces: [{ url, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
        ...(brand.card.provider ? { provider: brand.card.provider } : {}),
        version: brand.card.version ?? '1.0.0',
        ...(brand.card.documentationUrl ? { documentationUrl: brand.card.documentationUrl } : {}),
        ...(brand.card.iconUrl ? { iconUrl: brand.card.iconUrl } : {}),
        capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
        ...(await options.auth.cardSecurity(ctx, url)),
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: brand.card.skills ?? [],
      }),
    );
  }

  async function send(ctx: HttpContext, brand: A2aBrand, caller: A2aCaller): Promise<void> {
    const input = parseSendMessage(await readBody(ctx, options.maxBodyBytes));
    const actor = actorFor(caller, options);
    const accountId = caller.delegation?.accountId ?? null;

    if (input.contextId !== undefined) {
      const context = await options.store.getContext(input.contextId);
      // Another user's or another brand's context is indistinguishable from none (PACT §4.2).
      if (
        !context ||
        context.brand !== brand.id ||
        context.agentIssuer !== caller.issuer ||
        context.agentSub !== caller.sub
      ) {
        throw new A2aError('INVALID_PARAMS', 'Unknown contextId');
      }
      // A conversation that ran as an account holds that account's data: it continues only under
      // a delegation for it — not identity-only (a revoked grant), not another account (§5.5).
      if (context.accountRef !== null && accountId === null) {
        throw new A2aError('INVALID_PARAMS', 'contextId needs the delegation it ran under');
      }
      if (accountId !== null && !(await options.store.bindAccount(input.contextId, accountId))) {
        throw new A2aError('INVALID_PARAMS', 'contextId belongs to another account');
      }
    }

    const claimKey = input.contextId ?? newConversationKey(brand.id, caller);
    const claim = await options.store.claimMessage(claimKey, input.messageId);
    if (claim.status === 'done') {
      const stored = claim.reply as StoredReply;
      return sendA2a(ctx, stored.status, stored.body);
    }
    if (claim.status === 'pending') {
      throw new A2aError('INVALID_PARAMS', 'messageId is already in use in this context');
    }

    let threadId = input.contextId;
    const finish = async (reply: StoredReply) => {
      await options.store.completeMessage(claimKey, input.messageId, reply);
      // A first message is also answerable from its new context — a retry may carry it by now.
      if (threadId !== undefined && threadId !== claimKey) {
        await options.store.claimMessage(threadId, input.messageId);
        await options.store.completeMessage(threadId, input.messageId, reply);
      }
      sendA2a(ctx, reply.status, reply.body);
    };

    let turn: Awaited<ReturnType<typeof runA2aTurn>>;
    try {
      turn = await runA2aTurn(options.service, options.registry, {
        actor,
        text: input.text,
        agentName: brand.agentName,
        ...(input.contextId !== undefined ? { threadId: input.contextId } : {}),
        delegatedScopes: caller.delegation?.scopes ?? null,
        actions: options.actions,
        timeoutMs: options.timeoutMs,
        onStarted: async (id) => {
          threadId = id;
          if (input.contextId !== undefined) return;
          await options.store.createContext({
            id,
            brand: brand.id,
            agentIssuer: caller.issuer,
            agentSub: caller.sub,
            accountRef: accountId,
          });
        },
      });
    } catch (error) {
      await options.store.releaseMessage(claimKey, input.messageId);
      if ((error as { code?: string }).code === 'run_active') {
        throw new A2aError('INVALID_PARAMS', 'contextId already has a message in progress');
      }
      throw error;
    }

    if (turn.error !== null) {
      const failure = new A2aError('INTERNAL', 'The agent could not answer');
      // Something already ran on the account: a retry must get this failure back, not run it again.
      if (turn.actions.length > 0) {
        return finish({ status: failure.httpStatus, body: failure.toJSON() });
      }
      await options.store.releaseMessage(claimKey, input.messageId);
      throw failure;
    }

    const receipt = caller.delegation
      ? await options.auth.receipt(ctx, {
          scopesUsed: [...new Set(turn.actions.flatMap((action) => action.scopes))],
          actions: turn.actions.map(({ tool, argsHash }) => ({ tool, argsHash })),
        })
      : {};
    const message: A2aMessage = {
      messageId: randomUUID(),
      contextId: turn.threadId,
      role: 'ROLE_AGENT',
      parts: [{ text: turn.text }],
      ...(Object.keys(receipt).length > 0 ? { metadata: receipt } : {}),
    };

    let reply: A2aSendResult = { message };
    const missing = (turn.permission ?? []).filter(
      (scope) => !(caller.delegation?.scopes ?? []).includes(scope),
    );
    if (missing.length > 0) {
      const stepUp = await options.auth.stepUp(ctx, missing);
      if (stepUp !== null) {
        reply = {
          task: {
            id: `t-${randomUUID()}`,
            contextId: turn.threadId,
            status: { state: 'TASK_STATE_AUTH_REQUIRED', message },
            metadata: { ...receipt, ...stepUp },
          },
        };
      }
    }
    await finish({ status: 200, body: reply });
  }

  function listTasks(ctx: HttpContext): void {
    const raw = ctx.request.qs().pageSize;
    const pageSize = raw === undefined ? DEFAULT_PAGE_SIZE : Number(raw);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new A2aError('INVALID_PARAMS', 'pageSize must be an integer from 1 to 100');
    }
    // Ordinary turns create no task (PACT §4.2) and step-up tasks are ephemeral.
    sendA2a(ctx, 200, { tasks: [], nextPageToken: '', pageSize, totalSize: 0 });
  }

  return async function handle(ctx: HttpContext): Promise<boolean> {
    const path = pathOf(ctx);
    const method = ctx.request.method().toUpperCase();

    if (path === '/.well-known/agent-card.json' && options.rootCardBrand !== undefined) {
      const brand = options.brands.get(options.rootCardBrand);
      if (!brand) return false;
      if (method !== 'GET') {
        sendBare(ctx, 405);
        return true;
      }
      await card(ctx, brand);
      return true;
    }
    if (!path.startsWith(prefix)) return false;

    const [brandSegment = '', ...restSegments] = path.slice(prefix.length).split('/');
    let brandId: string;
    try {
      brandId = decodeURIComponent(brandSegment);
    } catch {
      brandId = '';
    }
    const brand = options.brands.get(brandId);
    const route = brand ? matchRoute(method, restSegments.join('/')) : 404;
    if (!brand || route === 404 || route === 405) {
      sendBare(ctx, route === 405 ? 405 : 404);
      return true;
    }

    try {
      if (route.kind === 'card') {
        await card(ctx, brand);
        return true;
      }
      // Authenticate before reading the body (PACT §3.4).
      const caller = await options.auth.authenticate(ctx);
      if (!caller) return true;

      switch (route.kind) {
        case 'send':
          await send(ctx, brand, caller);
          break;
        case 'listTasks':
          listTasks(ctx);
          break;
        case 'task':
          throw new A2aError('TASK_NOT_FOUND', `Task not found: ${route.taskId}`);
        case 'unsupported':
          throw new A2aError('UNSUPPORTED_OPERATION', 'This operation is not supported');
        case 'push':
          throw new A2aError(
            'PUSH_NOTIFICATION_NOT_SUPPORTED',
            'Push notifications are not supported',
          );
      }
    } catch (error) {
      const a2a = error instanceof A2aError ? error : new A2aError('INTERNAL', 'Internal error');
      if (!(error instanceof A2aError)) {
        ctx.logger?.error({ err: error }, 'a2a: request failed');
      }
      sendA2a(ctx, a2a.httpStatus, a2a.toJSON());
    }
    return true;
  };
}
