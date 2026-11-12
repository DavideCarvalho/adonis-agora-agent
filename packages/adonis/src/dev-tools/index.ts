/**
 * `@adonis-agora/agent/dev-tools` — the contract a lib registers its developer tools with, so they are
 * served on the app's dev MCP endpoint (`/mcp/agora`).
 *
 * A lib does NOT import this module: it copies the types and {@link registerDevTools} (both are
 * small and structural) into its own code, the same way it carries its own `ConsoleAuthorize`. The
 * agent stays an optional, undeclared peer, and a lib without it installed pays nothing.
 */
import type { DevToolsHub, DevToolsLib } from './contract.js';

export type {
  DevTool,
  DevToolCall,
  DevToolInputProperty,
  DevToolInputSchema,
  DevToolsCaller,
  DevToolsDecision,
  DevToolsHub,
  DevToolsLib,
} from './contract.js';
export { DEV_TOOLS_BINDING, DEV_TOOLS_VERSION } from './contract.js';
export {
  DEV_TOOLS_FIELD_BYTES,
  DEV_TOOLS_MAX_BYTES,
  DEV_TOOLS_MAX_ROWS,
  truncateText,
} from './limits.js';
export { validateDevToolInput } from './schema.js';

/** The part of an Adonis application {@link registerDevTools} touches. */
export interface DevToolsAppLike {
  container: {
    hasBinding(binding: string): boolean;
    make(binding: string): Promise<unknown>;
  };
}

/**
 * Register a lib's tools when the app serves dev tools: a no-op (`false`) when
 * `@adonis-agora/agent/mcp_provider` is not registered, when `devTools: false`, or when the hub
 * speaks another contract version. Call it from the provider's `boot()`, after the console config is
 * resolved, and only when the console is enabled.
 *
 * Copy it into the lib (it is the whole integration):
 *
 * ```ts
 * async function registerDevTools(app: DevToolsAppLike, lib: DevToolsLib): Promise<boolean> {
 *   if (!app.container.hasBinding('agora.devTools')) return false
 *   const hub = (await app.container.make('agora.devTools')) as Partial<DevToolsHub> | undefined
 *   if (hub?.version !== 1 || typeof hub.register !== 'function') return false
 *   hub.register(lib)
 *   return true
 * }
 * ```
 */
export async function registerDevTools(app: DevToolsAppLike, lib: DevToolsLib): Promise<boolean> {
  if (!app.container.hasBinding('agora.devTools')) return false;
  const hub = (await app.container.make('agora.devTools')) as Partial<DevToolsHub> | undefined;
  if (hub?.version !== 1 || typeof hub.register !== 'function') return false;
  hub.register(lib);
  return true;
}
