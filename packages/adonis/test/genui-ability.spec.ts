import { describe, expect, it } from 'vitest';
import { authzToolAuthorizer } from '../src/authz/index.js';
import { BUILTIN_COMPONENTS } from '../src/genui/builtins.js';
import { defineCatalog } from '../src/genui/catalog.js';
import { Sandbox } from '../src/genui/sandbox.js';
import { genuiToolAbility, genuiTools } from '../src/genui/tools.js';
import type { Actor } from '../src/types.js';

const catalog = defineCatalog([...BUILTIN_COMPONENTS, Sandbox]);
const actor = { id: 'u1', roles: [] } as unknown as Actor;
const names = (tools: ReturnType<typeof genuiTools>) => tools.map((tool) => tool.spec.name);

describe('genui({ ability }) — the UI tools under an ability-aware authorizer', () => {
  it('without an ability, authz denies every UI tool (fail-closed, as for any tool)', async () => {
    const authorizer = authzToolAuthorizer({ authz: { can: async () => true } });
    const tools = genuiTools(catalog, { componentTools: ['Sandbox'] });
    expect(names(tools)).toEqual(['ui__render', 'ui__sandbox']);
    for (const tool of tools) expect(await authorizer.can(actor, tool.spec)).toBe(false);
  });

  it('one ability for every tool: authz decides with it', async () => {
    const asked: string[] = [];
    const authorizer = authzToolAuthorizer({
      authz: {
        can: async (_user, permission) => {
          asked.push(permission);
          return permission === 'genui.use';
        },
      },
    });
    const tools = genuiTools(catalog, {
      componentTools: ['Sandbox'],
      ability: 'genui.use',
      showTool: true,
    });
    expect(tools.map((tool) => tool.spec.ability)).toEqual(['genui.use', 'genui.use', 'genui.use']);
    for (const tool of tools) expect(await authorizer.can(actor, tool.spec)).toBe(true);
    expect(asked).toEqual(['genui.use', 'genui.use', 'genui.use']);
  });

  it('a map by tool name, and a function of the tool — a tool left out declares none', async () => {
    const byName = genuiTools(catalog, {
      componentTools: ['Sandbox'],
      ability: { ui__render: 'genui.render' },
    });
    expect(byName.map((tool) => [tool.spec.name, tool.spec.ability])).toEqual([
      ['ui__render', 'genui.render'],
      ['ui__sandbox', undefined],
    ]);
    const perComponent = genuiTools(catalog, {
      mode: 'per-component',
      ability: ({ component }) => (component === 'Sandbox' ? 'genui.sandbox' : 'genui.show'),
    });
    const sandbox = perComponent.find((tool) => tool.spec.name === 'ui__show_sandbox');
    expect(sandbox?.spec.ability).toBe('genui.sandbox');
    expect(
      perComponent.filter((tool) => tool.spec.ability === 'genui.show').length,
    ).toBeGreaterThan(3);
    expect(genuiToolAbility(undefined, { name: 'ui__render' })).toBeUndefined();
  });

  it('genui() passes it to its tools', async () => {
    const { genui } = await import('../src/genui/index.js');
    const setup = await genui({ catalog, componentTools: ['Sandbox'], ability: 'genui.use' })({
      make: async () => ({}) as never,
      app: undefined,
    });
    expect(setup.tools.map((tool) => tool.spec.ability)).toEqual(['genui.use', 'genui.use']);
  });
});
