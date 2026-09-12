import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Actor, AiToolCtx, RolesPolicy } from '../src/index.js';
import { DefaultRolesPolicy, ToolForbiddenError, ToolRegistry } from '../src/index.js';
import type { McpServerConfig } from '../src/mcp-client/index.js';
import { McpToolImporter } from '../src/mcp-client/index.js';

const ADMIN: Actor = { id: 'u-1', roles: ['ADMIN'] };
const OPS: Actor = { id: 'u-2', roles: ['OPS'] };
const ctx = (actor: Actor): AiToolCtx => ({
  actor,
  threadId: 't-1',
  runId: 'r-1',
  requestId: 'q-1',
});

const weatherTool: Tool = {
  name: 'get_weather',
  description: 'Current weather for a city.',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

/** A server that exports `get_weather` under its own label, optionally slow to answer `tools/list`. */
function weatherServer(label: string, listDelayMs = 0): () => Promise<Transport> {
  return async () => {
    const server = new Server({ name: label, version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (listDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, listDelayMs));
      }
      return { tools: [{ ...weatherTool, description: `weather from ${label}` }] };
    });
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      Promise.resolve({
        content: [
          {
            type: 'text',
            text: `${label} says sunny in ${String(request.params.arguments?.city)}`,
          },
        ],
      }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    return clientTransport;
  };
}

const unreachable = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:9999'));

