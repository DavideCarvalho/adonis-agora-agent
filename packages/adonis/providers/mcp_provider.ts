import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpContext, Router } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { personalAgentGate } from '../src/a2a/gate.js';
import { DefaultToolAuthorizer } from '../src/authorizer.js';
import { resolveConsoleAuthorize } from '../src/console-authorize.js';
import { devToolsAuthProblems } from '../src/dev-tools/auth.js';
import type { DevToolsHub } from '../src/dev-tools/contract.js';
import { csrfBlocksPath, csrfWarning } from '../src/dev-tools/csrf.js';
import { DevToolsEndpoint, type DevToolsLogger } from '../src/dev-tools/endpoint.js';
import { DevToolsHubImpl, endpointAuthorizeWarning } from '../src/dev-tools/hub.js';
import {
  DEV_TOOLS_BINDING,
  DEV_TOOLS_PATH,
  readMcpConfig,
  resolveDevTools,
} from '../src/dev-tools/resolve.js';
import { actorFromAuthInfo } from '../src/mcp/actor.js';
import type { McpAuth, McpAuthInfo } from '../src/mcp/auth.js';
import {
  authKitAuth,
  McpAuthError,
  type McpChallengeError,
  resolveMcpAuth,
} from '../src/mcp/auth.js';
import type { McpConfig, McpToolDescriber } from '../src/mcp/define_config.js';
import {
  mcpResourceUrl,
  normalizeMcpPath,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  publicOrigin,
  wwwAuthenticateChallenge,
} from '../src/mcp/discovery.js';
import { registerOAuthResource } from '../src/mcp/oauth-resource.js';
import { missingScopes } from '../src/mcp/scope.js';
import { createMcpServer, isExposable } from '../src/mcp/server.js';
import type { RolesPolicy } from '../src/spi/roles-policy.js';
import { ToolRegistry } from '../src/tool-registry.js';

declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    /** The dev tools hub every `@adonis-agora` lib registers its developer tools into. */
    'agora.devTools': DevToolsHub;
  }
}

/**
 * Wires the agent's {@link ToolRegistry} to the outside world over the Model Context Protocol
 * (Streamable HTTP). Reads `config/mcp.ts` and mounts:
 *
 * - `POST|GET|DELETE {path}` — the MCP endpoint (initialize/session resume, SSE stream, close).
 * - `GET /.well-known/oauth-protected-resource{path}` — RFC 9728 protected-resource metadata, mounted
 *   only when `auth.oauth` is set, so MCP clients can discover how to authenticate.
 *
 * …once for the top-level config and once per entry of `endpoints`: each is a protected resource of
 * its own, with its registry, auth, sessions and metadata.
 *
 * A refused request answers `401` (or `403` for an {@link McpAuthError} with that status) with a
 * `WWW-Authenticate: Bearer …` challenge; with OAuth it carries `resource_metadata`, which is what makes
 * an MCP client discover the authorization server and open the login. URLs are built from
 * `config.publicUrl` when set, else from the request's protocol and `Host`.
 *
 * Every request is authenticated: the bearer token is verified via `config.auth` (e.g. `authKitAuth()`),
 * the resolved actor attached to the transport's `AuthInfo`, and `tools/list` / `tools/call` run against
 * the SAME `ToolRegistry` singleton the agent loop uses — so a role-checked tool stays role-checked, and
 * a fail-closed gate stays fail-closed, no matter the surface.
 */
export default class McpProvider {
  /** Every mounted endpoint — the top-level one first. */
  readonly #endpoints: Endpoint[] = [];
  /** `config.publicUrl` reduced to its origin; `undefined` → derive it from each request. */
  #publicOrigin: string | undefined;

  /** The dev tools hub, bound in `register()` unless `devTools: false`. */
  #devToolsHub: DevToolsHubImpl | undefined;
  #devToolsEndpoint: DevToolsEndpoint | undefined;

  constructor(protected app: ApplicationService) {}

  /**
   * Bind the dev tools hub (`'agora.devTools'`). Every provider's `register()` runs before any
   * `boot()`, so a lib finds it from its own `boot()` whatever the order in `adonisrc.ts`.
   */
  register() {
    const devTools = resolveDevTools(readMcpConfig(this.app));
    if (devTools === null) return;
    const hub = new DevToolsHubImpl({ exclude: devTools.exclude });
    this.#devToolsHub = hub;
    this.app.container.bindValue(DEV_TOOLS_BINDING, hub);
  }

