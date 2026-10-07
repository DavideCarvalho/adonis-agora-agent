import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DefaultToolAuthorizer } from '../src/authorizer.js';
import { InMemoryConfirmTokenStore } from '../src/confirm-token.js';
import { defineConfirmedTool } from '../src/confirmed-tool.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { RolesPolicy } from '../src/spi/roles-policy.js';
import { registerFunctionalTool } from '../src/tool-discovery.js';
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

async function connect(
  options: { actions?: 'refuse' | 'execute'; allowedTools?: string[]; policy?: RolesPolicy } = {},
) {
  const server = createMcpServer({
    name: 'test',
    version: '0.0.0',
    registry: buildRegistry(),
    policy: options.policy ?? new DefaultRolesPolicy(),
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

  it("under emptyRoles: 'deny' a tool with no roles is neither listed nor runnable", async () => {
    // What mcp_provider binds for `defineMcpConfig({ defaultRoles: [], emptyRoles: 'deny' })`.
    const client = await connect({ policy: new DefaultToolAuthorizer([], { emptyRoles: 'deny' }) });
    expect(await names(client)).toEqual([]);
    const result = await client.callTool({ name: 'search_docs', arguments: {} });
    expect(result.isError).toBe(true);
    expect(ran).toEqual([]);
  });
});

describe('a confirmed write over MCP', () => {
  async function connectWithRefund() {
    const written: unknown[] = [];
    const registry = new ToolRegistry();
    registerFunctionalTool(
      registry,
      defineConfirmedTool<{ orderId: string }, { orderId: string }>(
        {
          name: 'refund_order',
          description: 'Refund an order.',
          input: z.object({ orderId: z.string() }).strict(),
          secret: 'a-secret',
          store: new InMemoryConfirmTokenStore(),
        },
        {
          prepare: (args) => args,
          preview: (args) => ({ summary: `Refund ${args.orderId}?` }),
          commit: (args) => {
            written.push(args);
            return { summary: 'Refunded.' };
          },
        },
      ),
      [],
    );
    const server = createMcpServer({
      name: 'test',
      version: '0.0.0',
      registry,
      policy: new DefaultRolesPolicy(),
      actorFromAuth: () => ACTOR,
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: 'refund_order', arguments: args });
      const text = (result.content as { text: string }[])[0]?.text ?? '';
      return { isError: result.isError === true, text };
    };
    return { client, call, written };
  }

  it('is listed — with the two confirmation fields in its schema — though it writes', async () => {
    const { client } = await connectWithRefund();
    const [tool] = (await client.listTools()).tools;
    expect(tool?.name).toBe('refund_order');
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
      'orderId',
      'confirm',
      'confirmToken',
    ]);
    expect(tool?.inputSchema.required).toEqual(['orderId']);
  });

  it('previews, commits on the confirmation, and refuses the token a second time', async () => {
    const { call, written } = await connectWithRefund();
    const preview = JSON.parse((await call({ orderId: 'o-1' })).text);
    expect(preview).toMatchObject({ status: 'preview', summary: 'Refund o-1?' });
    expect(written).toEqual([]);

    const confirm = { orderId: 'o-1', confirm: true, confirmToken: preview.confirmToken };
    const tampered = await call({ ...confirm, orderId: 'o-2' });
    expect(tampered.isError).toBe(true);
    expect(written).toEqual([]);

    expect(JSON.parse((await call(confirm)).text)).toEqual({
      status: 'done',
      summary: 'Refunded.',
    });
    const again = await call(confirm);
    expect(again.isError).toBe(true);
    expect(again.text).toContain('already confirmed');
    expect(written).toEqual([{ orderId: 'o-1' }]);
  });
});

describe('the context a tool gets over MCP', () => {
  it('a fresh call id and idempotency key per call, and the mcp channel', async () => {
    const seen: Record<string, unknown>[] = [];
    const registry = new ToolRegistry();
    registry.register(
      { name: 'log_dose', kind: 'action', description: 'x', inputSchema: z.object({}) } as never,
      {
        execute: async (_input: unknown, ctx: Record<string, unknown>) => {
          seen.push(ctx);
          return { ok: true };
        },
      } as never,
    );
    const server = createMcpServer({
      name: 'test',
      version: '0.0.0',
      registry,
      policy: new DefaultRolesPolicy(),
      actorFromAuth: () => ACTOR,
      actions: 'execute',
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    await client.callTool({ name: 'log_dose', arguments: {} });
    await client.callTool({ name: 'log_dose', arguments: {} });
    const [first, second] = seen;
    expect(first?.pageContext).toEqual({ channel: 'mcp' });
    expect(first?.idempotencyKey).toBe(`${first?.runId}:${first?.toolCallId}`);
    expect(first?.toolCallId).not.toBe(second?.toolCallId);
    expect(first?.idempotencyKey).not.toBe(second?.idempotencyKey);
  });
});

describe('server instructions', () => {
  it('reaches the client in the initialize result', async () => {
    const server = createMcpServer({
      name: 'test',
      version: '0.0.0',
      instructions: 'Start with list_profiles.',
      registry: new ToolRegistry(),
      policy: new DefaultRolesPolicy(),
      actorFromAuth: () => ACTOR,
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    expect(client.getInstructions()).toBe('Start with list_profiles.');
  });
});

describe('tool annotations in tools/list', () => {
  async function list(describeTool?: Parameters<typeof createMcpServer>[0]['describeTool']) {
    const server = createMcpServer({
      name: 'test',
      version: '0.0.0',
      registry: buildRegistry(),
      policy: new DefaultRolesPolicy(),
      actorFromAuth: () => ACTOR,
      actions: 'execute',
      ...(describeTool ? { describeTool } : {}),
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return (await client.listTools()).tools;
  }

  it('says a read is read-only and an action is not, by default', async () => {
    const tools = await list();
    expect(tools.find((t) => t.name === 'search_docs')?.annotations).toEqual({
      readOnlyHint: true,
    });
    expect(tools.find((t) => t.name === 'purge_cache')?.annotations).toEqual({
      readOnlyHint: false,
    });
  });

  it('describeTool sets the title and the annotations', async () => {
    // async: a describer may load its metadata lazily
    const tools = await list(async (tool) =>
      tool.name === 'purge_cache'
        ? { title: 'Purge the cache', annotations: { readOnlyHint: false, destructiveHint: true } }
        : undefined,
    );
    const purge = tools.find((t) => t.name === 'purge_cache');
    expect(purge?.title).toBe('Purge the cache');
    expect(purge?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(tools.find((t) => t.name === 'search_docs')?.annotations).toEqual({
      readOnlyHint: true,
    });
  });
});
