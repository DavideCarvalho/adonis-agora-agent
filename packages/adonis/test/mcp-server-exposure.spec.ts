import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMcpServer } from '../src/mcp/server.js';
import { DefaultRolesPolicy, ToolRegistry } from '../src/tool-registry.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };

let ran: string[] = [];

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const add = (name: string, kind: string) =>
    registry.register(
      {
        name,
        kind,
        description: name,
        inputSchema: z.object({}),
      } as never,
      {
        execute: async () => {
          ran.push(name);
          return { ok: name };
        },
      },
    );
  add('search_docs', 'read');
  add('purge_cache', 'action');
  add('ask_research', 'agent');
  add('skill', 'skill');
  return registry;
}

async function connect(options: { actions?: 'refuse' | 'execute'; allowedTools?: string[] } = {}) {
  const server = createMcpServer({
    name: 'test',
    version: '0.0.0',
    registry: buildRegistry(),
    policy: new DefaultRolesPolicy(),
    actorFromAuth: () => ACTOR,
    ...(options.actions !== undefined ? { actions: options.actions } : {}),
    ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function names(client: Client): Promise<string[]> {
  const listed = await client.listTools();
  return listed.tools.map((tool) => tool.name).sort();
}

describe('what an MCP caller can reach', () => {
  beforeEach(() => {
    ran = [];
  });

  it('lists only read tools — an action has a human gate that MCP cannot honour', async () => {
    expect(await names(await connect())).toEqual(['search_docs']);
  });

  it('refuses to RUN an action, not merely to advertise it', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'purge_cache', arguments: {} });
    expect(result.isError).toBe(true);
    // The gate is worth nothing if the handler ran and only the reply was an error.
    expect(ran).toEqual([]);
  });

  it('runs an action only where the deployment opted in by name', async () => {
    const client = await connect({ actions: 'execute' });
    expect(await names(client)).toEqual(['purge_cache', 'search_docs']);
    await client.callTool({ name: 'purge_cache', arguments: {} });
    expect(ran).toEqual(['purge_cache']);
  });

  it('never exposes a loop-served tool, even under the action opt-in', async () => {
    const client = await connect({ actions: 'execute' });
    expect(await names(client)).not.toContain('ask_research');
    for (const name of ['ask_research', 'skill']) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).toBe(true);
    }
    expect(ran).toEqual([]);
  });

  it('refuses a tool left off the allow-list, not merely leaves it unadvertised', async () => {
    const client = await connect({ allowedTools: ['nothing_real'] });
    expect(await names(client)).toEqual([]);
    const result = await client.callTool({ name: 'search_docs', arguments: {} });
    expect(result.isError).toBe(true);
    expect(ran).toEqual([]);
  });
});