  async boot() {
    const config = readMcpConfig(this.app);
    const defaultRoles = config.defaultRoles ?? ['ADMIN'];
    // Personal agents (a Poppy session's token, see `authKitAuth`) reach only the tools of the scopes
    // their user granted — the same gate as the agent loop. A no-op for every other actor.
    const authorizer = personalAgentGate(
      config.authorizer ??
        new DefaultToolAuthorizer(defaultRoles, { emptyRoles: config.emptyRoles ?? 'allow' }),
    );
    const ctx = { app: this.app };
    const auth = config.auth !== undefined ? await resolveMcpAuth(config.auth, ctx) : undefined;
    this.#publicOrigin =
      config.publicUrl !== undefined ? publicOrigin(config.publicUrl) : undefined;

    const base: Endpoint = {
      path: normalizeMcpPath(config.path),
      name: config.name,
      version: config.version,
      ...(config.instructions !== undefined ? { instructions: config.instructions } : {}),
      registry: await this.app.container.make(ToolRegistry),
      authorizer,
      auth,
      // The actor fallback for open/dev mode (no `auth`): a fixed identity, or fail-closed (reject).
      openActor: config.actor,
      ...(config.allowedTools !== undefined ? { allowedTools: config.allowedTools } : {}),
      ...(config.actions !== undefined ? { actions: config.actions } : {}),
      ...(config.describeTool !== undefined ? { describeTool: config.describeTool } : {}),
      stateless: config.stateless === true,
      metadataRouteName: 'mcp.oauth_protected_resource',
      transports: new Map(),
    };
    this.#endpoints.push(base);
    for (const extra of config.endpoints ?? []) {
      const path = normalizeMcpPath(extra.path);
      this.#endpoints.push({
        ...base,
        path,
        name: extra.name ?? base.name,
        ...(extra.instructions !== undefined ? { instructions: extra.instructions } : {}),
        registry: extra.registry ? await extra.registry(ctx) : base.registry,
        auth: extra.auth !== undefined ? await resolveMcpAuth(extra.auth, ctx) : base.auth,
        ...(extra.allowedTools !== undefined ? { allowedTools: extra.allowedTools } : {}),
        ...(extra.actions !== undefined ? { actions: extra.actions } : {}),
        ...(extra.describeTool !== undefined ? { describeTool: extra.describeTool } : {}),
        metadataRouteName:
          extra.metadataRouteName ?? `mcp.${path.split('/').join('.')}.oauth_protected_resource`,
        transports: new Map(),
      });
    }

    const router = await this.app.container.make('router');
    const middleware = config.middleware ?? [];
    for (const endpoint of this.#endpoints) {
      const route = `/${endpoint.path}`;
      const routes = [
        router.post(route, (c: HttpContext) => this.#handlePost(c, endpoint)),
        router.get(route, (c: HttpContext) =>
          endpoint.stateless ? this.#methodNotAllowed(c, endpoint) : this.#handleGet(c, endpoint),
        ),
        router.delete(route, (c: HttpContext) =>
          endpoint.stateless
            ? this.#methodNotAllowed(c, endpoint)
            : this.#handleDelete(c, endpoint),
        ),
      ];
      if (middleware.length > 0) for (const r of routes) r.use(middleware);

      const oauth = endpoint.auth?.oauth;
      if (oauth) {
        // Announce this server to the authorization server in the same process (authkit's `mcp`):
        // tokens it issues for this URL are then bound to it, with no URL repeated in its config.
        registerOAuthResource(
          this.#publicOrigin !== undefined
            ? { url: mcpResourceUrl(this.#publicOrigin, endpoint.path) }
            : { path: `/${endpoint.path}` },
        );
        router
          .get(`/.well-known/oauth-protected-resource/${endpoint.path}`, async (c: HttpContext) => {
            // `oauth` may be lazy (authkit needs a fully booted app to resolve) — resolve it on request.
            const meta = typeof oauth === 'function' ? await oauth() : oauth;
            // Public and user-free; MCP clients running in a browser fetch it cross-origin.
            c.response.header('access-control-allow-origin', '*');
            return c.response.json(protectedResourceMetadata(meta, this.#origin(c), endpoint.path));
          })
          .as(endpoint.metadataRouteName);
      }
    }

    await this.#mountDevTools(config, router);
  }

  /**
   * Mount the dev tools endpoint: its own route, auth flow and (with authkit) protected resource.
   * Nothing of the product endpoints is inherited.
   */
  async #mountDevTools(config: McpConfig, router: Router): Promise<void> {
    const hub = this.#devToolsHub;
    const devTools = resolveDevTools(config);
    if (hub === undefined || devTools === null) return;
    const path = devTools.path;
    const taken = this.#endpoints.find((endpoint) => endpoint.path === path);
    if (taken !== undefined) {
      throw new Error(
        `[@adonis-agora/agent] devTools.path "${path}" in config/mcp.ts is already an MCP endpoint's path: pick another one (default "${DEV_TOOLS_PATH}").`,
      );
    }
    // `devTools.auth` (any authorization server) wins; else, with authkit in the app, a person signs
    // in through the standard MCP OAuth flow. Either way the endpoint is a protected resource of its
    // own: a token for the product endpoint is refused here, and back.
    const auth = devTools.auth;
    if (auth !== undefined) {
      const { errors, warnings } = devToolsAuthProblems(auth);
      if (errors.length > 0) {
        throw new Error(`[@adonis-agora/agent] config/mcp.ts: ${errors.join(' ')}`);
      }
      for (const warning of warnings) console.warn(`[@adonis-agora/agent] ${warning}`);
    }
    const hasAuthkit = this.app.container.hasBinding('authkit.server' as never);
    const authkit =
      auth === undefined && hasAuthkit
        ? await resolveMcpAuth(authKitAuth({ resourceName: 'Agora dev tools' }), { app: this.app })
        : undefined;
    let logger: DevToolsLogger | undefined;
    const endpoint = new DevToolsEndpoint({
      app: this.app,
      hub,
      path,
      actions: devTools.actions,
      authkit,
      auth,
      version: config.version ?? '1.0.0',
      ...(devTools.authorize !== undefined
        ? { endpointAuthorize: resolveConsoleAuthorize(devTools.authorize) }
        : {}),
      inProduction: this.app.inProduction,
      logger: async () => {
        if (logger === undefined) {
          try {
            logger = (await this.app.container.make('logger')) as unknown as DevToolsLogger;
          } catch {
            return undefined;
          }
        }
        return logger;
      },
    });
    this.#devToolsEndpoint = endpoint;

    const route = `/${path}`;
    const routes = [
      router.post(route, (c: HttpContext) => endpoint.handlePost(c)),
      router.get(route, (c: HttpContext) => endpoint.methodNotAllowed(c)),
      router.delete(route, (c: HttpContext) => endpoint.methodNotAllowed(c)),
    ];
    const middleware = devTools.middleware;
    if (middleware.length > 0) for (const r of routes) r.use(middleware);
    if (authkit !== undefined) {
      // By path: the dev endpoint has no `publicUrl` of its own; the issuer's origin is the app's.
      registerOAuthResource({ path: route });
    }
    if (endpoint.oauth) {
      router
        .get(`/.well-known/oauth-protected-resource/${path}`, (c: HttpContext) =>
          endpoint.metadata(c),
        )
        .as('mcp.agora_dev_tools.oauth_protected_resource');
    }

    const shield = this.app.config.get<unknown>('shield', undefined);
    const blocked = csrfBlocksPath(shield, path);
    if (blocked !== false) console.warn(csrfWarning(path, blocked));
  }

  /** Say once, when the app is up, which libs serve dev tools (every lib has booted by now). */
  async ready() {
    const hub = this.#devToolsHub;
    const endpoint = this.#devToolsEndpoint;
    if (hub === undefined || endpoint === undefined) return;
    if (this.app.getEnvironment() !== 'web') return;
    const libs = hub.servedLibs().map((lib) => `${lib.lib} (${lib.tools.length})`);
    console.info(
      `[@adonis-agora/agent] dev tools at /${endpoint.path}: ${libs.length > 0 ? libs.join(', ') : 'no lib registered tools'}`,
    );
    const warning = endpointAuthorizeWarning(
      hub.endpointGatedLibs().map((lib) => lib.lib),
      resolveDevTools(readMcpConfig(this.app))?.authorize,
    );
    if (warning !== undefined) console.warn(warning);
  }

  async shutdown() {
    const transports = this.#endpoints.flatMap((endpoint) => [...endpoint.transports.values()]);
    await Promise.all(transports.map((transport) => transport.close()));
    for (const endpoint of this.#endpoints) endpoint.transports.clear();
  }

  // ── auth helpers ──────────────────────────────────────────────────────────

  /** The public origin: `config.publicUrl` when set, else the request's own protocol and `Host`. */
  #origin(ctx: HttpContext): string {
    return (
      this.#publicOrigin ??
      `${ctx.request.protocol()}://${ctx.request.headers().host ?? 'localhost'}`
    );
  }

  /**
   * Refuse the request with `status` and the RFC 6750 / RFC 9728 challenge. `hadToken` picks the error
   * code (no token → none, per RFC 6750 §3.1); `resource_metadata` is added when the auth exposes OAuth.
   * With no auth (the fail-closed open-mode path) it is still a bare `Bearer` challenge.
   */
  #refuse(
    ctx: HttpContext,
    endpoint: Endpoint,
    status: 401 | 403,
    message: string,
    hadToken: boolean,
    scope?: string,
    error?: McpChallengeError,
  ): null {
    const challenge = wwwAuthenticateChallenge({
      ...(error !== undefined
        ? { error }
        : status === 403
          ? { error: 'insufficient_scope' as const, ...(scope !== undefined ? { scope } : {}) }
          : hadToken
            ? { error: 'invalid_token' as const }
            : {}),
      ...(endpoint.auth?.oauth !== undefined
        ? { resourceMetadataUrl: protectedResourceMetadataUrl(this.#origin(ctx), endpoint.path) }
        : {}),
    });
    ctx.response.header('WWW-Authenticate', challenge);
    ctx.response.status(status).json({ error: message });
    return null;
  }

  /**
   * Verify the request's `Authorization: Bearer` token against the endpoint's auth, or fall back to
   * the open-mode `actor`. Returns the `AuthInfo` to attach to the transport, or `null` once it has
   * replied 401/403.
   */
  async #authenticate(ctx: HttpContext, endpoint: Endpoint): Promise<McpAuthInfo | null> {
    const header = ctx.request.header('authorization');
    const token = /^Bearer\s/i.test(header ?? '') ? header?.slice(7).trim() : undefined;
    const auth = endpoint.auth;
    if (auth !== undefined) {
      if (!token) {
        return this.#refuse(ctx, endpoint, 401, 'missing bearer token', false);
      }
      try {
        return await auth.verify(token, {
          resource: mcpResourceUrl(this.#origin(ctx), endpoint.path),
        });
      } catch (error) {
        const status = error instanceof McpAuthError ? error.status : 401;
        const message = error instanceof Error ? error.message : 'unauthorized';
        const code = error instanceof McpAuthError ? error.error : undefined;
        return this.#refuse(ctx, endpoint, status, message, true, undefined, code);
      }
    }
    if (endpoint.openActor !== undefined) {
      return { token: '', clientId: '', scopes: [], extra: { actor: endpoint.openActor } };
    }
    return this.#refuse(
      ctx,
      endpoint,
      401,
      'unauthorized: no auth configured and no fallback actor',
      false,
    );
  }

  /**
   * A personal agent calling a tool it is offered but whose scope its user did not grant: `403` with
   * `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` (RFC 6750 §3.1, the MCP scope
   * step-up, Poppy §4.3) instead of a tool error — the client asks the user for that scope. Returns
   * `true` once it has replied.
   */
  async #refuseMissingScope(
    ctx: HttpContext,
    endpoint: Endpoint,
    authInfo: McpAuthInfo,
    body: unknown,
  ): Promise<boolean> {
    const messages = Array.isArray(body) ? body : [body];
    const actor = authInfo.extra.actor;
    for (const message of messages) {
      const call = message as { method?: unknown; params?: { name?: unknown } } | null;
      if (call?.method !== 'tools/call' || typeof call.params?.name !== 'string') continue;
      const spec = endpoint.registry.spec(call.params.name);
      // Only a tool this server serves: anything else stays the server's "unknown tool".
      if (!isExposable(spec, endpoint.actions ?? 'refuse') || spec === undefined) continue;
      if (endpoint.allowedTools !== undefined && !endpoint.allowedTools.includes(spec.name))
        continue;
      const missing = await missingScopes(actor, spec, endpoint.authorizer);
      if (missing !== null) {
        this.#refuse(
          ctx,
          endpoint,
          403,
          `insufficient_scope: "${spec.name}" needs the scope "${missing.join(' ')}"`,
          true,
          missing.join(' '),
        );
        return true;
      }
    }
    return false;
  }

  // ── route handlers ────────────────────────────────────────────────────────

  #newServer(endpoint: Endpoint) {
    return createMcpServer({
      name: endpoint.name,
      version: endpoint.version,
      ...(endpoint.instructions !== undefined ? { instructions: endpoint.instructions } : {}),
      registry: endpoint.registry,
      policy: endpoint.authorizer,
      ...(endpoint.allowedTools !== undefined ? { allowedTools: endpoint.allowedTools } : {}),
      ...(endpoint.actions !== undefined ? { actions: endpoint.actions } : {}),
      ...(endpoint.describeTool !== undefined ? { describeTool: endpoint.describeTool } : {}),
      actorFromAuth: actorFromAuthInfo,
    });
  }

  async #handlePost(ctx: HttpContext, endpoint: Endpoint): Promise<void> {
    const req = ctx.request.request as IncomingMessage & { auth?: AuthInfo };
    const res = ctx.response.response;
    const body = ctx.request.all();
    const sessionId = ctx.request.header('mcp-session-id');

    const authInfo = await this.#authenticate(ctx, endpoint);
    if (authInfo === null) return;
    req.auth = authInfo;
    if (await this.#refuseMissingScope(ctx, endpoint, authInfo, body)) return;

    try {
      let transport: StreamableHTTPServerTransport | undefined;
      if (endpoint.stateless) {
        // No session: this request gets its own transport and server, closed once answered — and a
        // plain JSON answer, since there is no stream to keep open.
        const stateless = new StreamableHTTPServerTransport({ enableJsonResponse: true });
        const server = this.#newServer(endpoint);
        res.on('close', () => {
          void stateless.close();
          void server.close();
        });
        await server.connect(stateless as Transport);
        await stateless.handleRequest(req, res, body);
      } else if (sessionId && endpoint.transports.has(sessionId)) {
        // Session resume — reuse the existing transport (already connected to its own server).
        transport = endpoint.transports.get(sessionId)!;
        await transport.handleRequest(req, res, body);
      } else if (!sessionId && isInitializeRequest(body)) {
        // New session — create transport + server, connect, then handle so responses flow through it.
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            if (transport) endpoint.transports.set(sid, transport);
          },
        });
        transport.onclose = () => {
          const sid = transport?.sessionId;
          if (sid && endpoint.transports.get(sid) === transport) {
            endpoint.transports.delete(sid);
          }
        };
        const server = this.#newServer(endpoint);
        await server.connect(transport as Transport);
        await transport.handleRequest(req, res, body);
      } else {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: no valid session ID' },
            id: null,
          }),
        );
      }
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
    await this.#awaitFinish(res);
  }

  async #handleGet(ctx: HttpContext, endpoint: Endpoint): Promise<void> {
    const req = ctx.request.request as IncomingMessage & { auth?: AuthInfo };
    const res = ctx.response.response;
    const sessionId = ctx.request.header('mcp-session-id');

    const authInfo = await this.#authenticate(ctx, endpoint);
    if (authInfo === null) return;
    req.auth = authInfo;

    const transport = sessionId ? endpoint.transports.get(sessionId) : undefined;
    if (transport === undefined) {
      res.statusCode = 400;
      res.end('Invalid or missing session ID');
      await this.#awaitFinish(res);
      return;
    }
    await transport.handleRequest(req, res);
    await this.#awaitFinish(res);
  }

  async #handleDelete(ctx: HttpContext, endpoint: Endpoint): Promise<void> {
    const req = ctx.request.request as IncomingMessage & { auth?: AuthInfo };
    const res = ctx.response.response;
    const sessionId = ctx.request.header('mcp-session-id');

    const authInfo = await this.#authenticate(ctx, endpoint);
    if (authInfo === null) return;
    req.auth = authInfo;

    const transport = sessionId ? endpoint.transports.get(sessionId) : undefined;
    if (transport === undefined) {
      res.statusCode = 400;
      res.end('Invalid or missing session ID');
      await this.#awaitFinish(res);
      return;
    }
    await transport.handleRequest(req, res);
    await this.#awaitFinish(res);
  }

  /**
   * Stateless mode has no SSE stream to open and no session to close (MCP Streamable HTTP §2.2).
   * Authenticated first: an unauthenticated caller gets the 401 that starts its login, not a 405.
   */
  async #methodNotAllowed(ctx: HttpContext, endpoint: Endpoint) {
    if ((await this.#authenticate(ctx, endpoint)) === null) return;
    ctx.response.header('allow', 'POST');
    return ctx.response.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this MCP server is stateless.' },
      id: null,
    });
  }

  /** Resolve only when the raw response is finished so Adonis doesn't try to handle the response again. */
  #awaitFinish(res: ServerResponse): Promise<void> {
    return new Promise((resolve) => {
      res.on('finish', () => resolve());
      res.on('close', () => resolve());
    });
  }
}

/** One mounted MCP server: the top-level config, or an entry of `endpoints`, resolved at boot. */
interface Endpoint {
  path: string;
  name: string;
  version: string;
  instructions?: string;
  registry: ToolRegistry;
  authorizer: RolesPolicy;
  auth: McpAuth | undefined;
  openActor: McpConfig['actor'];
  allowedTools?: string[];
  actions?: 'refuse' | 'execute';
  describeTool?: McpToolDescriber;
  stateless: boolean;
  metadataRouteName: string;
  /** Live session transports, keyed by MCP session id (in-memory; unused when stateless). */
  transports: Map<string, StreamableHTTPServerTransport>;
}
