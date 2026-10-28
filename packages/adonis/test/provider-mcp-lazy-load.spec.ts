import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '../src/mcp-client/index.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';
import { ToolRegistry } from '../src/tool-registry.js';

/**
 * `@modelcontextprotocol/sdk`'s client is heavy (~5 MB heap, ~60 ms of parse with ajv), and most
 * apps configure no `mcpServers`. The provider imports the MCP client on first use, so a boot
 * without MCP servers never evaluates it. The spy below records the moment the SDK client module is
 * evaluated, whoever imports it.
 */
const sdkClient = vi.hoisted(() => ({ loaded: false }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', async (importOriginal) => {
  sdkClient.loaded = true;
  return importOriginal();
});

async function startApp(mcpServers?: McpServerConfig[]) {
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: { providers: [() => import('../providers/agent_provider.js')] },
      config: {
        agent: {
          model: { generate: async () => ({ content: 'ok' }) },
          store: 'memory',
          stores: { memory: async () => new InMemoryAgentStore() },
          pricingStore: false,
          governanceQueries: false,
          ...(mcpServers ? { mcpServers } : {}),
        },
      },
    })
    .create(new URL('../', import.meta.url));
  const app = ignitor.createApp('test');
  await app.init();
  await app.boot();
  await app.start(async () => {});
  return app;
}

function echoServer(): McpServerConfig {
  return {
    name: 'echo',
    kind: 'read',
    transport: {
      type: 'custom',
      create: async () => {
        const server = new Server(
          { name: 'echo', version: '1.0.0' },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }],
        }));
        server.setRequestHandler(CallToolRequestSchema, async () => ({
          content: [{ type: 'text', text: 'pong' }],
        }));
        const [client, serverSide] = InMemoryTransport.createLinkedPair();
        await server.connect(serverSide);
        return client;
      },
    },
  };
}

// Booting a real app: the first one pays for importing the framework.
describe('the agent provider loads the MCP client lazily', { timeout: 30_000 }, () => {
  it('does not evaluate the MCP SDK client when no mcpServers are configured', async () => {
    const app = await startApp();
    expect(sdkClient.loaded).toBe(false);
    await app.terminate();
  });

  it('loads it on first use and still imports the configured servers', async () => {
    const app = await startApp([echoServer()]);
    expect(sdkClient.loaded).toBe(true);
    const registry = await app.container.make(ToolRegistry);
    expect(registry.has('echo_ping')).toBe(true);
    await app.terminate();
  });
});
