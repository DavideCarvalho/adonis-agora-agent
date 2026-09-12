import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolHandler } from '../spi/tool.js';
import { invokeWithTransientRetry, type ToolTransientRetrySetting } from '../tool-retry.js';
import type { ToolSpec } from '../types.js';
import type { McpLogger, McpServerConfig } from './options.js';
import { mcpInputSchema } from './tool-input.js';
import { resolveMcpToolKind } from './tool-kind.js';
import { localToolName } from './tool-name.js';
import { isTransientMcpError } from './transient.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CLIENT_INFO = { name: 'adonis-agora-agent-mcp', version: '1.0.0' };

/** One remote tool, mapped onto what `ToolRegistry.register` takes, plus where it came from. */
export interface McpImportedTool {
  spec: ToolSpec;
  handler: ToolHandler;
  /** The name on the server, which namespacing and sanitizing may have changed in `spec.name`. */
  remoteName: string;
  serverName: string;
}

/** A remote tool that answered with `isError` — a business failure of the tool, not of the transport. */
export class McpToolCallError extends Error {
  constructor(
    public readonly serverName: string,
    public readonly toolName: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpToolCallError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One block of an MCP tool result, narrowed to the two fields the mapping below reads. */
interface ContentBlock {
  type: string;
  text?: string | undefined;
}

/**
 * `content` is optional in the compatibility result shape the SDK still accepts, so it is narrowed
 * rather than trusted: a server that answers without it yields no blocks instead of a crash.
 */
function toContentBlocks(content: unknown): ContentBlock[] {
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

/**
 * One MCP server, as a source of tools.
 *
 * Holds a single client and reconnects on demand. The connection is deliberately not treated as
 * durable state: a remote server may restart, be redeployed, or drop an idle connection, and the
 * first symptom is a failed tool call. So a call that fails transiently drops the client, and the
 * retry — core's `invokeWithTransientRetry`, the same one the agent loop wraps every tool with —
 * reconnects on its next attempt.
 *
 * Every timeout here is the SDK's own per-request timeout rather than a race of our own, so a
 * timed-out request is also CANCELLED on the wire instead of being abandoned.
 */
export class McpToolSource {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;

  constructor(
    private readonly config: McpServerConfig,
    private readonly logger?: McpLogger,
  ) {}

  get name(): string {
    return this.config.name;
  }

  /** Connect if needed, list the server's tools, and map the selected ones onto specs + handlers. */
  async import(): Promise<McpImportedTool[]> {
    const client = await this.ensureClient();
    const { tools } = await client.listTools(undefined, { timeout: this.requestTimeoutMs() });
    const imported: McpImportedTool[] = [];
    for (const tool of tools) {
      if (!this.isSelected(tool.name)) {
        continue;
      }
      const mapped = this.toImportedTool(tool);
      if (mapped !== undefined) {
        imported.push(mapped);
      }
    }
    return imported;
  }

  async close(): Promise<void> {
    const client = this.client ?? (await this.connecting?.catch(() => undefined));
    this.client = undefined;
    this.connecting = undefined;
    await client?.close();
  }

  private isSelected(remoteName: string): boolean {
    const { include, exclude } = this.config;
    if (include !== undefined && !include.includes(remoteName)) {
      return false;
    }
    return exclude === undefined || !exclude.includes(remoteName);
  }

  /**
   * A tool whose schema won't compile — or whose `pattern` can backtrack exponentially — is
   * dropped, not imported with a permissive stand-in: the model would then be free to send that
   * remote tool any arguments at all, and the call would still look validated from this side.
   */
  private toImportedTool(tool: Tool): McpImportedTool | undefined {
    const name = localToolName(this.config.name, tool.name, this.config.namespace);
    let inputSchema: ToolSpec['inputSchema'];
    try {
      inputSchema = mcpInputSchema(tool.inputSchema, {
        ...(this.config.validator !== undefined ? { validator: this.config.validator } : {}),
        ...(this.config.rejectUnsafePatterns !== undefined
          ? { rejectUnsafePatterns: this.config.rejectUnsafePatterns }
          : {}),
      });
    } catch (error) {
      this.logger?.warn(
        `MCP server "${this.config.name}": tool "${tool.name}" has an input schema this process will not validate against — skipped (${error instanceof Error ? error.message : String(error)})`,
      );
      return undefined;
    }
    const spec: ToolSpec = {
      name,
      kind: resolveMcpToolKind(
        {
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
        },
        this.config.kind,
      ),
      description: tool.description ?? `The "${tool.name}" tool on MCP server ${this.config.name}.`,
      inputSchema,
      ...(this.config.roles !== undefined ? { roles: this.config.roles } : {}),
      ...(this.config.ability !== undefined ? { ability: this.config.ability } : {}),
    };
    const handler: ToolHandler = { execute: (input) => this.callTool(tool.name, input) };
    return { spec, handler, remoteName: tool.name, serverName: this.config.name };
  }

  private callTool(remoteName: string, input: unknown): Promise<unknown> {
    return invokeWithTransientRetry(() => this.callOnce(remoteName, input), this.retrySetting(), {
      onRetry: (attempt, error) => {
        this.logger?.warn(
          `MCP server "${this.config.name}": tool "${remoteName}" failed transiently on attempt ${attempt}, reconnecting (${error instanceof Error ? error.message : String(error)})`,
        );
      },
    });
  }

  private async callOnce(remoteName: string, input: unknown): Promise<unknown> {
    const result = await this.request(remoteName, input);
    const content = toContentBlocks(result.content);
    if (result.isError === true) {
      throw new McpToolCallError(this.config.name, remoteName, this.errorText(content));
    }
    if (result.structuredContent !== undefined) {
      return result.structuredContent;
    }
    // The overwhelmingly common shape is one text block; handing the model the bare string keeps it
    // from having to read past an envelope that carries nothing. Anything richer (images, embedded
    // resources, several blocks) is passed through as MCP modelled it.
    const only = content.length === 1 ? content[0] : undefined;
    return only?.type === 'text' ? only.text : { content };
  }

  /** The wire call alone, so only a TRANSPORT failure can recycle the client — never a tool's own. */
  private async request(remoteName: string, input: unknown) {
    const client = await this.ensureClient();
    try {
      return await client.callTool(
        { name: remoteName, ...(isRecord(input) ? { arguments: input } : {}) },
        CallToolResultSchema,
        { timeout: this.requestTimeoutMs() },
      );
    } catch (error) {
      if (isTransientMcpError(error)) {
        this.dropClient();
      }
      throw error;
    }
  }

  private errorText(content: ContentBlock[]): string {
    const text = content
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n')
      .trim();
    return text === '' ? `MCP tool "${this.config.name}" reported an error` : text;
  }

  private ensureClient(): Promise<Client> {
    if (this.client !== undefined) {
      return Promise.resolve(this.client);
    }
    // One in-flight connect shared by every caller: a turn can call several of a server's tools at
    // once, and each opening its own connection would leave all but one orphaned.
    this.connecting ??= this.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    const client = new Client(this.config.clientInfo ?? CLIENT_INFO);
    const transport = await this.createTransport();
    await client.connect(transport, {
      timeout: this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    });
    client.onclose = () => {
      if (this.client === client) {
        this.client = undefined;
      }
    };
    this.client = client;
    return client;
  }

  private createTransport(): Transport | Promise<Transport> {
    const transport = this.config.transport;
    switch (transport.type) {
      case 'stdio':
        return new StdioClientTransport({
          command: transport.command,
          ...(transport.args !== undefined ? { args: transport.args } : {}),
          ...(transport.env !== undefined ? { env: transport.env } : {}),
          ...(transport.cwd !== undefined ? { cwd: transport.cwd } : {}),
        });
      case 'http':
        // The SDK's own transports expose `sessionId` as `string | undefined` where the `Transport`
        // interface declares the property optional, which `exactOptionalPropertyTypes` reads as a
        // mismatch — the class does implement the interface it is declared against.
        return new StreamableHTTPClientTransport(
          new URL(transport.url),
          transport.headers !== undefined ? { requestInit: { headers: transport.headers } } : {},
        ) as Transport;
      case 'custom':
        return transport.create();
    }
  }

  private dropClient(): void {
    const client = this.client;
    this.client = undefined;
    void client?.close().catch(() => undefined);
  }

  /**
   * The configured policy with `isTransientMcpError` filled in as the classifier. The default
   * classifier recognizes local database lock contention, which is not how a remote server fails —
   * leaving it in place would mean the policy is on and never matches anything.
   */
  private retrySetting(): ToolTransientRetrySetting {
    const setting = this.config.transientRetry;
    if (setting === false) {
      return false;
    }
    return { ...setting, classify: setting?.classify ?? isTransientMcpError };
  }

  private requestTimeoutMs(): number {
    return this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }
}
