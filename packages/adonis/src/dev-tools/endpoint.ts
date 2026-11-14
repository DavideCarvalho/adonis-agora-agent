import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { personalAgentGate, scopeRole } from '../a2a/gate.js';
import { PERSONAL_AGENT_ROLE } from '../a2a/permission-tool.js';
import {
  type ConsoleAuthorizeDecision,
  normalizeConsoleAuthorizeResult,
} from '../console-authorize.js';
import { publishAgent } from '../diagnostics.js';
import { type McpAuth, McpAuthError } from '../mcp/auth.js';
import {
  mcpResourceUrl,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
} from '../mcp/discovery.js';
import { createMcpServer } from '../mcp/server.js';
import { ToolRegistry } from '../tool-registry.js';
import type { Actor } from '../types.js';
import {
  type DevToolsActionRefusal,
  type DevToolsActions,
  DevToolsActionsGate,
} from './actions.js';
import { bindDevToolsPrincipal, type DevToolsAuth } from './auth.js';
import { bridgeIdentity, identityForToken } from './authkit-bridge.js';
import type { DevTool, DevToolsCaller, DevToolsDecision } from './contract.js';
import type { DevToolsHubImpl, RegisteredDevToolsLib } from './hub.js';
import {
  capDevToolResult,
  DEV_TOOLS_MAX_BYTES,
  DEV_TOOLS_MAX_ROWS,
  redactDevToolOutput,
  truncateText,
} from './limits.js';
import { devToolStandardSchema } from './schema.js';

/** The scope a Poppy (personal agent) grant must carry to reach the dev tools. */
export const AGORA_DEV_SCOPE = 'agora:dev';

export type {
  DevToolsActionRequest,
  DevToolsActions,
  DevToolsActionsAuthorizer,
  DevToolsActionsMap,
} from './actions.js';

/** The logger surface the endpoint writes its audit lines to. */
export interface DevToolsLogger {
  info(obj: object, msg: string): void;
  debug(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface DevToolsEndpointOptions {
  app: ApplicationService;
  hub: DevToolsHubImpl;
  /** Normalized route path, no slashes around (`mcp/agora`). */
  path: string;
  actions: DevToolsActions;
  /** `authKitAuth()` resolved, when `@adonis-agora/authkit-server` is in the app (and no `auth`). */
  authkit?: McpAuth | undefined;
  /** `devTools.auth`: OAuth with any authorization server. Wins over `authkit`. */
  auth?: DevToolsAuth | undefined;
  logger: () => Promise<DevToolsLogger | undefined>;
  version: string;
  /**
   * The resolved `devTools.authorize`: gates the libs registered without an `authorize` of their own
   * (libs that have no console). `undefined` → open outside production, `403` in production.
   */
  endpointAuthorize?: ((ctx: HttpContext) => Promise<ConsoleAuthorizeDecision>) | undefined;
  /** `app.inProduction`, read for the endpoint gate's default. */
  inProduction?: boolean;
}

type Refusal = { status: 401 | 403 | 503; error: string; challenge: string };

interface Admission {
  caller: DevToolsCaller;
  actor: Actor;
  allowed: RegisteredDevToolsLib[];
}

/**
 * The dev MCP endpoint: stateless, re-authorized on every request, per lib. See the "Dev tools over
 * MCP" docs page for the behaviour; the order of a request is:
 *
 * 1. a bearer token is first offered to `devTools.auth` when set (its principal is bound to the
 *    request: `devToolsPrincipal(ctx)`, and `ctx.auth.user` with a resolved user), else to authkit
 *    (when installed): a token issued for THIS endpoint signs the account in and is bridged into the
 *    request like a browser session; a Poppy token needs the `agora:dev` scope. A bearer neither
 *    recognizes is left on the request for `authorizeByToken`.
 * 2. each lib the JSON-RPC message needs runs its own console `authorize(ctx)`, once.
 * 3. none allowed → `401`/`403`; else a registry of the allowed libs' tools serves the message.
 */
export class DevToolsEndpoint {
  readonly #options: DevToolsEndpointOptions;

  constructor(options: DevToolsEndpointOptions) {
    this.#options = options;
  }

  get path(): string {
    return this.#options.path;
  }

  /** Whether the hub does OAuth discovery (`devTools.auth`, or authkit). */
  get oauth(): boolean {
    return this.#options.auth !== undefined || this.#options.authkit?.oauth !== undefined;
  }

  /** `GET /.well-known/oauth-protected-resource/<path>` — only mounted with `devTools.auth` or authkit. */
  async metadata(ctx: HttpContext) {
    const auth = this.#options.auth;
    if (auth !== undefined) {
      ctx.response.header('access-control-allow-origin', '*');
      return ctx.response.json({
        resource: mcpResourceUrl(origin(ctx), this.#options.path),
        authorization_servers: [...auth.authorizationServers],
        scopes_supported: [...(auth.scopes ?? [])],
        bearer_methods_supported: ['header'],
        resource_name: auth.resourceName ?? 'Agora dev tools',
      });
    }
    const oauth = this.#options.authkit?.oauth;
    if (oauth === undefined) return ctx.response.status(404).json({ error: 'not found' });
    const meta = typeof oauth === 'function' ? await oauth() : oauth;
    ctx.response.header('access-control-allow-origin', '*');
    return ctx.response.json(protectedResourceMetadata(meta, origin(ctx), this.#options.path));
  }

  async handlePost(ctx: HttpContext): Promise<void> {
    const body: unknown = ctx.request.all();
    const admission = await this.#admit(ctx, this.#neededLibs(body));
    if (admission === null) return;

    const req = ctx.request.request as IncomingMessage;
    const res = ctx.response.response;
    try {
      const { registry, servesActions } = await this.#registryFor(ctx, admission);
      const server = createMcpServer({
        name: 'agora-dev-tools',
        version: this.#options.version,
        instructions: instructionsFor(admission.allowed, servesActions),
        registry,
        // Access was decided per lib above; a personal agent still needs its `agora:dev` scope role.
        policy: personalAgentGate({ can: () => true }),
        actions: 'execute',
        describeTool: ({ name, kind }) => {
          const tool = admission.allowed.flatMap((lib) => lib.tools).find((t) => t.name === name);
          return {
            annotations: {
              readOnlyHint: kind === 'read',
              ...(kind === 'action' ? { destructiveHint: tool?.destructive === true } : {}),
            },
          };
        },
        actorFromAuth: () => admission.actor,
        idsFromRequest: (_session, requestId) => ({
          threadId: `mcp-dev:${admission.caller.id}`,
          runId: `mcp-dev:${String(requestId ?? 'run')}`,
          requestId: `mcp-dev:${String(requestId ?? 'req')}`,
        }),
      });
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport as Transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : 'Internal error',
            },
            id: null,
          }),
        );
      }
    }
    await awaitFinish(res);
  }

