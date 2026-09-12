import type { ToolRegistry } from '../tool-registry.js';
import type { McpLogger, McpServerConfig } from './options.js';
import { type McpImportedTool, McpToolSource } from './tool-source.js';

/** One tool this importer currently has in the registry, and the server it came from. */
export interface McpRegisteredTool {
  /** The name in the shared registry — the server's name after namespacing and sanitizing. */
  name: string;
  serverName: string;
  /** The name on the server, which namespacing and sanitizing may have changed. */
  remoteName: string;
  /** The description the server supplied, which rides into the tool list of every turn. */
  description: string;
}

/**
 * Connects to each configured MCP server and registers what it exports into the shared
 * {@link ToolRegistry} — the same registry `@aiTool` discovery writes to, so an imported tool goes
 * through every gate a hand-written one does.
 *
 * The provider calls {@link start} inside `app.booted()`, AFTER tool discovery has registered the
 * app's own tools, which is what lets the name-collision check below see them.
 *
 * The registry is keyed by name and nothing else, so a name is OWNED by whoever registered it
 * first: the application, or one named server. A second claimant is refused rather than allowed to
 * replace a live handler, because the substitution is invisible from everywhere else — the model
 * goes on calling `deploy`, and `deploy` now reaches somebody else's server.
 */
export class McpToolImporter {
  private readonly sources = new Map<string, McpToolSource>();
  /** Local tool name → what is registered under it, so ownership survives a {@link refresh}. */
  private readonly owners = new Map<string, McpRegisteredTool>();

  constructor(
    private readonly servers: McpServerConfig[],
    private readonly registry: ToolRegistry,
    private readonly logger?: McpLogger,
  ) {
    // A name identifies a server in the logs, in `refresh(name)`, in the ownership map and in the
    // default tool prefix. Two servers sharing one leaves every one of those pointing at a single
    // arbitrary member of the pair — a collision that IS statically detectable, so it is refused
    // here rather than surfacing as one server's tools mysteriously missing.
    const names = servers.map((config) => config.name);
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    if (duplicate !== undefined) {
      throw new Error(
        `Two MCP servers are configured as "${duplicate}". Give each server a distinct name.`,
      );
    }
  }

  /** Open each configured server and import from all of them. */
  async start(): Promise<number> {
    for (const config of this.servers) {
      this.sources.set(config.name, new McpToolSource(config, this.logger));
    }
    return this.refresh();
  }

  async close(): Promise<void> {
    await Promise.all([...this.sources.values()].map((source) => source.close()));
  }

  /**
   * Re-import from one server, or from all of them — the way back for a server that was down at
   * boot, or that has gained tools since.
   *
   * Returns how many tools the servers it re-imported from just claimed, which is not the
   * registry's total: a name skipped for a collision is not counted, and a scoped refresh says
   * nothing about what the other servers hold.
   */
  async refresh(serverName?: string): Promise<number> {
    const configs = this.servers.filter(
      (config) =>
        this.sources.has(config.name) && (serverName === undefined || config.name === serverName),
    );
    // Connecting and listing is the slow part and the servers are independent, so it runs in
    // parallel — but registration below replays in CONFIGURATION order, because which server owns a
    // name two of them both export has to be the same answer on every boot.
    const listed = await Promise.all(
      configs.map(async (config) => ({ config, tools: await this.importFrom(config) })),
    );
    let total = 0;
    for (const { config, tools } of listed) {
      if (tools !== undefined) {
        total += this.register(config, tools);
      }
    }
    return total;
  }

  /** Every tool currently imported, and where each came from. */
  importedTools(): McpRegisteredTool[] {
    return [...this.owners.values()];
  }

  /**
   * A server that is unreachable costs its own tools and nothing else: the model is simply never
   * offered them. Booting the whole application on the availability of a third-party process is the
   * wrong trade — until a server declares `required: true`, which says the app is not useful
   * without it and should fail loudly instead.
   *
   * `undefined` is a server that could not be reached, as distinct from one that exports no tools:
   * the first has already been reported here, the second is worth reporting on registration.
   */
  private async importFrom(config: McpServerConfig): Promise<McpImportedTool[] | undefined> {
    const source = this.sources.get(config.name);
    if (source === undefined) {
      return undefined;
    }
    try {
      return await source.import();
    } catch (error) {
      const message = `MCP server "${config.name}" could not be imported: ${error instanceof Error ? error.message : String(error)}`;
      if (config.required === true) {
        throw new Error(message, { cause: error });
      }
      this.logger?.warn(`${message} — its tools are unavailable in this process.`);
      return undefined;
    }
  }

  private register(config: McpServerConfig, tools: McpImportedTool[]): number {
    let count = 0;
    for (const tool of tools) {
      const owner = this.owners.get(tool.spec.name);
      if (owner === undefined && this.registry.has(tool.spec.name)) {
        this.logger?.warn(
          `MCP server "${config.name}": tool "${tool.spec.name}" is already registered by this application — skipped. Namespace the server's tools to import it alongside.`,
        );
        continue;
      }
      if (owner !== undefined && owner.serverName !== config.name) {
        this.logger?.warn(
          `MCP server "${config.name}": tool "${tool.spec.name}" is already imported from MCP server "${owner.serverName}" — skipped. Namespace one of the two servers to import both.`,
        );
        continue;
      }
      this.registry.register(tool.spec, tool.handler);
      this.owners.set(tool.spec.name, {
        name: tool.spec.name,
        serverName: config.name,
        remoteName: tool.remoteName,
        description: tool.spec.description,
      });
      count += 1;
    }
    return count;
  }
}
