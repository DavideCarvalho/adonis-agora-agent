import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';
import type { ToolTransientRetrySetting } from '../tool-retry.js';
import type { Actor } from '../types.js';
import type { McpToolKindPolicy } from './tool-kind.js';

/** A server this process starts and talks to over its stdin/stdout. */
export interface McpStdioTransportConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  /** Replaces the inherited environment entirely (the SDK's own semantics), rather than adding to it. */
  env?: Record<string, string>;
  cwd?: string;
}

/** A server reachable over MCP's streamable-HTTP transport. */
export interface McpHttpTransportConfig {
  type: 'http';
  url: string;
  /** Sent on every request — the usual place for a static bearer token or an API key. */
  headers?: Record<string, string>;
}

/**
 * Anything else: an OAuth-carrying HTTP transport, the legacy SSE transport, or an in-process
 * linked pair in a test. Called again for each reconnect, so it must return a FRESH transport —
 * a `Transport` that has been closed cannot be restarted.
 */
export interface McpCustomTransportConfig {
  type: 'custom';
  create: () => Transport | Promise<Transport>;
}

export type McpTransportConfig =
  | McpStdioTransportConfig
  | McpHttpTransportConfig
  | McpCustomTransportConfig;

/** Somewhere to report a server that misbehaved. Structurally satisfied by AdonisJS's `Logger`. */
export interface McpLogger {
  warn(message: string): void;
}

/** A remote tool definition, as a screen sees it before the tool is imported. */
export interface McpToolScreenInput {
  /** The configured server's name. */
  server: string;
  /** The name on the server (before namespacing). */
  name: string;
  title?: string;
  description?: string;
  /** The tool's JSON Schema, as the server listed it — descriptions in it are read by the model too. */
  inputSchema: unknown;
}

/** A screen's decision. `allowed: false` leaves the tool out of the catalog, with the reason logged. */
export type McpToolScreenVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Inspects a tool definition before it is imported — the seam for tool-poisoning checks
 * (instructions hidden in a description or a parameter's description, which the model reads and
 * people rarely do). `createGuardrails({ toolPoisoning: true }).screenTool` from
 * `@adonis-agora/agent/guardrails` has this shape.
 */
export type McpToolScreen = (
  tool: McpToolScreenInput,
) => McpToolScreenVerdict | Promise<McpToolScreenVerdict>;

/** One MCP server to import tools from, and the policy every tool it exports is imported under. */
export interface McpServerConfig {
  /** Identifies the server in logs, and prefixes its tool names by default. */
  name: string;
  transport: McpTransportConfig;
  /**
   * How an imported tool gets its `kind`. Defaults to `'action'` — every remote tool waits for a
   * human. See {@link McpToolKindPolicy} for what widening it means.
   */
  kind?: McpToolKindPolicy;
  /** Import only these remote tool names. Omit to import everything the server lists. */
  include?: string[];
  /** Import everything except these remote tool names. Applied after {@link include}. */
  exclude?: string[];
  /** Prefix for imported tool names: the server name (default), a string, or `false` for none. */
  namespace?: boolean | string;
  /** Roles allowed to invoke every tool from this server. Omit → the module's `defaultRoles`. */
  roles?: string[];
  /** Ability every tool from this server is checked against by an ability-aware `RolesPolicy`. */
  ability?: string;
  /**
   * Per-actor gate applied to every tool from this server, like a tool's own `canUse` — runs after
   * the `RolesPolicy`, on both the offered list and the call. Omit → the role gate alone decides.
   */
  canUse?: (actor: Actor) => boolean | Promise<boolean>;
  /**
   * Whether this server's tools exist in this deployment at all — a boolean, or a predicate
   * re-read every turn (a feature flag). A disabled server's tools are still imported, so turning
   * it back on needs no refresh; they are just never offered or invocable. Omit → enabled.
   */
  enabled?: boolean | (() => boolean | Promise<boolean>);
  /** Cap on the MCP initialize handshake. Default 10s. */
  connectTimeoutMs?: number;
  /** Cap on `tools/list` and on every tool call. Default 30s. */
  requestTimeoutMs?: number;
  /**
   * Retry policy for a call that failed transiently, applied around the tool's own invocation with
   * `invokeWithTransientRetry` — the same in-place retry the agent loop uses for a rolled-back
   * database step, so a retry never becomes a second durable checkpoint. Defaults to
   * `{ attempts: 2, backoffMs: 150 }`; `false` surfaces the first failure.
   *
   * WHICH FAILURES COUNT DEPENDS ON THE {@link McpServerConfig.kind}. A `read` tool uses
   * {@link import('./transient.js').isTransientMcpError} — dropped connections, request timeouts,
   * retryable HTTP statuses, socket errors. An `action` tool uses the narrower
   * {@link import('./transient.js').isPreExecutionMcpError}, which accepts only failures that PROVE
   * the tool did not run: a timeout or a 503 may equally be a remote effect whose answer was lost,
   * and re-issuing that would spend one human approval on two remote side effects.
   *
   * Supplying `classify` takes that judgement over for every kind, including `action`.
   *
   * Retrying here, rather than by widening the app-wide `toolTransientRetry` classifier, keeps the
   * two from compounding: a host that would rather retry at the loop layer should pass
   * `isTransientMcpError` into that classifier AND set this to `false`.
   */
  transientRetry?: ToolTransientRetrySetting;
  /** Compiles each tool's JSON Schema. Defaults to the MCP SDK's AJV adapter. */
  validator?: jsonSchemaValidator;
  /**
   * Skip a tool whose input schema carries a `pattern` that can backtrack exponentially — a string
   * this server writes and the model fills in, which together can pin the event loop of whichever
   * process runs the tool. Default `true`. Turn it off only for a `validator` whose regex engine
   * does not backtrack, where the screen costs tools and buys nothing.
   */
  rejectUnsafePatterns?: boolean;
  /**
   * Screens each listed tool definition before it is imported; a refused tool is skipped (and
   * logged), exactly like one whose schema will not compile. Runs on every import, so a server that
   * changes a description after boot is screened again on refresh. A screen that THROWS skips the
   * tool too: a check that could not run is not a pass.
   */
  screen?: McpToolScreen;
  /** What this client calls itself in the MCP handshake. Defaults to `adonis-agora-agent-mcp`. */
  clientInfo?: { name: string; version: string };
  /**
   * Fail application boot when this server cannot be reached. Default `false`: an unreachable
   * server costs its own tools, not the app — see {@link import('./importer.js').McpToolImporter}.
   */
  required?: boolean;
}
