import { describe, expect, it } from 'vitest';
import {
  anyAuthorize,
  authorizeByToken,
  resolveConsoleAuthorize,
} from '../src/console-authorize.js';
import { agentDevTools } from '../src/dev-tools/agent-tools.js';
import type { DevTool, DevToolsLib } from '../src/dev-tools/contract.js';
import { csrfBlocksPath } from '../src/dev-tools/csrf.js';
import { actionAllowed } from '../src/dev-tools/endpoint.js';
import { DevToolsHubImpl } from '../src/dev-tools/hub.js';
import { registerDevTools } from '../src/dev-tools/index.js';
import {
  capDevToolResult,
  DEV_TOOLS_MAX_BYTES,
  redactDevToolOutput,
  truncateText,
} from '../src/dev-tools/limits.js';
import { devToolStandardSchema, validateDevToolInput } from '../src/dev-tools/schema.js';
import { InMemoryGovernanceQueries } from '../src/testing/in-memory-governance-queries.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';

const tool = (name: string, extra: Partial<DevTool> = {}): DevTool => ({
  name,
  kind: 'read',
  description: 'test tool',
  input: { type: 'object', properties: {} },
  run: async () => ({ ok: true }),
  ...extra,
});

const lib = (id: string, tools: DevTool[]): DevToolsLib => ({
  lib: id,
  title: id,
  authorize: async () => ({ allowed: true }),
  tools,
});

describe('dev tools hub: the registration contract', () => {
  it('registers a lib and finds the owner of each tool', () => {
    const hub = new DevToolsHubImpl();
    hub.register(lib('durable', [tool('durable_list_runs'), tool('durable_get_run')]));
    expect(hub.version).toBe(1);
    expect(hub.libOf('durable_get_run')?.lib).toBe('durable');
    expect(hub.libOf('telescope_list_entries')).toBeUndefined();
  });

  it('refuses a duplicate lib, a bad lib id, an unprefixed or non-snake name', () => {
    const hub = new DevToolsHubImpl();
    hub.register(lib('durable', [tool('durable_list_runs')]));
    expect(() => hub.register(lib('durable', []))).toThrow(/already registered/);
    expect(() => hub.register(lib('Durable', []))).toThrow(/lib id/);
    expect(() => hub.register(lib('media', [tool('list_objects')]))).toThrow(/prefixed/);
    expect(() => hub.register(lib('media', [tool('durable_list_runs')]))).toThrow(
      /prefixed by its lib/,
    );
    expect(() => hub.register(lib('media', [tool('media_listObjects')]))).toThrow(/snake_case/);
    expect(() =>
      hub.register(lib('media', [tool('media_list_objects'), tool('media_list_objects')])),
    ).toThrow(/twice/);
  });

  it('refuses a schema outside the subset', () => {
    const hub = new DevToolsHubImpl();
    const nested = tool('media_list_objects', {
      input: {
        type: 'object',
        properties: { filter: { type: 'object' } },
      } as unknown as DevTool['input'],
    });
    expect(() => hub.register(lib('media', [nested]))).toThrow(/property "filter"/);
    const arrayOfNumbers = tool('media_list_objects', {
      input: {
        type: 'object',
        properties: { keys: { type: 'array', items: { type: 'number' } } },
      } as unknown as DevTool['input'],
    });
    expect(() => hub.register(lib('media', [arrayOfNumbers]))).toThrow(/items/);
    const extraKeyword = tool('media_list_objects', {
      input: { type: 'object', properties: {}, additionalProperties: true } as never,
    });
    expect(() => hub.register(lib('media', [extraKeyword]))).toThrow(/additionalProperties/);
  });

  it('applies exclude at registration: a lib id or a full tool name', () => {
    const hub = new DevToolsHubImpl({ exclude: ['payments', 'durable_get_run'] });
    hub.register(lib('durable', [tool('durable_list_runs'), tool('durable_get_run')]));
    hub.register(lib('payments', [tool('payments_list_payments')]));
    expect(hub.servedLibs().map((l) => l.lib)).toEqual(['durable']);
    expect(hub.libOf('durable_get_run')).toBeUndefined();
    expect(hub.libOf('payments_list_payments')).toBeUndefined();
    expect(hub.servedLibs()[0]?.tools.map((t) => t.name)).toEqual(['durable_list_runs']);
  });

  it('registerDevTools is a no-op without the binding or with another version', async () => {
    const without = { container: { hasBinding: () => false, make: async () => undefined } };
    expect(await registerDevTools(without, lib('durable', []))).toBe(false);
    const v2 = {
      container: { hasBinding: () => true, make: async () => ({ version: 2, register() {} }) },
    };
    expect(await registerDevTools(v2, lib('durable', []))).toBe(false);
    const hub = new DevToolsHubImpl();
    const withHub = { container: { hasBinding: () => true, make: async () => hub } };
    expect(await registerDevTools(withHub, lib('durable', [tool('durable_list_runs')]))).toBe(true);
    expect(hub.servedLibs()).toHaveLength(1);
  });
});

