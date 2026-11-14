import type { ApplicationService } from '@adonisjs/core/types';
import type { McpConfig, McpDevToolsConfig } from '../mcp/define_config.js';
import { normalizeMcpPath } from '../mcp/discovery.js';

/** The dev tools endpoint's default path. */
export const DEV_TOOLS_PATH = 'mcp/agora';

/** The container binding of the dev tools hub (only `mcp_provider` binds it). */
export { DEV_TOOLS_BINDING } from './contract.js';

/**
 * `config/mcp.ts` as `mcp_provider` reads it: a missing file is an empty config (every default),
 * not "MCP off" — the provider still mounts the product endpoint and the dev tools endpoint.
 */
export function readMcpConfig(app: ApplicationService): McpConfig {
  return app.config.get<McpConfig>('mcp', {} as McpConfig);
}

/** The dev tools endpoint as `mcp_provider` mounts it from `config/mcp.ts`. */
export interface ResolvedDevTools {
  /** Normalized route path, no slashes around (`mcp/agora`). */
  path: string;
  exclude: string[];
  actions: NonNullable<McpDevToolsConfig['actions']>;
  middleware: NonNullable<McpDevToolsConfig['middleware']>;
  authorize: McpDevToolsConfig['authorize'];
  auth: McpDevToolsConfig['auth'];
}

/**
 * Whether `mcp_provider` serves dev tools for this config, and how: `null` only for
 * `devTools: false`. An omitted `devTools` (or a missing `config/mcp.ts`) is the default endpoint.
 * The provider and `agora:doctor` both read it from here, so they cannot disagree.
 */
export function resolveDevTools(config: Partial<McpConfig> | undefined): ResolvedDevTools | null {
  const devTools = config?.devTools;
  if (devTools === false) return null;
  return {
    path: normalizeMcpPath(devTools?.path ?? DEV_TOOLS_PATH),
    exclude: devTools?.exclude ?? [],
    actions: devTools?.actions ?? 'refuse',
    middleware: devTools?.middleware ?? [],
    authorize: devTools?.authorize,
    auth: devTools?.auth,
  };
}
