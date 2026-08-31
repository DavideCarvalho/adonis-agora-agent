import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { DefaultToolAuthorizer } from '../src/authorizer.js';
import { actorFromAuthInfo } from '../src/mcp/actor.js';
import type { McpAuth, McpAuthInfo } from '../src/mcp/auth.js';
import { resolveMcpAuth } from '../src/mcp/auth.js';
import type { McpConfig } from '../src/mcp/define_config.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { RolesPolicy } from '../src/spi/roles-policy.js';
import { ToolRegistry } from '../src/tool-registry.js';

/**
 * Wires the agent's {@link ToolRegistry} to the outside world over the Model Context Protocol
 * (Streamable HTTP). Reads `config/mcp.ts` and mounts:
 *
 * - `POST|GET|DELETE {path}` — the MCP endpoint (initialize/session resume, SSE stream, close).
 * - `GET /.well-known/oauth-protected-resource{path}` — RFC 9728 protected-resource metadata, mounted
 *   only when `auth.oauth` is set, so MCP clients can discover how to authenticate.
 *
 * Every request is authenticated: the bearer token is verified via `config.auth` (e.g. `authKitAuth()`),
 * the resolved actor attached to the transport's `AuthInfo`, and `tools/list` / `tools/call` run against
 * the SAME `ToolRegistry` singleton the agent loop uses — so a role-checked tool stays role-checked, and
 * a fail-closed gate stays fail-closed, no matter the surface.
 */
export default class McpProvider {
  /** Live session transports, keyed by MCP session id (per-provider in-memory state). */
  readonly #transports = new Map<string, StreamableHTTPServerTransport>();

  constructor(protected app: ApplicationService) {}

