import { describe, expect, it } from 'vitest';
import {
  anyAuthorize,
  authorizeByToken,
  resolveConsoleAuthorize,
} from '../src/console-authorize.js';
import { type DevToolsActions, DevToolsActionsGate } from '../src/dev-tools/actions.js';
import { agentDevTools } from '../src/dev-tools/agent-tools.js';
import type { DevTool, DevToolsLib } from '../src/dev-tools/contract.js';
import { csrfBlocksPath, csrfWarning } from '../src/dev-tools/csrf.js';
import { DevToolsHubImpl, endpointAuthorizeWarning } from '../src/dev-tools/hub.js';
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

  it('accepts a lib without authorize on a hub that supports endpoint-authorize', async () => {
    const hub = new DevToolsHubImpl();
    expect(hub.supports('endpoint-authorize')).toBe(true);
    expect(hub.supports('something-else')).toBe(false);
    const withHub = { container: { hasBinding: () => true, make: async () => hub } };
    const consoleless: DevToolsLib = {
      lib: 'resilience',
      title: 'Resilience',
      tools: [tool('resilience_list_policies')],
    };
    expect(await registerDevTools(withHub, consoleless)).toBe(true);
    expect(hub.endpointGatedLibs().map((l) => l.lib)).toEqual(['resilience']);
    expect(() => hub.register({ ...lib('authz', []), authorize: 'nope' as never })).toThrow(
      /not a function/,
    );

    // an older hub (no supports()) never receives a lib without authorize
    let got = 0;
    const oldHub = {
      container: {
        hasBinding: () => true,
        make: async () => ({
          version: 1,
          register() {
            got += 1;
          },
        }),
      },
    };
    expect(await registerDevTools(oldHub, consoleless)).toBe(false);
    expect(got).toBe(0);
  });

  it('warns once about console-less libs only when devTools.authorize is not set', () => {
    expect(endpointAuthorizeWarning([], undefined)).toBeUndefined();
    expect(endpointAuthorizeWarning(['resilience'], () => true)).toBeUndefined();
    expect(endpointAuthorizeWarning(['resilience', 'authz'], undefined)).toBe(
      '[@adonis-agora/agent] dev tools for resilience, authz have no authorize: open outside production, denied in production. Set devTools.authorize in config/mcp.ts.',
    );
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

  it('redacts a numeric secret, keeping only token counts', () => {
    expect(
      redactDevToolOutput({
        otpSecret: 123456,
        apiKey: '987654',
        pinToken: 42,
        tokenCount: 7,
        cacheReadTokens: '9',
        hasPassword: true,
      }),
    ).toEqual({
      otpSecret: '[redacted]',
      apiKey: '[redacted]',
      pinToken: '[redacted]',
      tokenCount: 7,
      cacheReadTokens: '9',
      hasPassword: true,
    });
  });

  it('writes out an object reached twice, and marks only a real cycle', () => {
    const definition = { enabled: true, variants: { on: true, off: false } };
    const shared = { key: 'beta', stored: definition, definition, list: [definition, definition] };
    expect(redactDevToolOutput(shared)).toEqual({
      key: 'beta',
      stored: { enabled: true, variants: { on: true, off: false } },
      definition: { enabled: true, variants: { on: true, off: false } },
      list: [
        { enabled: true, variants: { on: true, off: false } },
        { enabled: true, variants: { on: true, off: false } },
      ],
    });

    const loop: Record<string, unknown> = { name: 'a' };
    loop.self = loop;
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(redactDevToolOutput({ loop, arr })).toEqual({
      loop: { name: 'a', self: '[circular]' },
      arr: [1, '[circular]'],
    });
  });

  it('keeps an oversized detail object valid JSON, cutting its biggest parts', () => {
    const detail = {
      run: { id: 'r1', status: 'failed' },
      messages: Array.from({ length: 60 }, (_, i) => ({ id: i, content: 'x'.repeat(2000) })),
      output: 'y'.repeat(30_000),
    };
    const text = capDevToolResult(detail);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEV_TOOLS_MAX_BYTES);
    const parsed = JSON.parse(text);
    expect(parsed.truncated).toBe(true);
    expect(parsed.run).toEqual({ id: 'r1', status: 'failed' });
    expect(parsed.messages.length).toBeLessThan(60);
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
  const caller = { id: 'user:1', via: 'session' as const };
  const ctx = { request: {} } as never;
  const decide = (actions: DevToolsActions, lib: string, tool: string) =>
    new DevToolsActionsGate(actions, ctx, caller).decide({ lib, tool, destructive: false });

  it('refuses by default, executes all, or a list of libs / tool names', async () => {
    expect(await decide('refuse', 'durable', 'durable_retry_run')).toEqual({
      reason: 'not-configured',
    });
    expect(await decide('execute', 'durable', 'durable_retry_run')).toBe(true);
    expect(await decide(['durable'], 'durable', 'durable_retry_run')).toBe(true);
    expect(await decide(['payments_refund_payment'], 'durable', 'durable_retry_run')).not.toBe(
      true,
    );
    expect(await decide(['payments_refund_payment'], 'payments', 'payments_refund_payment')).toBe(
      true,
    );
  });

  it('map: a tool key wins over its lib key; neither refuses; throw and redirectTo deny', async () => {
    const actions: DevToolsActions = {
      payments: () => true,
      payments_refund_payment: () => false,
      durable: () => ({ redirectTo: '/login' }),
      telescope: () => {
        throw new Error('boom');
      },
    };
    expect(await decide(actions, 'payments', 'payments_capture_payment')).toBe(true);
    expect(await decide(actions, 'payments', 'payments_refund_payment')).toEqual({
      reason: 'denied',
    });
    expect(await decide(actions, 'media', 'media_delete_file')).toEqual({
      reason: 'not-configured',
    });
    expect(await decide(actions, 'durable', 'durable_retry_run')).toEqual({ reason: 'denied' });
    expect(await decide(actions, 'telescope', 'telescope_prune')).toMatchObject({
      reason: 'threw',
    });
    // `{ allowed: false }`, an authz-style result, and a key on the prototype chain all deny.
    expect(await decide({ durable: () => ({ allowed: false }) }, 'durable', 'x')).not.toBe(true);
    expect(await decide(null as never, 'durable', 'durable_retry_run')).toEqual({
      reason: 'not-configured',
    });
    expect(await decide({}, 'constructor', 'constructor_x')).toEqual({
      reason: 'not-configured',
    });
  });

  it('map: takes an authorizeByRoles-shaped hook ({ allowed: boolean, reason })', async () => {
    const byRoles =
      (allowed: boolean) =>
      async (_ctx: unknown): Promise<boolean | { allowed: boolean; reason?: 'forbidden' }> =>
        allowed ? true : { allowed: false, reason: 'forbidden' };
    const actions: DevToolsActions = { flags: byRoles(true), payments: byRoles(false) };
    expect(await decide(actions, 'flags', 'flags_save_flag')).toBe(true);
    expect(await decide(actions, 'payments', 'payments_refund_payment')).toEqual({
      reason: 'denied',
    });
  });

  it('map: runs each distinct authorize once per request, whatever the tool count', async () => {
    let runs = 0;
    const admin = () => {
      runs += 1;
      return true;
    };
    const gate = new DevToolsActionsGate({ flags: admin, payments: admin }, ctx, caller);
    for (const [lib, tool] of [
      ['flags', 'flags_save_flag'],
      ['flags', 'flags_delete_flag'],
      ['payments', 'payments_refund_payment'],
    ] as const) {
      expect(await gate.decide({ lib, tool, destructive: false })).toBe(true);
    }
    expect(runs).toBe(1);
    // A new request runs it again.
    await new DevToolsActionsGate({ flags: admin }, ctx, caller).decide({
      lib: 'flags',
      tool: 'flags_save_flag',
      destructive: false,
    });
    expect(runs).toBe(2);
  });

  it('map: takes an authorizer class (built through the container) and a lazy import', async () => {
    class Owner {
      authorize() {
        return { allowed: true as const };
      }
    }
    const made: unknown[] = [];
    const withContainer = {
      request: {},
      containerResolver: {
        make: async (Class: new () => unknown) => {
          made.push(Class);
          return new Class();
        },
      },
    } as never;
    const gate = new DevToolsActionsGate(
      { flags: Owner, payments: async () => ({ default: Owner }) },
      withContainer,
      caller,
    );
    expect(await gate.decide({ lib: 'flags', tool: 'flags_save_flag', destructive: false })).toBe(
      true,
    );
    expect(
      await gate.decide({ lib: 'payments', tool: 'payments_refund_payment', destructive: true }),
    ).toBe(true);
    expect(made).toEqual([Owner, Owner]);
  });

  it('function: gets lib, tool, destructive and caller; a throw or non-true denies', async () => {
    const seen: unknown[] = [];
    const gate = new DevToolsActionsGate(
      async (_ctx, action) => {
        seen.push(action);
        if (action.lib === 'media') throw new Error('boom');
        return !action.destructive;
      },
      ctx,
      caller,
    );
    expect(await gate.decide({ lib: 'flags', tool: 'flags_save_flag', destructive: false })).toBe(
      true,
    );
    expect(
      await gate.decide({ lib: 'payments', tool: 'payments_refund_payment', destructive: true }),
    ).toEqual({ reason: 'denied' });
    expect(
      await gate.decide({ lib: 'media', tool: 'media_delete_file', destructive: true }),
    ).toMatchObject({ reason: 'threw' });
    expect(seen[0]).toEqual({ lib: 'flags', tool: 'flags_save_flag', destructive: false, caller });
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

  it('an empty methods list checks no method; a throwing exceptRoutes is unknown, not exempt', () => {
    expect(csrfBlocksPath({ csrf: { enabled: true, methods: [] } }, 'mcp/agora')).toBe(true); // shield: empty methods = every method
    const throws = () => {
      throw new Error('needs a real ctx');
    };
    expect(csrfBlocksPath({ csrf: { enabled: true, exceptRoutes: throws } }, 'mcp/agora')).toBe(
      'unknown',
    );
    expect(csrfWarning('mcp/agora', 'unknown')).toContain('may be blocked');
    expect(csrfWarning('mcp/agora')).toContain('are blocked');
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
