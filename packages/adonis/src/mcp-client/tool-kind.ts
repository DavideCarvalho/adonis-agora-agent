import type { ToolKind } from '../types.js';

/**
 * An MCP server's self-reported behaviour hints for one tool (MCP `ToolAnnotations`). Every field is
 * a claim made by the remote server, so nothing here is a security boundary — see
 * {@link McpToolKindPolicy} for why the default policy ignores them.
 */
export interface McpToolAnnotations {
  title?: string | undefined;
  readOnlyHint?: boolean | undefined;
  destructiveHint?: boolean | undefined;
  idempotentHint?: boolean | undefined;
  openWorldHint?: boolean | undefined;
}

/** What a {@link McpToolKindPolicy} decides on: one tool as the remote server described it. */
export interface McpToolInfo {
  name: string;
  description?: string;
  annotations?: McpToolAnnotations;
}

/**
 * How an imported MCP tool gets its {@link ToolKind}.
 *
 * The stakes: the loop auto-executes a `read` tool and pauses the turn for human approval on an
 * `action` one. A tool imported from an MCP server was written by someone outside this codebase and
 * its effects are not visible from here, so the DEFAULT (`'action'`) is the conservative one — a
 * remote tool needs a human before it runs. Widening that is a decision the host makes explicitly:
 *
 *  - `'action'` (default) — every imported tool is HITL-gated.
 *  - `'read'` — every imported tool auto-executes. Only for a server you own and audit.
 *  - `'trust-annotations'` — believe the server's `readOnlyHint`. The hint is asserted by the very
 *    party whose effects it describes, so this is a statement of trust in that server, not a check.
 *  - a predicate — decide per tool (e.g. read for a known-safe name list, action for the rest).
 */
export type McpToolKindPolicy =
  | 'action'
  | 'read'
  | 'trust-annotations'
  | ((tool: McpToolInfo) => 'read' | 'action');

/** Resolves one imported tool's kind. Anything other than an explicit widening stays `action`. */
export function resolveMcpToolKind(
  tool: McpToolInfo,
  policy: McpToolKindPolicy | undefined,
): ToolKind {
  if (typeof policy === 'function') {
    return policy(tool);
  }
  if (policy === 'read') {
    return 'read';
  }
  if (policy === 'trust-annotations') {
    // `destructiveHint` is only meaningful when `readOnlyHint` is false, so a tool claiming both is
    // describing itself incoherently — resolved on the gated side rather than guessing which half
    // of the claim to believe.
    const annotations = tool.annotations;
    return annotations?.readOnlyHint === true && annotations.destructiveHint !== true
      ? 'read'
      : 'action';
  }
  return 'action';
}