describe('dev tools input validation', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      id: { type: 'string' as const },
      status: { type: 'string' as const, enum: ['running', 'failed'] },
      limit: { type: 'integer' as const, minimum: 1, maximum: 100 },
      full: { type: 'boolean' as const },
      keys: { type: 'array' as const, items: { type: 'string' as const } },
    },
    required: ['id'],
  };

  it('accepts a valid input', () => {
    expect(
      validateDevToolInput(schema, { id: 'r1', status: 'failed', limit: 5, keys: ['a'] }),
    ).toEqual({ value: { id: 'r1', status: 'failed', limit: 5, keys: ['a'] } });
  });

  it('rejects extra, missing and mistyped fields', () => {
    const result = validateDevToolInput(schema, {
      status: 'done',
      limit: 1.5,
      full: 'yes',
      keys: [1],
      extra: true,
    });
    expect('issues' in result && result.issues.map((issue) => issue.message)).toEqual([
      'unknown property "extra"',
      '"id" is required',
      '"status" must be one of running, failed',
      '"limit" must be an integer',
      '"full" must be a boolean',
      '"keys" must be an array of strings',
    ]);
    const tooBig = validateDevToolInput(schema, { id: 'x', limit: 101 });
    expect('issues' in tooBig && tooBig.issues[0]?.message).toBe('"limit" must be at most 100');
  });

  it('wraps the subset as a Standard Schema whose JSON Schema is closed', async () => {
    const standard = devToolStandardSchema(schema);
    expect(standard['~standard'].jsonSchema.input()).toMatchObject({
      type: 'object',
      required: ['id'],
      additionalProperties: false,
    });
    expect(await standard['~standard'].validate({ id: 'x' })).toEqual({ value: { id: 'x' } });
  });
});

