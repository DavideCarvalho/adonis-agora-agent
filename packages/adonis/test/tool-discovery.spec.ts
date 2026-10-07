import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Actor, AiToolCtx, ToolHandler } from '../src/index.js';
import {
  ActionTool,
  AgentDepsFactory,
  AgentRegistry,
  AiTool,
  DefaultRolesPolicy,
  defineTool,
  delegateToolName,
  discoverTools,
  readAiToolMeta,
  registerDelegateTools,
  registerToolExport,
  registerToolsFromBarrel,
  ToolRegistry,
} from '../src/index.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'agent_tools');

@AiTool({
  name: 'getWeather',
  kind: 'read',
  description: 'Get the weather',
  input: z.object({ city: z.string() }),
})
class GetWeatherTool implements ToolHandler<{ city: string }> {
  async execute(input: { city: string }, _ctx: AiToolCtx) {
    return { tempC: 21, city: input.city };
  }
}

const purgeCache = defineTool(
  {
    name: 'purgeCache',
    kind: 'action',
    description: 'Purge a cache key',
    input: z.object({ key: z.string() }),
  },
  async ({ key }: { key: string }) => ({ purged: key }),
);

// Decorator-free authoring form: `static tool` config, mirroring durable's `static workflow`.
class GetTimeTool implements ToolHandler<Record<string, never>> {
  static tool = {
    name: 'getTime',
    kind: 'read',
    description: 'Get the current time',
    input: z.object({}),
    ability: 'clock.read',
  } as const;

  async execute(_input: Record<string, never>, _ctx: AiToolCtx) {
    return { iso: '2020-01-01T00:00:00Z' };
  }
}

// A tool with a constructor dependency — only resolvable through the IoC container, never `new X()`.
class NeedsDep implements ToolHandler<Record<string, never>> {
  static tool = {
    name: 'needsDep',
    kind: 'read',
    description: 'Depends on an injected service',
    input: z.object({}),
  } as const;

  constructor(private dep: { value: () => string }) {}

  async execute(_input: Record<string, never>, _ctx: AiToolCtx) {
    return { got: this.dep.value() };
  }
}

const allowAll = { can: async () => true };
const anyCtx = {
  actor: { id: 'u', roles: ['ADMIN'] },
  threadId: 't',
  runId: 'r',
  requestId: 'q',
} as unknown as AiToolCtx;

