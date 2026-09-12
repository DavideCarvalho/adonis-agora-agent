import { createHash } from 'node:crypto';

/**
 * The tightest tool-name rule among the major model providers (`^[a-zA-Z0-9_-]{1,64}$`). An MCP
 * server is under no such constraint — `repo/create.issue` is a legal MCP tool name — so a name is
 * reshaped here rather than being discovered at turn time as a provider-side rejection.
 */
export const MAX_TOOL_NAME_LENGTH = 64;

const HASH_LENGTH = 6;

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

/**
 * The name the model and the {@link import('../tool-registry.js').ToolRegistry} see for one
 * imported tool.
 *
 * Namespaced under the server by default: the registry is keyed by name, so an un-namespaced import
 * would let a remote server's `search` silently replace the app's own `search` — the collision would
 * present itself as the app tool quietly doing something else.
 *
 * `namespace: false` opts out (for a server whose names are already qualified), and a string sets
 * the prefix explicitly.
 *
 * The result is stable across restarts, including when truncated: a stored tool call in a thread
 * refers to a tool by this name, so a name that changed between boots would strand history.
 */
export function localToolName(
  serverName: string,
  remoteName: string,
  namespace: boolean | string | undefined,
): string {
  const prefix = namespace === false ? '' : typeof namespace === 'string' ? namespace : serverName;
  const full = sanitize(prefix === '' ? remoteName : `${prefix}_${remoteName}`);
  if (full.length <= MAX_TOOL_NAME_LENGTH) {
    return full;
  }
  const digest = createHash('sha1').update(full).digest('hex').slice(0, HASH_LENGTH);
  return `${full.slice(0, MAX_TOOL_NAME_LENGTH - HASH_LENGTH - 1)}_${digest}`;
}