  /** `GET`/`DELETE`: the endpoint is stateless. Authorized first, so a stranger gets the 401. */
  async methodNotAllowed(ctx: HttpContext) {
    if ((await this.#admit(ctx, this.#options.hub.servedLibs())) === null) return;
    ctx.response.header('allow', 'POST');
    return ctx.response.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this MCP server is stateless.' },
      id: null,
    });
  }

  // ── auth ──────────────────────────────────────────────────────────────────

  /**
   * The libs a JSON-RPC message needs: a call needs its tool's lib; anything else — a call to a name
   * no lib registered included — needs every lib, so an unknown name never answers without the same
   * authorization a real one gets (no way to probe which tools exist).
   */
  #neededLibs(body: unknown): RegisteredDevToolsLib[] {
    const hub = this.#options.hub;
    const messages = Array.isArray(body) ? body : [body];
    const needed = new Set<RegisteredDevToolsLib>();
    for (const message of messages) {
      const call = message as { method?: unknown; params?: { name?: unknown } } | null;
      const lib =
        call?.method === 'tools/call' && typeof call.params?.name === 'string'
          ? hub.libOf(call.params.name)
          : undefined;
      if (lib === undefined) return hub.servedLibs();
      needed.add(lib);
    }
    return [...needed];
  }

  /** Authenticate, run each needed lib's `authorize` once, and refuse when none allows. */
  async #admit(ctx: HttpContext, needed: RegisteredDevToolsLib[]): Promise<Admission | null> {
    const header = ctx.request.header('authorization');
    const bearer = /^Bearer\s+\S/i.test(header ?? '') ? header?.slice(7).trim() : undefined;
    const tokenId =
      bearer !== undefined
        ? `token:${createHash('sha256').update(bearer).digest('hex').slice(0, 12)}`
        : undefined;

    let caller: DevToolsCaller | undefined;
    let actor: Actor | undefined;
    let signedIn = false;
    const authkit = this.#options.authkit;
    const custom = this.#options.auth;
    if (bearer !== undefined && custom !== undefined) {
      const resource = mcpResourceUrl(origin(ctx), this.#options.path);
      let principal: Awaited<ReturnType<DevToolsAuth['verify']>>;
      try {
        principal = await custom.verify(bearer, { ctx, app: this.#options.app, resource });
      } catch (error) {
        if (!(error instanceof McpAuthError)) {
          // The JWKS or introspection endpoint is unreachable: a server-side outage, not a bad
          // token. A 503 keeps MCP clients out of a login loop and shows up in monitoring.
          const logger = await this.#options.logger();
          logger?.warn(
            { devTools: true, error: error instanceof Error ? error.message : String(error) },
            'agora dev tools: devTools.auth could not verify a token',
          );
          return this.#refuse(ctx, needed, tokenId ?? 'token', {
            status: 503,
            error: 'temporarily_unavailable: the authorization server could not be reached',
            challenge: '',
          });
        }
        const refusal = error;
        return this.#refuse(ctx, needed, tokenId ?? 'token', {
          status: refusal.status,
          error: refusal.message,
          challenge: this.#challenge(ctx, {
            error:
              refusal.error ?? (refusal.status === 403 ? 'insufficient_scope' : 'invalid_token'),
          }),
        });
      }
      if (principal !== null) {
        bindDevToolsPrincipal(ctx, principal);
        signedIn = true;
        caller = { id: `user:${principal.subject}`, via: 'session' };
        actor = {
          id: principal.subject,
          ...(principal.roles !== undefined ? { roles: principal.roles } : {}),
        };
      }
      // `null`: not this auth's token, left on the request for an `authorizeByToken` console.
    } else if (bearer !== undefined && authkit !== undefined) {
      try {
        const info = await authkit.verify(bearer, {
          resource: mcpResourceUrl(origin(ctx), this.#options.path),
        });
        const verified = info.extra.actor;
        const personalAgent = (verified.roles ?? []).includes(PERSONAL_AGENT_ROLE);
        if (personalAgent && !info.scopes.includes(AGORA_DEV_SCOPE)) {
          return this.#refuse(ctx, needed, tokenId ?? 'token', {
            status: 403,
            error: `insufficient_scope: the dev tools need the scope "${AGORA_DEV_SCOPE}"`,
            challenge: this.#challenge(ctx, {
              error: 'insufficient_scope',
              scope: AGORA_DEV_SCOPE,
            }),
          });
        }
        const identity = await identityForToken(this.#options.app, {
          accountId: verified.id,
          clientId: info.clientId || undefined,
          scopes: info.scopes,
          ...(info.expiresAt !== undefined ? { expiresAt: info.expiresAt } : {}),
        });
        if (identity === null) {
          return this.#refuse(ctx, needed, tokenId ?? 'token', {
            status: 401,
            error: 'invalid_token: the account no longer exists',
            challenge: this.#challenge(ctx, { error: 'invalid_token' }),
          });
        }
        await bridgeIdentity(this.#options.app, ctx, identity);
        signedIn = true;
        caller = { id: `user:${verified.id}`, via: 'session' };
        actor = verified;
      } catch (error) {
        if (error instanceof McpAuthError) {
          return this.#refuse(ctx, needed, tokenId ?? 'token', {
            status: error.status,
            error: error.message,
            challenge: this.#challenge(ctx, {
              error: error.error ?? (error.status === 403 ? 'insufficient_scope' : 'invalid_token'),
            }),
          });
        }
        // Not an authkit token: left on the request for an `authorizeByToken` console.
      }
    }
    if (caller === undefined) {
      caller =
        bearer !== undefined
          ? {
              id: tokenId ?? 'token',
              via: 'token',
            }
          : sessionCaller(ctx);
    }
    actor ??= { id: caller.id };

    // One after the other: an `authorize` may touch the shared `ctx` (auth caching, `authenticate()`).
    // The endpoint gate (libs without a console) runs at most once per request.
    let endpointDecision: DevToolsDecision | undefined;
    const decide = async (lib: RegisteredDevToolsLib): Promise<DevToolsDecision> => {
      if (lib.authorize !== undefined) return safeAuthorize(lib.authorize, ctx);
      endpointDecision ??= await this.#endpointGate(ctx);
      return endpointDecision;
    };
    const decisions: Array<{ lib: RegisteredDevToolsLib; decision: DevToolsDecision }> = [];
    for (const lib of needed) decisions.push({ lib, decision: await decide(lib) });
    const allowed = decisions.filter(({ decision }) => decision.allowed).map(({ lib }) => lib);
    if (needed.length > 0 && allowed.length === 0) {
      // A signed-in account is never sent back to the login: what is left is a 403.
      // With OAuth on, a caller with no credentials at all is sent to the login, whatever the console
      // answered: a `403` would leave an MCP client nowhere to go.
      const anonymous = bearer === undefined && caller.via === 'open' && this.oauth;
      const unauthenticated =
        !signedIn && (anonymous || decisions.some(({ decision }) => isUnauthenticated(decision)));
      return this.#refuse(
        ctx,
        needed,
        caller.id,
        unauthenticated
          ? {
              status: 401,
              error: 'unauthenticated',
              challenge: this.#challenge(
                ctx,
                bearer !== undefined ? { error: 'invalid_token' } : {},
              ),
            }
          : { status: 403, error: 'forbidden', challenge: '' },
      );
    }
    return { caller, actor, allowed };
  }

  /**
   * `devTools.authorize` for the libs without a console: the same rules as every console (omitted →
   * open outside production, `403` in production).
   */
  async #endpointGate(ctx: HttpContext): Promise<DevToolsDecision> {
    const authorize = this.#options.endpointAuthorize;
    if (authorize === undefined) {
      return this.#options.inProduction === true
        ? { allowed: false, reason: 'forbidden' }
        : { allowed: true };
    }
    let decision: ConsoleAuthorizeDecision;
    try {
      decision = await authorize(ctx);
    } catch (error) {
      return { allowed: false, reason: 'forbidden', error };
    }
    if (decision.allowed) return { allowed: true };
    return {
      allowed: false,
      reason: decision.status === 401 ? 'unauthenticated' : 'forbidden',
      ...(decision.redirectTo !== undefined ? { redirectTo: decision.redirectTo } : {}),
    };
  }

  /** `Bearer realm="agora-dev"`, plus the error and, with OAuth on, where to sign in. */
  #challenge(
    ctx: HttpContext,
    options: { error?: 'invalid_token' | 'insufficient_scope'; scope?: string },
  ): string {
    const params = ['realm="agora-dev"'];
    if (options.error !== undefined) params.push(`error="${options.error}"`);
    if (options.scope !== undefined) params.push(`scope="${options.scope}"`);
    if (this.oauth) {
      params.push(
        `resource_metadata="${protectedResourceMetadataUrl(origin(ctx), this.#options.path)}"`,
      );
    }
    return `Bearer ${params.join(', ')}`;
  }

  async #refuse(
    ctx: HttpContext,
    needed: RegisteredDevToolsLib[],
    callerId: string,
    refusal: Refusal,
  ): Promise<null> {
    const logger = await this.#options.logger();
    logger?.warn(
      {
        devTools: true,
        caller: callerId,
        libs: needed.map((lib) => lib.lib),
        status: refusal.status,
      },
      'agora dev tools: request refused',
    );
    if (refusal.challenge !== '') ctx.response.header('WWW-Authenticate', refusal.challenge);
    ctx.response.status(refusal.status).json({ error: refusal.error });
    return null;
  }

  // ── tools ─────────────────────────────────────────────────────────────────

  /**
   * This request's registry: the allowed libs' tools that are available, minus the action tools
   * `devTools.actions` does not grant this caller — so a refused action is neither listed nor callable.
   */
  async #registryFor(
    ctx: HttpContext,
    admission: Admission,
  ): Promise<{ registry: ToolRegistry; servesActions: boolean }> {
    const registry = new ToolRegistry();
    const devRole = scopeRole(AGORA_DEV_SCOPE);
    const gate = new DevToolsActionsGate(this.#options.actions, ctx, admission.caller);
    let servesActions = false;
    for (const lib of admission.allowed) {
      for (const tool of lib.tools) {
        if (tool.kind === 'action') {
          const decision = await gate.decide({
            lib: lib.lib,
            tool: tool.name,
            destructive: tool.destructive === true,
          });
          if (decision !== true) {
            if (gate.dynamic) await this.#logActionRefused(admission.caller, lib, tool, decision);
            continue;
          }
        }
        if (!(await isAvailable(tool))) continue;
        if (tool.kind === 'action') servesActions = true;
        registry.register(
          {
            name: tool.name,
            kind: tool.kind,
            description: tool.description,
            inputSchema: devToolStandardSchema(tool.input),
            roles: [devRole],
          },
          { execute: (input) => this.#run(ctx, admission.caller, lib, tool, input) },
        );
      }
    }
    return { registry, servesActions };
  }

  async #logActionRefused(
    caller: DevToolsCaller,
    lib: RegisteredDevToolsLib,
    tool: DevTool,
    refusal: DevToolsActionRefusal,
  ): Promise<void> {
    const logger = await this.#options.logger();
    logger?.debug(
      {
        devTool: tool.name,
        lib: lib.lib,
        caller: caller.id,
        reason: refusal.reason,
        ...(refusal.error !== undefined
          ? {
              error: refusal.error instanceof Error ? refusal.error.message : String(refusal.error),
            }
          : {}),
      },
      'agora dev tools: action not served',
    );
  }

  async #run(
    ctx: HttpContext,
    caller: DevToolsCaller,
    lib: RegisteredDevToolsLib,
    tool: DevTool,
    input: unknown,
  ): Promise<string> {
    const started = performance.now();
    let ok = false;
    try {
      const output = await tool.run((input ?? {}) as Record<string, unknown>, {
        ctx,
        caller,
        limits: { maxRows: DEV_TOOLS_MAX_ROWS, maxBytes: DEV_TOOLS_MAX_BYTES },
      });
      const text = capDevToolResult(redactDevToolOutput(output), DEV_TOOLS_MAX_BYTES);
      ok = true;
      return text;
    } finally {
      const ms = Math.round(performance.now() - started);
      const line = {
        devTool: tool.name,
        lib: lib.lib,
        caller: caller.id,
        kind: tool.kind,
        ok,
        ms,
        args: truncateText(JSON.stringify(redactDevToolOutput(input ?? {})), 1024),
      };
      const logger = await this.#options.logger();
      if (tool.kind === 'action') logger?.info(line, 'agora dev tool call');
      else logger?.debug(line, 'agora dev tool call');
      publishAgent('devtools.call', {
        devTool: tool.name,
        lib: lib.lib,
        caller: caller.id,
        kind: tool.kind,
        ok,
        ms,
      });
    }
  }
}

