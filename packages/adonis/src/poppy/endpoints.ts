/**
 * Announce this app's Poppy endpoints to an authorization server in the same process —
 * `@adonis-agora/authkit-server` reads this slot when it builds `poppy.json`, so the conversation
 * endpoint never has to be repeated in its config (`agent.protocols: [{ type: 'poppy', endpoint }]`).
 * Like `Symbol.for('@adonis-agora/oauth:resources')` for MCP, the contract is the global symbol:
 * neither package imports the other.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */
export const POPPY_ENDPOINTS_SLOT = Symbol.for('@adonis-agora/poppy:endpoints');

/** What the slot holds: absolute URLs, by kind. */
export interface PoppyEndpoints {
  /** The conversation endpoint (§7) — the `endpoint` of the `poppy` protocol entry. */
  conversations?: string;
  [kind: string]: string | undefined;
}

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