describe('tool discovery', () => {
  it('reads @AiTool metadata off a decorated class', () => {
    const meta = readAiToolMeta(GetWeatherTool);
    expect(meta?.name).toBe('getWeather');
    expect(meta?.kind).toBe('read');
  });

  it('registers an @AiTool class into the ToolRegistry (roles default to ADMIN)', () => {
    const registry = new ToolRegistry();
    const result = registerToolExport(registry, GetWeatherTool, ['ADMIN']);
    expect(result).toEqual({ name: 'getWeather', source: 'class' });
    expect(registry.has('getWeather')).toBe(true);
    expect(registry.spec('getWeather')?.roles).toEqual(['ADMIN']);
  });

  it('reads metadata off a decorator-free `static tool` class', () => {
    const meta = readAiToolMeta(GetTimeTool);
    expect(meta?.name).toBe('getTime');
    expect(meta?.kind).toBe('read');
    expect(meta?.ability).toBe('clock.read');
  });

  it('registers a `static tool` class into the ToolRegistry (no decorator)', () => {
    const registry = new ToolRegistry();
    const result = registerToolExport(registry, GetTimeTool, ['ADMIN']);
    expect(result).toEqual({ name: 'getTime', source: 'class' });
    expect(registry.has('getTime')).toBe(true);
    expect(registry.spec('getTime')?.ability).toBe('clock.read');
  });

  it('carries a class tool`s replacementKey onto the registered spec', () => {
    const keyFn = (input: unknown) => (input as { id: string }).id;
    @AiTool({
      name: 'replaceable',
      kind: 'action',
      description: 'A replaceable proposal',
      input: z.object({ id: z.string() }),
      replacementKey: keyFn,
    })
    class ReplaceableTool implements ToolHandler<{ id: string }> {
      async execute() {
        return {};
      }
    }
    class StaticReplaceableTool implements ToolHandler<Record<string, never>> {
      static tool = {
        name: 'staticReplaceable',
        kind: 'action',
        description: 'A replaceable proposal',
        input: z.object({}),
        replacementKey: 'fixed',
      } as const;
      async execute() {
        return {};
      }
    }
    const registry = new ToolRegistry();
    registerToolExport(registry, ReplaceableTool, ['ADMIN']);
    registerToolExport(registry, StaticReplaceableTool, ['ADMIN']);
    expect(registry.spec('replaceable')?.replacementKey).toBe(keyFn);
    expect(registry.spec('staticReplaceable')?.replacementKey).toBe('fixed');
  });

  it('registers a defineTool functional tool', () => {
    const registry = new ToolRegistry();
    const result = registerToolExport(registry, purgeCache, ['ADMIN']);
    expect(result).toEqual({ name: 'purgeCache', source: 'functional' });
    expect(registry.spec('purgeCache')?.kind).toBe('action');
  });

  it('registers every tool reachable from a generated barrel (deduped)', async () => {
    const registry = new ToolRegistry();
    const barrel = {
      weather: () => Promise.resolve({ default: GetWeatherTool }),
      cache: () => Promise.resolve({ purgeCache }),
    };
    const registered = await registerToolsFromBarrel(registry, barrel, ['ADMIN']);
    expect(registered.map((r) => r.name).sort()).toEqual(['getWeather', 'purgeCache']);
    expect(registry.has('getWeather')).toBe(true);
    expect(registry.has('purgeCache')).toBe(true);
  });

  it('synthesizes an agent-kind delegate tool per delegatesTo edge', () => {
    const registry = new ToolRegistry();
    const agents = new AgentRegistry();
    agents.register({ name: 'orchestrator', delegatesTo: ['researcher'] });
    agents.register({ name: 'researcher', systemPrompt: 'You research things.' });
    const count = registerDelegateTools(registry, agents);
    expect(count).toBe(1);
    const name = delegateToolName('researcher');
    expect(name).toBe('ask_researcher');
    const spec = registry.spec(name);
    expect(spec?.kind).toBe('agent');
    expect(spec?.targetAgent).toBe('researcher');
    expect(spec?.description).toContain('You research things.');
  });

  it('discovers .ts tools from a source directory (a dev/ts app), skipping .d.ts declarations', async () => {
    // The scanned directory holds only `.ts` files — an app running from source under a TS loader.
    // The pre-fix scanner chose its extension from `extname(import.meta.url)` (this module ships as
    // `.js`), so it looked for `.js` tools here and registered nothing. The fixture also has a
    // `decl_only.d.ts` that must be skipped.
    const registry = new ToolRegistry();
    const registered = await discoverTools(registry, fixturesDir, ['ADMIN']);
    expect(registered.map((r) => r.name)).toContain('fixtureWeather');
    expect(registry.has('fixtureWeather')).toBe(true);
  });

  it('is a no-op for a missing directory (discovery is opt-in)', async () => {
    const registry = new ToolRegistry();
    const registered = await discoverTools(registry, join(fixturesDir, 'does_not_exist'), [
      'ADMIN',
    ]);
    expect(registered).toEqual([]);
  });

  it('skips a tool whose name is already registered (first wins)', () => {
    const registry = new ToolRegistry();
    expect(registerToolExport(registry, GetWeatherTool, ['ADMIN'])).not.toBeNull();
    expect(registerToolExport(registry, GetWeatherTool, ['ADMIN'])).toBeNull();
  });

  it('resolves a class tool through the container (@inject) — lazily and cached — when an app is given', async () => {
    const registry = new ToolRegistry();
    let makeCalls = 0;
    const dep = { value: () => 'injected' };
    const fakeApp = {
      container: {
        make: async (cls: unknown) => {
          makeCalls++;
          return new (cls as new (d: typeof dep) => ToolHandler)(dep);
        },
      },
    };

    const result = registerToolExport(registry, NeedsDep, ['ADMIN'], fakeApp as never);
    expect(result).not.toBeNull();
    // Lazy: registration must NOT touch the container (boot runs before the app is fully booted).
    expect(makeCalls).toBe(0);

    const out = await registry.invoke('needsDep', {}, anyCtx, allowAll as never);
    // The dep came from the container — a `new NeedsDep()` would have no `dep` and throw.
    expect(out).toEqual({ got: 'injected' });
    expect(makeCalls).toBe(1);

    // Cached: a second invocation reuses the resolved instance, no re-resolution.
    await registry.invoke('needsDep', {}, anyCtx, allowAll as never);
    expect(makeCalls).toBe(1);
  });

  it('without an app, still instantiates a no-arg class tool with `new` (pre-DI behavior)', async () => {
    const registry = new ToolRegistry();
    expect(registerToolExport(registry, GetTimeTool, ['ADMIN'])).not.toBeNull();
    const out = await registry.invoke('getTime', {}, anyCtx, allowAll as never);
    expect(out).toEqual({ iso: '2020-01-01T00:00:00Z' });
  });
});

/** Stands in for a config service / entitlement table — mutable, so a test can flip it live. */
class Switchboard {
  featureOn = false;
  entitled = new Set<string>();
}