describe('dev tools limits and redaction', () => {
  it('drops secret-looking values but keeps counts', () => {
    expect(
      redactDevToolOutput({
        clientSecret: 's3cr3t',
        accessToken: 'abc',
        headers: { Authorization: 'Bearer x', cookie: 'a=b', 'x-api-key': 'k' },
        inputTokens: 12,
        totalTokens: '345',
        password: null,
        nested: [{ api_key: 'k' }],
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ).toEqual({
      clientSecret: '[redacted]',
      accessToken: '[redacted]',
      headers: { Authorization: '[redacted]', cookie: '[redacted]', 'x-api-key': '[redacted]' },
      inputTokens: 12,
      totalTokens: '345',
      password: null,
      nested: [{ api_key: '[redacted]' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('caps a list at 48 KB, appending truncated and next', () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ id: i, blob: 'x'.repeat(200) }));
    const text = capDevToolResult({ items, next: 3 });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEV_TOOLS_MAX_BYTES);
    const parsed = JSON.parse(text);
    expect(parsed.truncated).toBe(true);
    expect(parsed.next).toBe(3);
    expect(parsed.items.length).toBeGreaterThan(100);
    expect(parsed.items.length).toBeLessThan(500);
  });

  it('cuts a single blob as text, saying how big it was', () => {
    const text = truncateText('é'.repeat(5000), 4096);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/…\(truncated, 10000 bytes\)$/);
    expect(capDevToolResult({ ok: true })).toBe('{"ok":true}');
  });
});

describe('dev tools actions', () => {
  it('refuses by default, executes all, or a list of libs / tool names', () => {
    expect(actionAllowed('refuse', 'durable', 'durable_retry_run')).toBe(false);
    expect(actionAllowed('execute', 'durable', 'durable_retry_run')).toBe(true);
    expect(actionAllowed(['durable'], 'durable', 'durable_retry_run')).toBe(true);
    expect(actionAllowed(['payments_refund_payment'], 'durable', 'durable_retry_run')).toBe(false);
    expect(actionAllowed(['payments_refund_payment'], 'payments', 'payments_refund_payment')).toBe(
      true,
    );
  });
});

describe('dev tools CSRF probe', () => {
  it('warns when CSRF is on and exceptRoutes does not cover the path', () => {
    expect(csrfBlocksPath(undefined, 'mcp/agora')).toBe(false);
    expect(csrfBlocksPath({ csrf: { enabled: false } }, 'mcp/agora')).toBe(false);
    expect(csrfBlocksPath({ csrf: { enabled: true } }, 'mcp/agora')).toBe(true);
    expect(csrfBlocksPath({ csrf: { enabled: true, exceptRoutes: ['/api/*'] } }, 'mcp/agora')).toBe(
      true,
    );
    expect(
      csrfBlocksPath({ csrf: { enabled: true, exceptRoutes: ['/mcp/agora'] } }, 'mcp/agora'),
    ).toBe(false);
    expect(csrfBlocksPath({ csrf: { enabled: true, methods: ['PUT'] } }, 'mcp/agora')).toBe(false);
  });

  it('probes a function exceptRoutes with the request url', () => {
    // meuprontoo's shape: a function over `ctx.request.url()`.
    const apiOnly = (ctx: { request: { url(): string } }) => ctx.request.url().startsWith('/api/');
    expect(csrfBlocksPath({ csrf: { enabled: true, exceptRoutes: apiOnly } }, 'mcp/agora')).toBe(
      true,
    );
    const covers = (ctx: { request: { url(): string } }) =>
      ctx.request.url() === '/mcp/agora' || ctx.request.url().startsWith('/api/');
    expect(csrfBlocksPath({ csrf: { enabled: true, exceptRoutes: covers } }, 'mcp/agora')).toBe(
      false,
    );
    const throws = () => {
      throw new Error('needs a real ctx');
    };
    expect(csrfBlocksPath({ csrf: { enabled: true, exceptRoutes: throws } }, 'mcp/agora')).toBe(
      false,
    );
  });
});

describe('anyAuthorize', () => {
  const ctxWith = (authorization?: string) =>
    ({
      request: {
        header: (name: string) => (name === 'authorization' ? authorization : undefined),
      },
    }) as never;

  it('allows when any allows, else 401 when one was unauthenticated, else 403', async () => {
    const gate = resolveConsoleAuthorize(
      anyAuthorize(authorizeByToken({ token: 'tok' }), () => ({ redirectTo: '/login' })),
    );
    expect(await gate(ctxWith('Bearer tok'))).toEqual({ allowed: true });
    expect(await gate(ctxWith())).toEqual({ allowed: false, status: 401, redirectTo: '/login' });
    const forbidden = resolveConsoleAuthorize(
      anyAuthorize(
        () => false,
        () => {
          throw new Error('boom');
        },
      ),
    );
    expect(await forbidden(ctxWith())).toEqual({ allowed: false, status: 403 });
    expect(() => anyAuthorize()).toThrow(/at least one/);
  });
});

describe("the agent's own dev tools", () => {
  it('are seven read tools, prefixed agent_, inside the subset', () => {
    const tools = agentDevTools({
      governance: new InMemoryGovernanceQueries(new InMemoryAgentStore()),
    });
    expect(tools.map((t) => t.name)).toEqual([
      'agent_list_runs',
      'agent_get_run',
      'agent_get_spend',
      'agent_get_tool_stats',
      'agent_get_reliability',
      'agent_list_pending_approvals',
      'agent_list_recent_tool_calls',
    ]);
    expect(tools.every((t) => t.kind === 'read')).toBe(true);
    const hub = new DevToolsHubImpl();
    expect(() => hub.register(lib('agent', tools))).not.toThrow();
  });
});