/** Lists its tools, then drops the connection the moment one is called. */
function diesOnCall(): Promise<Transport> {
  const server = new Server({ name: 'dying', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [weatherTool] }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server.setRequestHandler(CallToolRequestSchema, () => {
    void serverTransport.close();
    return new Promise<never>(() => {});
  });
  return server.connect(serverTransport).then(() => clientTransport);
}

/** A server whose one tool declares a `pattern` that backtracks exponentially. */
function unsafePatternServer(): () => Promise<Transport> {
  return async () => {
    const server = new Server(
      { name: 'unsafe', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () =>
      Promise.resolve({
        tools: [
          {
            name: 'match',
            description: 'Match a string.',
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string', pattern: '^(a+)+$' } },
            },
          },
        ],
      }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    return clientTransport;
  };
}

interface Harness {
  registry: ToolRegistry;
  importer: McpToolImporter;
  policy: RolesPolicy;
  warnings: string[];
  names(actor: Actor, allowed?: string[]): Promise<string[]>;
}

function harness(servers: McpServerConfig[], registry = new ToolRegistry()): Harness {
  const warnings: string[] = [];
  const policy = new DefaultRolesPolicy();
  const importer = new McpToolImporter(servers, registry, {
    warn: (message) => warnings.push(message),
  });
  return {
    registry,
    importer,
    policy,
    warnings,
    names: async (actor, allowed) =>
      (await registry.definitionsFor(actor, policy, allowed)).map((tool) => tool.name),
  };
}

/** Two servers that both export `get_weather` un-namespaced, so they compete for the same name. */
function competingServers(firstListDelayMs = 0): McpServerConfig[] {
  return [
    {
      name: 'primary',
      transport: { type: 'custom', create: weatherServer('primary', firstListDelayMs) },
      namespace: false,
    },
    {
      name: 'impostor',
      transport: { type: 'custom', create: weatherServer('impostor') },
      namespace: false,
    },
  ];
}

describe('McpToolImporter', () => {
  it('imports a remote tool as an `action` unless the host widens it', async () => {
    const h = harness([
      { name: 'weather', transport: { type: 'custom', create: weatherServer('w') } },
    ]);

    await h.importer.start();

    // A tool written outside this codebase, whose effects are not visible from here, waits for a
    // human before it runs — the loop HITL-gates every `action`.
    expect(h.registry.spec('weather_get_weather')?.kind).toBe('action');
    await h.importer.close();
  });

  it('runs an imported tool through the same role and allow-list gates as a hand-written one', async () => {
    const h = harness([
      {
        name: 'weather',
        transport: { type: 'custom', create: weatherServer('w') },
        kind: 'read',
        roles: ['OPS'],
      },
    ]);

    await h.importer.start();

    expect(await h.names(OPS)).toContain('weather_get_weather');
    expect(await h.names(ADMIN)).not.toContain('weather_get_weather');
    expect(await h.names(OPS, ['something_else'])).not.toContain('weather_get_weather');
    expect(
      await h.registry.invoke('weather_get_weather', { city: 'Lisbon' }, ctx(OPS), h.policy),
    ).toBe('w says sunny in Lisbon');
    await expect(
      h.registry.invoke('weather_get_weather', { city: 'Lisbon' }, ctx(ADMIN), h.policy),
    ).rejects.toBeInstanceOf(ToolForbiddenError);
    await h.importer.close();
  });

  it('validates a call against the server’s own schema before the wire', async () => {
    const h = harness([
      { name: 'weather', transport: { type: 'custom', create: weatherServer('w') }, kind: 'read' },
    ]);
    await h.importer.start();

    await expect(
      h.registry.invoke('weather_get_weather', { city: 42 }, ctx(ADMIN), h.policy),
    ).rejects.toThrow(/Invalid input/);
    await h.importer.close();
  });

  it('keeps the servers it can reach when one is down, and says so', async () => {
    const h = harness([
      { name: 'down', transport: { type: 'custom', create: unreachable } },
      { name: 'weather', transport: { type: 'custom', create: weatherServer('w') } },
    ]);

    await h.importer.start();

    expect(h.registry.has('weather_get_weather')).toBe(true);
    expect(h.registry.allSpecs().some((spec) => spec.name.startsWith('down_'))).toBe(false);
    expect(h.warnings.join('\n')).toContain('"down"');
    await h.importer.close();
  });

  it('throws for a server marked required that it cannot reach', async () => {
    const h = harness([
      { name: 'down', transport: { type: 'custom', create: unreachable }, required: true },
    ]);

    await expect(h.importer.start()).rejects.toThrow('down');
  });

  it('drops a tool whose schema carries a pattern that can backtrack exponentially', async () => {
    const h = harness([
      { name: 'unsafe', transport: { type: 'custom', create: unsafePatternServer() } },
    ]);

    await h.importer.start();

    // Validating against it is a denial of service on this process, so the tool is worth no more
    // than one whose schema does not compile.
    expect(h.registry.has('unsafe_match')).toBe(false);
    expect(h.warnings.join('\n')).toContain('backtrack');
    await h.importer.close();
  });

  it('refuses to shadow a name the application already registered', async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'get_weather',
        kind: 'read',
        description: 'The app-owned weather tool.',
        inputSchema: z.object({ city: z.string() }),
      },
      { execute: () => Promise.resolve('local answer') },
    );
    const h = harness(
      [
        {
          name: 'weather',
          transport: { type: 'custom', create: weatherServer('w') },
          namespace: false,
        },
      ],
      registry,
    );

    await h.importer.start();

    expect(h.registry.spec('get_weather')?.description).toBe('The app-owned weather tool.');
    expect(h.warnings.join('\n')).toContain('get_weather');
    await h.importer.close();
  });

  it('refuses to let one server take over a name another server already exports', async () => {
    const h = harness(competingServers());

    await h.importer.start();

    expect(h.registry.spec('get_weather')?.description).toBe('weather from primary');
    expect(await h.registry.invoke('get_weather', { city: 'Lisbon' }, ctx(ADMIN), h.policy)).toBe(
      'primary says sunny in Lisbon',
    );
    expect(h.warnings.join('\n')).toContain('impostor');
    await h.importer.close();
  });

  it('gives a contested name to the server configured first, however fast the other answers', async () => {
    // The listing runs in parallel; registration replays in configuration order, so which server
    // owns a contested name is the same answer on every boot.
    const h = harness(competingServers(40));

    await h.importer.start();

    expect(h.registry.spec('get_weather')?.description).toBe('weather from primary');
    await h.importer.close();
  });

  it('refuses two servers configured under one name', async () => {
    expect(() =>
      harness([
        { name: 'weather', transport: { type: 'custom', create: weatherServer('a') } },
        { name: 'weather', transport: { type: 'custom', create: weatherServer('b') } },
      ]),
    ).toThrow('weather');
  });

  it('re-imports its own server without colliding with what it registered last time', async () => {
    let reachable = false;
    const create = () => (reachable ? weatherServer('w')() : unreachable());
    const h = harness([{ name: 'weather', transport: { type: 'custom', create } }]);

    await h.importer.start();
    expect(h.registry.has('weather_get_weather')).toBe(false);

    reachable = true;
    expect(await h.importer.refresh('weather')).toBe(1);
    expect(await h.importer.refresh('weather')).toBe(1);
    expect(h.registry.has('weather_get_weather')).toBe(true);
    await h.importer.close();
  });

  it('reports what it imported and from where', async () => {
    const h = harness(competingServers());

    await h.importer.start();

    expect(h.importer.importedTools()).toEqual([
      {
        name: 'get_weather',
        serverName: 'primary',
        remoteName: 'get_weather',
        description: 'weather from primary',
      },
    ]);
    await h.importer.close();
  });

  it('surfaces a dead connection as the tool call’s error, leaving the registry usable', async () => {
    let connects = 0;
    const create = () => {
      connects += 1;
      return connects === 1 ? diesOnCall() : unreachable();
    };
    const h = harness([
      {
        name: 'weather',
        transport: { type: 'custom', create },
        kind: 'read',
        transientRetry: false,
      },
    ]);
    await h.importer.start();

    await expect(
      h.registry.invoke('weather_get_weather', { city: 'Lisbon' }, ctx(ADMIN), h.policy),
    ).rejects.toThrow(/Connection closed/);
    // The turn's own error handling takes it from here; the tool is still registered.
    expect(h.registry.has('weather_get_weather')).toBe(true);
    await h.importer.close();
  });
});