class FlaggedTool implements ToolHandler<Record<string, never>> {
  static tool = {
    name: 'flaggedTool',
    kind: 'read',
    description: 'behind a deployment flag',
    input: z.object({}),
  } as const;

  constructor(private readonly switchboard: Switchboard) {}

  isEnabled(): boolean {
    return this.switchboard.featureOn;
  }

  async execute() {
    return { ok: true };
  }
}

class EntitledTool implements ToolHandler<Record<string, never>> {
  static tool = {
    name: 'entitledTool',
    kind: 'read',
    description: 'per-user entitlement',
    input: z.object({}),
  } as const;

  constructor(private readonly switchboard: Switchboard) {}

  canUse(actor: Actor): boolean {
    return this.switchboard.entitled.has(actor.id);
  }

  async execute() {
    return { ok: true };
  }
}

@AiTool({
  name: 'staticallyOffTool',
  description: 'off by decorator',
  input: z.object({}),
  enabled: false,
})
class StaticallyOffTool implements ToolHandler<Record<string, never>> {
  async execute() {
    return { ok: true };
  }
}

class PlainTool implements ToolHandler<Record<string, never>> {
  static tool = {
    name: 'plainTool',
    kind: 'read',
    description: 'no gates of its own',
    input: z.object({}),
  } as const;

  async execute() {
    return { ok: true };
  }
}

/**
 * `isEnabled()` / `canUse()` live on the tool CLASS, while the registry holds a wrapper discovery
 * builds. These cover the forwarding: a gate that stayed behind on the class would be one an app
 * declares, sees no error for, and that never runs.
 */
describe('tool discovery — availability gates on the class', () => {
  const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
  const policy = new DefaultRolesPolicy();

  function build() {
    const switchboard = new Switchboard();
    const registry = new ToolRegistry();
    const fakeApp = {
      container: {
        make: async (cls: unknown) => new (cls as new (s: Switchboard) => ToolHandler)(switchboard),
      },
    };
    for (const tool of [FlaggedTool, EntitledTool, StaticallyOffTool, PlainTool]) {
      registerToolExport(registry, tool, [], fakeApp as never);
    }
    return { switchboard, registry };
  }

  async function toolNames(registry: ToolRegistry, who: Actor = actor): Promise<string[]> {
    return (await registry.definitionsFor(who, policy)).map((definition) => definition.name).sort();
  }

  it("reads isEnabled() off the class, with the class's injected dependencies", async () => {
    const { switchboard, registry } = build();
    // `entitledTool` is absent for a second reason (nobody is entitled yet) — covered below.
    expect(await toolNames(registry)).toEqual(['plainTool']);

    switchboard.featureOn = true;
    // No re-registration, no restart: the next turn asks the tool again.
    expect(await toolNames(registry)).toEqual(['flaggedTool', 'plainTool']);
  });

  it('reads canUse() off the class, per actor', async () => {
    const { switchboard, registry } = build();
    switchboard.entitled.add('u1');

    expect(await toolNames(registry)).toContain('entitledTool');
    expect(await toolNames(registry, { id: 'u2', roles: ['ADMIN'] })).not.toContain('entitledTool');
  });

  it('honours a declared `enabled: false`', async () => {
    const { registry } = build();
    expect(await toolNames(registry)).not.toContain('staticallyOffTool');
  });

  it('leaves a tool that declares no gates fully available', async () => {
    const { registry } = build();
    expect(await toolNames(registry)).toContain('plainTool');
  });

  it('forwards the gates for a class instantiated without a container, too', async () => {
    class SelfGated implements ToolHandler<Record<string, never>> {
      static tool = {
        name: 'selfGated',
        kind: 'read',
        description: 'refuses everyone but u1',
        input: z.object({}),
      } as const;

      canUse(who: Actor): boolean {
        return who.id === 'u1';
      }

      async execute() {
        return { ok: true };
      }
    }
    const registry = new ToolRegistry();
    registerToolExport(registry, SelfGated, []);
    expect(await toolNames(registry)).toEqual(['selfGated']);
    expect(await toolNames(registry, { id: 'u2' })).toEqual([]);
  });
});