function instructionsFor(libs: RegisteredDevToolsLib[], servesActions: boolean): string {
  const titles = libs.map((lib) => lib.title);
  const what =
    titles.length > 0 ? `Tools for: ${titles.join(', ')}.` : 'No tools are available to you.';
  const acts = servesActions
    ? ' Some tools are actions that change data: confirm with the person first.'
    : ' Read-only: nothing here changes data.';
  return `Developer tools of this app's Agora libraries, as their consoles show them. ${what}${acts} List tools return { items, next }; pass next back to page.`;
}

/**
 * Run a lib's `authorize`, read the way console routes read a verdict: `true`, `{ allowed: true }`,
 * `false`, `{ allowed: false, reason }`, `{ redirectTo }` (→ unauthenticated) and a `status` all work.
 * A throw is `forbidden`.
 */
async function safeAuthorize(
  authorize: (ctx: HttpContext) => Promise<unknown>,
  ctx: HttpContext,
): Promise<DevToolsDecision> {
  try {
    const verdict: unknown = await authorize(ctx);
    const reason =
      typeof verdict === 'object' && verdict !== null
        ? (verdict as { reason?: unknown }).reason
        : undefined;
    const decision = normalizeConsoleAuthorizeResult(verdict);
    if (decision.allowed) return { allowed: true };
    const unauthenticated = decision.status === 401 || reason === 'unauthenticated';
    return {
      allowed: false,
      reason: unauthenticated ? 'unauthenticated' : 'forbidden',
      ...(decision.redirectTo !== undefined ? { redirectTo: decision.redirectTo } : {}),
    };
  } catch (error) {
    return { allowed: false, reason: 'forbidden', error };
  }
}

function isUnauthenticated(decision: DevToolsDecision): boolean {
  return !decision.allowed && decision.reason === 'unauthenticated';
}

async function isAvailable(tool: DevTool): Promise<boolean> {
  if (tool.available === undefined) return true;
  try {
    return (await tool.available()) === true;
  } catch {
    return false;
  }
}

/** A browser session a guard already authenticated (never calls `authenticate()` itself), else open. */
function sessionCaller(ctx: HttpContext): DevToolsCaller {
  try {
    const auth = (
      ctx as unknown as { auth?: { isAuthenticated?: boolean; user?: { id?: unknown } } }
    ).auth;
    const id = auth?.isAuthenticated === true ? auth.user?.id : undefined;
    if (id !== undefined && id !== null) return { id: `user:${String(id)}`, via: 'session' };
  } catch {
    // no auth on this app
  }
  return { id: 'dev-open', via: 'open' };
}

function origin(ctx: HttpContext): string {
  return `${ctx.request.protocol()}://${ctx.request.headers().host ?? 'localhost'}`;
}

function awaitFinish(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    if (res.writableEnded) return resolve();
    res.on('finish', () => resolve());
    res.on('close', () => resolve());
  });
}
