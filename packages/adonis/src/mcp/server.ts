import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { AnyObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { RolesPolicy } from '../spi/roles-policy.js';
import type { AiToolCtx } from '../spi/tool.js';
import { ToolNotFoundError, ToolRegistry } from '../tool-registry.js';
import type { Actor } from '../types.js';

/**
 * Runtime context a MCP handler synthesizes for {@link ToolRegistry.invoke}: the acting {@link Actor}
 * comes from the verified auth, and the run/request ids from the MCP request so tool traces map back
 * to the MCP session.
 */
export interface McpToolContextOptions {
  /** How the actor is resolved from the transport's verified auth info. */
  actorFromAuth: (authInfo: AuthInfo | undefined) => Actor;
  /** How run/thread/request ids are derived. Defaults to the MCP session + request ids. */
  idsFromRequest?: (
    sessionId: string | undefined,
    requestId: string | number | undefined,
  ) => {
    threadId: string;
    runId: string;
    requestId: string;
  };
}

/** Options for {@link createMcpServer}. */
export interface CreateMcpServerOptions extends McpToolContextOptions {
  /** Server name reported in the initialize handshake. */
  name: string;
  /** Server version reported in the initialize handshake. */
  version: string;
  /** The agent tool registry to expose. */
  registry: ToolRegistry;
  /** Tool authorization gate (role re-check happens per call, defense-in-depth). */
  policy: RolesPolicy;
  /** Optional allow-list restricting which tools are exposed. */
  allowedTools?: string[];
  /**
   * What to do with `action` tools. Defaults to `'refuse'`: they are neither listed nor callable.
   *
   * An `action` is HITL-gated in the loop — a human approves it before it runs. An MCP caller has
   * no human, so honouring that gate is impossible and the tool stays off the surface. `'execute'`
   * is a deployment saying it accepts an unapproved actor running every `action` its roles reach.
   */
  actions?: 'refuse' | 'execute';
}

/**
 * Kinds the LOOP serves, which a registry entry cannot honour on its own. A handoff tool is
 * registered with a stub handler because `AgentLoop` performs the delegation, so calling it here
 * would answer `{}` and delegate to nobody. Never exposed, whatever `actions` says.
 */
const LOOP_SERVED_KINDS = new Set(['agent', 'ask', 'skill', 'memory']);

/** Whether this tool may be reached over MCP at all — the same answer for listing and for calling. */
function isExposable(kind: string, actions: 'refuse' | 'execute'): boolean {
  if (LOOP_SERVED_KINDS.has(kind)) {
    return false;
  }
  return kind !== 'action' || actions === 'execute';
}

/**
 * True for a Zod schema (tags its Standard Schema props with `vendor: 'zod'`). Narrows to the SDK's
 * `AnyObjectSchema` so `toJsonSchemaCompat` can consume it without a cast.
 */
function isZodSchema(schema: StandardSchemaV1): schema is AnyObjectSchema {
  return schema['~standard'].vendor === 'zod';
}

/** True when the schema carries the Standard JSON Schema converter (`~standard.jsonSchema.input`). */
function hasStandardJsonSchema(schema: StandardSchemaV1): schema is StandardSchemaV1 & {
  '~standard': { jsonSchema: { input(): object } };
} {
  const standard = schema['~standard'];
  if (!('jsonSchema' in standard)) {
    return false;
  }
  const converter = standard.jsonSchema;
  return (
    typeof converter === 'object' &&
    converter !== null &&
    'input' in converter &&
    typeof converter.input === 'function'
  );
}

/**
 * Convert a core `StandardSchemaV1` tool schema into the JSON Schema MCP clients see in `tools/list`.
 * Zod schemas are converted with the SDK's compat helper (handles both v3 and v4); schemas that expose
 * the Standard JSON Schema extension (Valibot/ArkType/Zod 4) hand their `input()` schema straight
 * through. Anything else degrades to a permissive object schema — the loop still validates the real
 * schema on call via `~standard.validate`.
 */
function toJsonSchema(schema: StandardSchemaV1): Record<string, unknown> {
  if (isZodSchema(schema)) {
    return toJsonSchemaCompat(schema);
  }
  if (hasStandardJsonSchema(schema)) {
    return schema['~standard'].jsonSchema.input() as Record<string, unknown>;
  }
  return { type: 'object', properties: {}, additionalProperties: true };
}

/**
 * Build a low-level MCP `Server` that exposes the agent's {@link ToolRegistry} over the wire:
 *
 * - `tools/list` → `registry.definitionsFor(actor, policy, allowedTools)` — the tools the acting
 *   actor's roles permit (fail-closed via the same `RolesPolicy` the agent loop uses), converted to
 *   MCP `Tool` descriptors with JSON-Schema inputs.
 * - `tools/call` → `registry.invoke(name, args, ctx, policy)` — role re-check + input re-validation
 *   before the handler runs (the registry's own defense-in-depth), so a stale tool list can never
 *   bypass the gate.
 *
 * The acting actor comes from the verified auth's `extra.authInfo`: the MCP auth strategies
 * (`authKitAuth`/`apiKeyAuth`) attach it to `extra.actor` as a typed `McpAuthInfo`, and `actorFromAuth`
 * resolves it (e.g. with the library's `actorFromAuthInfo` helper) before the gate runs.
 *
 * Use this in the MCP provider (one server per session, connected to that session's transport).
 */
export function createMcpServer(options: CreateMcpServerOptions): Server {
  const { registry, policy, allowedTools, actorFromAuth, idsFromRequest } = options;
  const actions = options.actions ?? 'refuse';
  const server = new Server(
    { name: options.name, version: options.version },
    { capabilities: { tools: {} } },
  );

  const buildCtx = (authInfo: AuthInfo | undefined, sessionId: string | undefined): AiToolCtx => {
    const actor = actorFromAuth(authInfo);
    const ids = idsFromRequest
      ? idsFromRequest(sessionId, undefined)
      : {
          threadId: `mcp:${sessionId ?? actor.id}`,
          runId: `mcp:${sessionId ?? 'run'}`,
          requestId: `mcp:${sessionId ?? 'req'}`,
        };
    return { actor, ...ids };
  };

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const actor = actorFromAuth(extra.authInfo);
    const defs = (await registry.definitionsFor(actor, policy, allowedTools)).filter((definition) =>
      isExposable(definition.kind, actions),
    );
    return {
      tools: defs.map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: toJsonSchema(definition.inputSchema),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const ctx = buildCtx(extra.authInfo, extra.sessionId);
    const { name, arguments: args } = request.params;
    try {
      // Re-decided on the CALL, not inherited from the listing. `registry.invoke` re-checks roles
      // and re-validates input, but knows nothing about this server's allow-list or its `actions`
      // stance — so a caller who guesses a name would otherwise reach a tool deliberately left off
      // the surface.
      const spec = registry.spec(name);
      if (spec === undefined || !isExposable(spec.kind, actions)) {
        throw new ToolNotFoundError(name);
      }
      if (allowedTools !== undefined && !allowedTools.includes(name)) {
        throw new ToolNotFoundError(name);
      }
      const output = await registry.invoke(name, args ?? {}, ctx, policy);
      return {
        content: [
          { type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });

  return server;
}