  async boot() {
    const config = this.app.config.get<McpConfig>('mcp', {} as McpConfig);
    const registry = await this.app.container.make(ToolRegistry);
    const defaultRoles = config.defaultRoles ?? ['ADMIN'];
    const authorizer = config.authorizer ?? new DefaultToolAuthorizer(defaultRoles);
    const auth =
      config.auth !== undefined ? await resolveMcpAuth(config.auth, { app: this.app }) : undefined;

    // The actor fallback for open/dev mode (no `auth`): a fixed identity, or fail-closed (reject).
    const openActor = config.actor;

    const router = await this.app.container.make('router');
    const path = (config.path ?? 'mcp').replace(/^\/+|\/+$/g, '');

    const route = `/${path}`;
    router.post(route, (ctx: HttpContext) =>
      this.#handlePost(ctx, config, registry, authorizer, auth, openActor),
    );
    router.get(route, (ctx: HttpContext) => this.#handleGet(ctx, auth, openActor));
    router.delete(route, (ctx: HttpContext) => this.#handleDelete(ctx, auth, openActor));

    if (auth?.oauth) {
      const oauth = auth.oauth;
      const metadataPath = `/.well-known/oauth-protected-resource/${path}`;
      router.get(metadataPath, async (ctx: HttpContext) => {
        // `oauth` may be lazy (authkit needs a fully booted app to resolve) — resolve it on request.
        const meta = typeof oauth === 'function' ? await oauth() : oauth;
        const origin = `${ctx.request.protocol()}://${ctx.request.headers().host ?? 'localhost'}`;
        return ctx.response.json({
          resource: `${origin}/${path}`,
          authorization_servers: [meta.issuer],
          scopes_supported: meta.scopesSupported,
          resource_name: meta.resourceName,
        });
      });
    }
  }

  async shutdown() {
    await Promise.all([...this.#transports.values()].map((transport) => transport.close()));
    this.#transports.clear();
  }

  // ── auth helpers ──────────────────────────────────────────────────────────

  /**
   * Verify the request's `Authorization: Bearer` token against the configured auth, or fall back to the
   * open-mode `actor`. Returns the `AuthInfo` to attach to the transport, or `null` to reply 401.
   */
  async #authenticate(
    ctx: HttpContext,
    auth: McpAuth | undefined,
    openActor: McpConfig['actor'],
  ): Promise<McpAuthInfo | null> {
    const header = ctx.request.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (auth !== undefined) {
      if (!token) {
        ctx.response.status(401).json({ error: 'missing bearer token' });
        return null;
      }
      try {
        return await auth.verify(token);
      } catch (error) {
        ctx.response
          .status(401)
          .json({ error: error instanceof Error ? error.message : 'unauthorized' });
        return null;
      }
    }
    if (openActor !== undefined) {
      return { token: '', clientId: '', scopes: [], extra: { actor: openActor } };
    }
    ctx.response
      .status(401)
      .json({ error: 'unauthorized: no auth configured and no fallback actor' });
    return null;
  }

  // ── route handlers ────────────────────────────────────────────────────────

  async #handlePost(
    ctx: HttpContext,
    config: McpConfig,
    registry: ToolRegistry,
    authorizer: RolesPolicy,
    auth: McpAuth | undefined,
    openActor: McpConfig['actor'],
  ): Promise<void> {
    const req = ctx.request.request as IncomingMessage & { auth?: AuthInfo };
    const res = ctx.response.response;
    const body = ctx.request.all();
    const sessionId = ctx.request.header('mcp-session-id');

    const authInfo = await this.#authenticate(ctx, auth, openActor);
    if (authInfo === null) return;
    req.auth = authInfo;

    try {
      let transport: StreamableHTTPServerTransport | undefined;
      if (sessionId && this.#transports.has(sessionId)) {
        // Session resume — reuse the existing transport (already connected to its own server).
        transport = this.#transports.get(sessionId)!;
        await transport.handleRequest(req, res, body);
      } else if (!sessionId && isInitializeRequest(body)) {
        // New session — create transport + server, connect, then handle so responses flow through it.
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            if (transport) this.#transports.set(sid, transport);
          },
        });
        transport.onclose = () => {
          const sid = transport?.sessionId;
          if (sid && this.#transports.get(sid) === transport) {
            this.#transports.delete(sid);
          }
        };
        const server = createMcpServer({
          name: config.name,
          version: config.version,
          registry,
          policy: authorizer,
          ...(config.allowedTools !== undefined ? { allowedTools: config.allowedTools } : {}),
          actorFromAuth: actorFromAuthInfo,
        });
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

  async #handleGet(
    ctx: HttpContext,
    auth: McpAuth | undefined,
    openActor: McpConfig['actor'],
  ): Promise<void> {
    const req = ctx.request.request as IncomingMessage & { auth?: AuthInfo };
    const res = ctx.response.response;
    const sessionId = ctx.request.header('mcp-session-id');

    const authInfo = await this.#authenticate(ctx, auth, openActor);
    if (authInfo === null) return;
    req.auth = authInfo;

    const transport = sessionId ? this.#transports.get(sessionId) : undefined;
    if (transport === undefined) {
      res.statusCode = 400;
      res.end('Invalid or missing session ID');
      await this.#awaitFinish(res);
      return;
    }
    await transport.handleRequest(req, res);
    await this.#awaitFinish(res);
  }

  async #handleDelete(
    ctx: HttpContext,
    auth: McpAuth | undefined,
    openActor: McpConfig['actor'],
  ): Promise<void> {
    const req = ctx.request.request as IncomingMessage & { auth?: AuthInfo };
    const res = ctx.response.response;
    const sessionId = ctx.request.header('mcp-session-id');

    const authInfo = await this.#authenticate(ctx, auth, openActor);
    if (authInfo === null) return;
    req.auth = authInfo;

    const transport = sessionId ? this.#transports.get(sessionId) : undefined;
    if (transport === undefined) {
      res.statusCode = 400;
      res.end('Invalid or missing session ID');
      await this.#awaitFinish(res);
      return;
    }
    await transport.handleRequest(req, res);
    await this.#awaitFinish(res);
  }

  /** Resolve only when the raw response is finished so Adonis doesn't try to handle the response again. */
  #awaitFinish(res: ServerResponse): Promise<void> {
    return new Promise((resolve) => {
      res.on('finish', () => resolve());
      res.on('close', () => resolve());
    });
  }
}
