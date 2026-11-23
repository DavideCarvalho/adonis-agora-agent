/**
 * Announce this app's Poppy endpoints to an authorization server in the same process —
 * `@adonis-agora/authkit-server` reads this slot when it builds `poppy.json`, so the conversation
 * endpoint never has to be repeated in its config
 * (`agent.protocols: [{ type: 'poppy', endpoint, description }]`, §3.1, §8.1).
 * Like `Symbol.for('@adonis-agora/oauth:resources')` for MCP, the contract is the global symbol:
 * neither package imports the other.
 *
 * @experimental Implements Personal Agent Protocol 1.0 (https://personalagentprotocol.org/docs/1.0/spec).
 * The surface may still change between minor releases of this package while it settles.
 */
export const POPPY_ENDPOINTS_SLOT = Symbol.for('@adonis-agora/poppy:endpoints');

/** What the slot holds: absolute URLs by kind, and the conversation entry's description. */
export interface PoppyEndpoints {
  /** The conversation endpoint (§8) — the `endpoint` of the `poppy` protocol entry. */
  conversations?: string;
  /**
   * What the agent at `conversations` can help with, in plain language — the entry's required
   * `description` (§8.1). Announced with `conversations`.
   */
  description?: string;
  [kind: string]: string | undefined;
}

/**
 * The `description` of the `poppy` entry when the app gives none: 1.0 requires one, and allows it
 * to say the agent can help with anything (§8.1).
 */
export const DEFAULT_POPPY_DESCRIPTION = 'Can help with anything.';

/** The absolute conversation endpoint for a public origin and a mount path. */
export function poppyConversationsUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+|\/+$/g, '')}`;
}

/** Merge `endpoints` into the slot, keeping what another package announced. */
export function announcePoppyEndpoints(endpoints: PoppyEndpoints): void {
  const slot = globalThis as Record<symbol, unknown>;
  const existing = slot[POPPY_ENDPOINTS_SLOT];
  slot[POPPY_ENDPOINTS_SLOT] = {
    ...(existing && typeof existing === 'object' ? (existing as PoppyEndpoints) : {}),
    ...endpoints,
  };
}

/** What the slot holds now (a copy), or `{}`. */
export function announcedPoppyEndpoints(): PoppyEndpoints {
  const existing = (globalThis as Record<symbol, unknown>)[POPPY_ENDPOINTS_SLOT];
  return existing && typeof existing === 'object' ? { ...(existing as PoppyEndpoints) } : {};
}