describe('delegate edge authorization', () => {
  /**
   * A synthesized `ask_<target>` tool goes through the SAME `RolesPolicy` gate as every other tool.
   * A bare-string edge declares no `roles` and no `ability`, which is ADMIN-only under the default
   * authorizer and an outright DENY under the ability-aware authz adapter — so the object form of
   * `delegatesTo` is the only way to open the edge to a non-ADMIN actor, and these tests pin that the
   * annotation actually reaches the spec rather than being silently dropped.
   */
  it('leaves a bare-string edge with no roles and no ability (fail-closed)', () => {
    const registry = new ToolRegistry();
    const agents = new AgentRegistry();
    agents.register({ name: 'orchestrator', delegatesTo: ['researcher'] });
    agents.register({ name: 'researcher' });

    registerDelegateTools(registry, agents);
    const spec = registry.spec(delegateToolName('researcher'));

    expect(spec?.roles).toBeUndefined();
    expect(spec?.ability).toBeUndefined();
  });

  it('carries the edge`s roles onto the synthesized delegate tool', () => {
    const registry = new ToolRegistry();
    const agents = new AgentRegistry();
    agents.register({
      name: 'orchestrator',
      delegatesTo: [{ agent: 'researcher', roles: ['ANALYST', 'ADMIN'] }],
    });
    agents.register({ name: 'researcher' });

    registerDelegateTools(registry, agents);
    const spec = registry.spec(delegateToolName('researcher'));

    expect(spec?.kind).toBe('agent');
    expect(spec?.targetAgent).toBe('researcher');
    expect(spec?.roles).toEqual(['ANALYST', 'ADMIN']);
  });

  it('carries the edge`s ability, which is what makes delegation reachable under authz', () => {
    const registry = new ToolRegistry();
    const agents = new AgentRegistry();
    agents.register({
      name: 'orchestrator',
      delegatesTo: [{ agent: 'researcher', ability: 'agent.delegate' }],
    });
    agents.register({ name: 'researcher' });

    registerDelegateTools(registry, agents);

    expect(registry.spec(delegateToolName('researcher'))?.ability).toBe('agent.delegate');
  });

  it('an annotated edge passes the default role gate that a bare edge fails', async () => {
    const registry = new ToolRegistry();
    const agents = new AgentRegistry();
    agents.register({
      name: 'orchestrator',
      delegatesTo: ['bare', { agent: 'annotated', roles: ['ANALYST'] }],
    });
    agents.register({ name: 'bare' });
    agents.register({ name: 'annotated' });
    registerDelegateTools(registry, agents);

    const policy = new DefaultRolesPolicy(['ADMIN']);
    const analyst = { id: 'u_1', roles: ['ANALYST'] };

    // Non-null asserted: both specs were just registered above.
    expect(await policy.can(analyst, registry.spec(delegateToolName('bare'))!)).toBe(false);
    expect(await policy.can(analyst, registry.spec(delegateToolName('annotated'))!)).toBe(true);
  });

  it('keeps the object form in the agent`s effective tool allow-list', () => {
    const registry = new ToolRegistry();
    const agents = new AgentRegistry();
    agents.register({
      name: 'orchestrator',
      delegatesTo: [{ agent: 'researcher', ability: 'agent.delegate' }],
    });
    agents.register({ name: 'researcher' });
    registerDelegateTools(registry, agents);

    const factory = new AgentDepsFactory({
      model: {} as never,
      store: {} as never,
      sink: {} as never,
      rolesPolicy: {} as never,
      registry,
      agents,
    });

    // The delegate tool must be OFFERED to the orchestrator, or the loop's offered-tools filter
    // rejects the call before the role gate ever runs.
    expect(factory.forAgent('orchestrator').toolAllowList).toContain('ask_researcher');
  });
});

it.each([false, true])(
  'forwards ActionTool preflight through discovery (DI: %s) with instance binding',
  async (withDi) => {
    const phases: string[] = [];
    class Refund extends ActionTool<Record<string, never>, string> {
      static override tool = { name: 'refund', description: 'refund', input: z.object({}) };
      constructor(private confirmation = 'Refund Seven?') {
        super();
      }
      preflight(
        _input: Record<string, never>,
        _ctx: AiToolCtx,
        { phase }: { phase: 'prepare' | 'execute' },
      ) {
        phases.push(phase);
        return {
          status: 'ready' as const,
          confirmation: { title: this.confirmation, verb: 'Refund' },
        };
      }
      execute() {
        return this.confirmation;
      }
    }
    const registry = new ToolRegistry();
    let resolutions = 0;
    const fakeApp = {
      container: {
        make: async () => {
          resolutions++;
          return new Refund('Refund Seven?');
        },
      },
    };
    registerToolExport(registry, Refund, [], withDi ? (fakeApp as never) : undefined);
    expect(await registry.prepare('refund', {}, anyCtx, allowAll)).toMatchObject({
      confirmation: { title: 'Refund Seven?' },
    });
    expect(await registry.invoke('refund', {}, anyCtx, allowAll)).toBe('Refund Seven?');
    expect(phases).toEqual(['prepare', 'execute']);
    expect(resolutions).toBe(withDi ? 1 : 0);
  },
);
