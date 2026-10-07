import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpContext } from '@adonisjs/core/http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AnyObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  REMEMBER_TOOL_DESCRIPTION,
  REMEMBER_TOOL_NAME,
  rememberInputSchema,
  writeMemory,
} from '../memory.js';
import { defaultScopeResolver } from '../skills.js';
import type { ProtocolAdapter } from '../spi/protocol-adapter.js';
import type { AiToolCtx } from '../spi/tool.js';
import { ToolNotFoundError } from '../tool-registry.js';
import type { Actor, AgentRunInput } from '../types.js';
import { errorText } from './log.js';
import type { OpenCodeCallContext, OpenCodeTurns } from './turns.js';

/** What a tools token says: whose turns it may serve, on which OpenCode server, until when. */
export interface OpenCodeToolsClaims {
  v: 1;
  actor: Actor;
  /** The OpenCode server key (`OpenCodeServer.key`) the token was registered on. */
  server: string;
  /** Epoch ms after which the token is refused. */
  exp: number;
}

/** Kinds the LOOP serves; a registry entry of one of them cannot be honoured over MCP. */
const LOOP_SERVED_KINDS = new Set(['agent', 'ask', 'skill', 'memory']);

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

/**
 * Signs and checks the bearer tokens the engine registers its tools endpoint with (`mcp.add`). A
 * token names an actor and an OpenCode server, and expires; it is HMAC-SHA256 over its claims with
 * a key derived from the configured secret (or the app's `APP_KEY`).
 *
 * A token on its own runs nothing: the endpoint also needs the call to come from a session that is
 * running a turn of that actor right now (see `OpenCodeTurns.callContext`), and an `action` tool
 * needs an approval the turn granted (see `OpenCodeTurns.spendApproval`).
 */
export class OpenCodeToolsTokens {
  private readonly key: Buffer;

  constructor(
    secret: string | undefined,
    private readonly ttlMs: number,
  ) {
    this.key = createHash('sha256')
      .update('agora:opencode:tools\0')
      .update(secret ?? randomBytes(32).toString('hex'))
      .digest();
  }

  mint(actor: Actor, server: string, now = Date.now()): string {
    const claims: OpenCodeToolsClaims = { v: 1, actor, server, exp: now + this.ttlMs };
    const body = b64url(JSON.stringify(claims));
    return `${body}.${this.sign(body)}`;
  }

  verify(token: string, now = Date.now()): OpenCodeToolsClaims | null {
    const [body, signature, extra] = token.split('.');
    if (body === undefined || signature === undefined || extra !== undefined) return null;
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as
        | Partial<OpenCodeToolsClaims>
        | undefined;
      if (
        claims?.v !== 1 ||
        typeof claims.server !== 'string' ||
        typeof claims.exp !== 'number' ||
        typeof claims.actor?.id !== 'string' ||
        claims.exp <= now
      ) {
        return null;
      }
      return claims as OpenCodeToolsClaims;
    } catch {
      return null;
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
}

/** True for a Zod schema (its Standard Schema props say `vendor: 'zod'`). */
function isZodSchema(schema: StandardSchemaV1): schema is AnyObjectSchema {
  return schema['~standard'].vendor === 'zod';
}

/** A tool's input schema as the JSON Schema MCP clients read — as the `config/mcp.ts` surface does. */
function toJsonSchema(schema: StandardSchemaV1): Record<string, unknown> {
  if (isZodSchema(schema)) return toJsonSchemaCompat(schema);
  const converter = (schema['~standard'] as { jsonSchema?: { input?: unknown } }).jsonSchema;
  if (typeof converter?.input === 'function') {
    return (converter.input as () => Record<string, unknown>)();
  }
  return { type: 'object', properties: {}, additionalProperties: true };
}

const asText = (output: unknown) => (typeof output === 'string' ? output : JSON.stringify(output));

class RefusedError extends Error {}

/**
 * The MCP endpoint OpenCode sessions reach the app's tools through — `POST <agent path>/opencode/mcp`,
 * mounted by the engine when `tools` is set. Stateless Streamable HTTP (one server per request), so
 * it answers from any process.
 *
 * - `tools/list`: the registry's tools the token's actor may reach (roles, `enabled`, `canUse`), the
 *   kinds only the loop serves left out; with `_meta` naming a running turn, its agent's allow-list
 *   too. Plus `remember`, when the agent's memory provider writes.
 * - `tools/call`: only for a call `_meta` ties to a turn of the token's actor running on that
 *   session; the turn's allow-list and the registry's own checks apply, an `action` runs only against
 *   an approval the turn granted, and the tool's `ctx` is the turn's (thread, run, `emitUi` into its
 *   stream and message).
 */
export class OpenCodeMcpEndpoint {
  constructor(
    private readonly turns: OpenCodeTurns,
    private readonly tokens: OpenCodeToolsTokens,
  ) {}

  /** Mounts the endpoint next to the agent's routes. */
  adapter(): ProtocolAdapter {
    return {
      name: 'opencode-mcp',
      mount: (host) => {
        host.post('opencode/mcp', (ctx) => this.handle(ctx));
        // Stateless: no server-sent stream to resume, no session to close.
        host.get('opencode/mcp', (ctx) =>
          ctx.response.status(405).header('allow', 'POST').json({ error: 'method not allowed' }),
        );
      },
    };
  }

  /** The claims of a request's bearer token, or `null`. */
  authenticate(authorization: string | undefined): OpenCodeToolsClaims | null {
    const token = /^Bearer\s+/i.test(authorization ?? '')
      ? authorization?.replace(/^Bearer\s+/i, '').trim()
      : undefined;
    return token ? this.tokens.verify(token) : null;
  }

