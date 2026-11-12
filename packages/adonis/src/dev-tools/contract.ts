import type { HttpContext } from '@adonisjs/core/http';

/**
 * The dev-tools registration contract, version 1.
 *
 * `@adonis-agora/agent/mcp_provider` binds a {@link DevToolsHub} at `'agora.devTools'` in its
 * `register()`; any lib with a console registers its developer tools into it from its own `boot()`.
 * Every tool is then served on ONE dev MCP endpoint (`/mcp/agora` by default).
 *
 * The contract is STRUCTURAL: a lib re-declares these types locally (or copies them) and never
 * imports `@adonis-agora/agent`, which stays an optional, undeclared peer. Only additive changes are
 * made under `version: 1`.
 */

/** The container binding the hub lives at. */
export const DEV_TOOLS_BINDING = 'agora.devTools';

/** The contract version a lib checks before registering. */
export const DEV_TOOLS_VERSION = 1;

/** The hub a lib registers into. */
export interface DevToolsHub {
  /** Libs register only when they know this version. */
  readonly version: 1;
  /** Throws on a duplicate lib id, a bad lib id, a tool name not prefixed by the lib, or a schema outside the subset. */
  register(lib: DevToolsLib): void;
}

/** One lib's tools and the gate that decides who may use them. */
export interface DevToolsLib {
  /** `/^[a-z][a-z0-9]*$/`: `'durable'`, `'telescope'`, … */
  lib: string;
  /** Human title, used in the endpoint's instructions (`'Durable workflows'`). */
  title: string;
  /**
   * The lib's RESOLVED console gate: the same function its console routes call, run once per MCP
   * request. Never throws (a throw is treated as `forbidden`). A console-shaped verdict (`true`,
   * `false`, `{ redirectTo }`) is read the way the console reads it.
   */
  authorize(ctx: HttpContext): Promise<DevToolsDecision>;
  tools: DevTool[];
}

/** What a lib's `authorize` answers: the libs' existing console decision. */
export type DevToolsDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'unauthenticated' | 'forbidden';
      redirectTo?: string;
      error?: unknown;
    };

/** One developer tool. */
export interface DevTool {
  /** Full name, prefixed by the lib: `durable_list_runs`. `<lib>_<verb>_<noun>`, snake_case. */
  name: string;
  /** `read` tools are listed by default; `action` tools only when the app opts in. */
  kind: 'read' | 'action';
  /** Agent-facing: what it returns, and its limits. */
  description: string;
  /** JSON Schema subset, see {@link DevToolInputSchema}. */
  input: DevToolInputSchema;
  /** Annotation for actions that cancel, refund, revoke or delete. */
  destructive?: boolean;
  /** Capability, NOT access: hide a tool this deployment cannot run (no refunds on this gateway). */
  available?(): boolean | Promise<boolean>;
  /** Runs the tool. The input is already validated against `input`. */
  run(input: Record<string, unknown>, call: DevToolCall): Promise<unknown>;
}

/** What a tool's `run` receives besides its input. */
export interface DevToolCall {
  /** The MCP POST's own HTTP context. */
  ctx: HttpContext;
  caller: DevToolsCaller;
  limits: { maxRows: number; maxBytes: number };
}

/** Who is calling, for audit trails. Never a token value. */
export interface DevToolsCaller {
  /** `'token:3f9a1c2b7d10'`, `'user:42'`, `'dev-open'`. */
  id: string;
  /** `token`: a bearer the endpoint did not recognize itself; `session`: a signed-in account; `open`: neither. */
  via: 'token' | 'session' | 'open';
}

/** One property of a {@link DevToolInputSchema}. */
export interface DevToolInputProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: readonly string[];
  /** Arrays hold strings only. */
  items?: { type: 'string' };
  minimum?: number;
  maximum?: number;
}

/** An object of scalar / enum / array-of-string properties: what the console query strings already are. */
export interface DevToolInputSchema {
  type: 'object';
  properties: Record<string, DevToolInputProperty>;
  required?: string[];
}