  async handle(ctx: HttpContext): Promise<void> {
    const claims = this.authenticate(ctx.request.header('authorization'));
    if (claims === null) {
      ctx.response.header('WWW-Authenticate', 'Bearer error="invalid_token"');
      ctx.response.status(401).json({ error: 'unauthorized' });
      return;
    }
    const req = ctx.request.request as IncomingMessage;
    const res = ctx.response.response as ServerResponse;
    const server = this.server(claims);
    // No `sessionIdGenerator`: stateless, so any process answers any request.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport as Transport);
      await transport.handleRequest(req, res, ctx.request.body());
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: errorText(error, 'Internal error') },
            id: null,
          }),
        );
      }
    }
    await new Promise<void>((resolve) => {
      if (res.writableFinished) return resolve();
      res.on('finish', () => resolve());
      res.on('close', () => resolve());
    });
  }

  /** One MCP server for one request, answering as the token's actor. */
  server(claims: OpenCodeToolsClaims): Server {
    const server = new Server(
      { name: 'agora-opencode', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    const { actor } = claims;
    const call = (meta: unknown, requestId: unknown) =>
      this.turns.callContext({
        actor,
        serverKey: claims.server,
        requestId: String(requestId ?? ''),
        meta: meta as Readonly<Record<string, unknown>> | undefined,
      });

    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      const turn = await call(request.params?._meta, extra.requestId);
      const input: Pick<AgentRunInput, 'agentName'> = turn?.input ?? {};
      const deps = this.turns.depsFor(input);
      const allowed = turn !== undefined ? this.turns.allowedTools(turn.input) : undefined;
      const definitions = (
        await this.turns.registry.definitionsFor(actor, deps.rolesPolicy, allowed)
      ).filter((definition) => !LOOP_SERVED_KINDS.has(definition.kind));
      const tools = definitions.map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: toJsonSchema(definition.inputSchema),
      }));
      if (this.turns.memoryWritable(input)) {
        tools.push({
          name: REMEMBER_TOOL_NAME,
          description: REMEMBER_TOOL_DESCRIPTION,
          inputSchema: toJsonSchema(rememberInputSchema),
        });
      }
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      try {
        const turn = await call(request.params._meta, extra.requestId);
        if (turn === undefined) {
          throw new RefusedError(
            'This endpoint serves OpenCode turns: no turn of yours is running on this session.',
          );
        }
        const output =
          name === REMEMBER_TOOL_NAME && this.turns.memoryWritable(turn.input)
            ? await this.remember(turn, args)
            : await this.invoke(turn, actor, name, args, String(extra.requestId ?? ''));
        return { content: [{ type: 'text' as const, text: asText(output) }] };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: errorText(error, 'the tool failed') }],
          isError: true,
        };
      }
    });
    return server;
  }

  private async invoke(
    turn: OpenCodeCallContext,
    actor: Actor,
    name: string,
    args: unknown,
    requestId: string,
  ): Promise<unknown> {
    const spec = this.turns.registry.spec(name);
    if (spec === undefined || LOOP_SERVED_KINDS.has(spec.kind)) throw new ToolNotFoundError(name);
    const allowed = this.turns.allowedTools(turn.input);
    if (allowed !== undefined && !allowed.includes(name)) throw new ToolNotFoundError(name);
    if (
      spec.kind === 'action' &&
      !(await this.turns.spendApproval(turn.runId, turn.ctx.threadId, name))
    ) {
      throw new RefusedError(
        `"${name}" is an action and nobody approved this call; ask for the permission first.`,
      );
    }
    const deps = this.turns.depsFor(turn.input);
    const ctx: AiToolCtx = {
      actor,
      threadId: turn.ctx.threadId,
      runId: turn.runId,
      requestId: `mcp:${turn.runId}:${requestId}`,
      emitUi: turn.ctx.emitUi,
      ...(turn.ctx.agentName !== undefined ? { agentName: turn.ctx.agentName } : {}),
      ...(turn.input.pageContext !== undefined ? { pageContext: turn.input.pageContext } : {}),
    };
    return this.turns.registry.invoke(
      name,
      args ?? {},
      ctx,
      deps.rolesPolicy,
      allowed !== undefined ? { allowedTools: allowed } : {},
    );
  }

  /** `remember`: one fact, at the actor's own scope only — as the loop serves it. */
  private async remember(turn: OpenCodeCallContext, args: unknown): Promise<string> {
    const memory = this.turns.depsFor(turn.input).memory;
    if (memory === undefined) throw new ToolNotFoundError(REMEMBER_TOOL_NAME);
    const parsed = await rememberInputSchema['~standard'].validate(args ?? {});
    if (parsed.issues !== undefined) {
      throw new RefusedError(`remember: ${parsed.issues.map((issue) => issue.message).join('; ')}`);
    }
    const ctx = {
      actor: turn.input.actor,
      threadId: turn.ctx.threadId,
      ...(turn.ctx.agentName !== undefined ? { agentName: turn.ctx.agentName } : {}),
    };
    const scopes = await (memory.scopes ?? defaultScopeResolver).resolve(ctx);
    const outcome = await writeMemory({
      config: memory,
      digest: { scopes, entries: [], omitted: 0, pinnedOmitted: 0 },
      call: parsed.value,
      ctx,
      runId: turn.runId,
    });
    if (!outcome.ok) return `Not recorded: ${outcome.error}`;
    return `Recorded "${outcome.record.key}".`;
  }
}
