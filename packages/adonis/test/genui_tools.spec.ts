import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BUILTIN_COMPONENTS, LAYOUT_COMPONENTS } from '../src/genui/builtins.js';
import { defineCatalog, defineComponent } from '../src/genui/catalog.js';
import { type GenuiCatalogScope, genuiTools } from '../src/genui/tools.js';
import { GENUI_TREE_COMPONENT } from '../src/genui/tree.js';
import type { AiToolCtx } from '../src/spi/tool.js';
import { createNoopEmitUi } from '../src/tool-ui.js';

const baseCtx: AiToolCtx = {
  actor: { id: 'u1', roles: [], tenantRef: 'acme' },
  threadId: 't1',
  runId: 'r1',
  requestId: 'r1',
  emitUi: createNoopEmitUi('r1'),
};

function ctxWithEmit() {
  const emitUi = vi.fn(
    async (_component: string, _props: Record<string, unknown>, options?: { id?: string }) => ({
      id: options?.id ?? 'call-1:ui:0',
    }),
  );
  return { ctx: { ...baseCtx, emitUi } as AiToolCtx, emitUi };
}

const deal = defineComponent({
  name: 'DealCard',
  title: 'Deal',
  description: 'A deal.',
  props: z.object({ name: z.string(), stage: z.string().default('lead') }),
  version: 2,
});
const catalog = defineCatalog([...BUILTIN_COMPONENTS, ...LAYOUT_COMPONENTS, deal]);

describe('genuiTools per-component', () => {
  const tools = genuiTools(catalog, { roles: ['member'] });

  it('makes one read tool per model component, named ui__show_<snake>', () => {
    expect(tools.map((tool) => tool.spec.name)).toContain('ui__show_data_table');
    expect(tools.map((tool) => tool.spec.name)).toContain('ui__show_deal_card');
    const table = tools.find((tool) => tool.spec.name === 'ui__show_data_table');
    expect(table?.spec).toMatchObject({
      kind: 'read',
      roles: ['member'],
      presentation: { label: 'Data table', result: { kind: 'elsewhere' } },
    });
    expect(table?.spec.terminal).toBeUndefined();
  });

  it('exposes a JSON Schema props schema to the model and validates through it', async () => {
    const table = tools.find((tool) => tool.spec.name === 'ui__show_data_table');
    const standard = table?.spec.inputSchema['~standard'] as unknown as {
      validate(value: unknown): { issues?: unknown[] };
      jsonSchema: { input(options: unknown): unknown };
    };
    expect(standard.jsonSchema.input({ target: 'draft-07' })).toBe(catalog.get('DataTable')?.props);
    expect(standard.validate({ columns: [], rows: [] }).issues).toHaveLength(1);
  });

  it('pushes the validated props through ctx.emitUi with the component version', async () => {
    const { ctx, emitUi } = ctxWithEmit();
    const tool = tools.find((each) => each.spec.name === 'ui__show_deal_card');
    const output = await tool?.handler.execute({ name: 'Acme' }, ctx);
    expect(emitUi).toHaveBeenCalledWith(
      'DealCard',
      { name: 'Acme', stage: 'lead' },
      { version: 2 },
    );
    expect(output).toEqual({ shown: 'DealCard', id: 'call-1:ui:0' });
  });

  it('refuses invalid props with a message the model can act on', async () => {
    const { ctx, emitUi } = ctxWithEmit();
    const tool = tools.find((each) => each.spec.name === 'ui__show_callout');
    await expect(tool?.handler.execute({ tone: 'loud' }, ctx)).rejects.toThrow(
      'invalid Callout props: text: is required; tone: must be one of "info", "success", "warning", "danger"',
    );
    expect(emitUi).not.toHaveBeenCalled();
  });

  it('pushes through the no-op emitUi of a surface without a conversation', async () => {
    const tool = tools.find((each) => each.spec.name === 'ui__show_heading');
    const ctx = { ...baseCtx, emitUi: createNoopEmitUi('mcp:1') };
    await expect(tool?.handler.execute({ text: 'Hi' }, ctx)).resolves.toEqual({
      shown: 'Heading',
      id: 'mcp:1:ui:0',
    });
  });

  it('stamps terminal and honours a custom prefix', () => {
    const [first] = genuiTools(catalog, { terminal: true, namePrefix: 'show_' });
    expect(first?.spec).toMatchObject({ name: 'show_data_table', terminal: true });
  });
});

describe('genuiTools tree', () => {
  const [tool] = genuiTools(catalog, {
    mode: 'tree',
    terminal: true,
    treeToolName: 'renderResult',
  });

  it('is one terminal tool describing the catalog', () => {
    expect(tool?.spec).toMatchObject({ name: 'renderResult', kind: 'read', terminal: true });
    expect(tool?.spec.description).toContain('- DataTable:');
    expect(tool?.spec.description).toContain('takes children');
  });

  it('validates the tree in inputSchema (async) so the registry refuses a bad one', async () => {
    const result = await tool?.spec.inputSchema['~standard'].validate({
      type: 'Card',
      props: {},
      children: [{ type: 'Text', props: {} }],
    });
    expect(result?.issues?.[0]).toMatchObject({ path: ['children', 0, 'props', 'text'] });
  });

  it('pushes the tree as one genui:tree frame', async () => {
    const { ctx, emitUi } = ctxWithEmit();
    const root = { type: 'Stack', props: {}, children: [{ type: 'Text', props: { text: 'hi' } }] };
    await expect(tool?.handler.execute(root, ctx)).resolves.toEqual({
      shown: GENUI_TREE_COMPONENT,
      id: 'call-1:ui:0',
    });
    expect(emitUi).toHaveBeenCalledWith(GENUI_TREE_COMPONENT, { root }, {});
  });
});

describe('genuiTools show tool', () => {
  const [show] = genuiTools(defineCatalog([deal]), { mode: 'tree', showTool: true }).slice(1);

  it('is one generic ui__show tool describing the catalog', () => {
    expect(show?.spec.name).toBe('ui__show');
    expect(show?.spec.description).toContain('- DealCard: A deal.');
  });

  it('validates { component, props } and pushes the component with its version', async () => {
    const { ctx, emitUi } = ctxWithEmit();
    await expect(
      show?.handler.execute({ component: 'DealCard', props: { name: 'Acme' } }, ctx),
    ).resolves.toEqual({ shown: 'DealCard', id: 'call-1:ui:0' });
    expect(emitUi).toHaveBeenCalledWith(
      'DealCard',
      { name: 'Acme', stage: 'lead' },
      { version: 2 },
    );
  });

  it('refuses an unknown component and bad props', async () => {
    const { ctx } = ctxWithEmit();
    await expect(show?.handler.execute({ component: 'Nope', props: {} }, ctx)).rejects.toThrow(
      /unknown component "Nope" \(allowed: DealCard\)/,
    );
    const result = await show?.spec.inputSchema['~standard'].validate({
      component: 'DealCard',
      props: {},
    });
    expect(result?.issues?.[0]).toMatchObject({ path: ['props', 'name'] });
  });

  it('takes a custom name', () => {
    const tools = genuiTools(defineCatalog([deal]), { showTool: 'present' });
    expect(tools.map((tool) => tool.spec.name)).toEqual(['ui__show_deal_card', 'present']);
  });
});

describe('genuiTools with a per-request catalog', () => {
  const tenantCard = (version: number, field: string) =>
    defineComponent({
      name: 'TenantCard',
      title: 'Tenant card',
      description: `Tenant card v${version}.`,
      props: {
        type: 'object',
        properties: { [field]: { type: 'string' } },
        required: [field],
      },
      version,
    });
  const catalogs: Record<string, ReturnType<typeof defineCatalog>> = {
    acme: defineCatalog([deal, tenantCard(3, 'headline')]),
    globex: defineCatalog([deal, tenantCard(1, 'title')]),
  };
  const seen: GenuiCatalogScope[] = [];
  const resolveCatalog = (scope: GenuiCatalogScope) => {
    seen.push(scope);
    return catalogs[scope.tenant ?? ''] ?? defineCatalog([]);
  };
  const actorOf = (tenant: string) => ({ id: 'u1', roles: [], tenantRef: tenant });

  it('validates a show call against the tenant catalog and stamps its version', async () => {
    const [show] = genuiTools(defineCatalog([]), { showTool: true, resolveCatalog });
    const { ctx, emitUi } = ctxWithEmit();
    await show?.handler.execute({ component: 'TenantCard', props: { headline: 'Hi' } }, ctx);
    expect(emitUi).toHaveBeenCalledWith('TenantCard', { headline: 'Hi' }, { version: 3 });
    expect(seen.at(-1)).toMatchObject({ tenant: 'acme', threadId: 't1' });

    const globex = { ...ctx, actor: actorOf('globex') };
    await expect(
      show?.handler.execute({ component: 'TenantCard', props: { headline: 'Hi' } }, globex),
    ).rejects.toThrow(/title: is required/);
  });

  it('lets any object through the registry and describes the tenant catalog per turn', async () => {
    const [show] = genuiTools(defineCatalog([]), { showTool: true, resolveCatalog });
    const passthrough = await show?.spec.inputSchema['~standard'].validate({ anything: 1 });
    expect(passthrough?.issues).toBeUndefined();
    const described = await show?.handler.describe?.({ actor: actorOf('acme'), threadId: 't9' });
    expect(described?.description).toContain('Tenant card v3.');
    if (!described?.inputSchema) throw new Error('missing described input schema');
    const schema = (
      described.inputSchema['~standard'] as unknown as {
        jsonSchema: { input(options: unknown): { properties: { component: { enum: string[] } } } };
      }
    ).jsonSchema.input({});
    expect(schema.properties.component.enum).toEqual(['DealCard', 'TenantCard']);
    expect(seen.at(-1)).toMatchObject({ tenant: 'acme', threadId: 't9' });
  });

  it('builds the tree description and validation from the resolved catalog', async () => {
    const [tree] = genuiTools(catalog, { mode: 'tree', resolveCatalog });
    const described = await tree?.handler.describe?.({ actor: actorOf('globex') });
    expect(described?.description).toContain('Tenant card v1.');
    expect(described?.description).not.toContain('DataTable');
    const { ctx } = ctxWithEmit();
    await expect(
      tree?.handler.execute({ type: 'DataTable', props: { columns: [], rows: [] } }, ctx),
    ).rejects.toThrow(/unknown component "DataTable"/);
  });

  it('refuses a per-component call the tenant catalog lacks, and says so in the description', async () => {
    const tools = genuiTools(catalog, { resolveCatalog });
    const table = tools.find((tool) => tool.spec.name === 'ui__show_data_table');
    const { ctx } = ctxWithEmit();
    await expect(table?.handler.execute({ columns: [], rows: [] }, ctx)).rejects.toThrow(
      'component "DataTable" is not available here',
    );
    const described = await table?.handler.describe?.({ actor: actorOf('acme') });
    expect(described?.description).toMatch(/Not available/);
    const dealTool = tools.find((tool) => tool.spec.name === 'ui__show_deal_card');
    expect((await dealTool?.handler.describe?.({ actor: actorOf('acme') }))?.description).toContain(
      'A deal.',
    );
  });

  it('describes renderer support even without a dynamic resolver', () => {
    const [tree] = genuiTools(catalog, { mode: 'tree' });
    expect(tree?.handler.describe).toBeTypeOf('function');
  });
});

it('hides unavailable components and empty tree catalogs using trusted renderer capabilities', async () => {
  const catalog = defineCatalog([
    defineComponent({
      name: 'Text',
      title: 'Text',
      description: 'Text',
      props: { type: 'object' },
    }),
  ]);
  const scope = { actor: { id: 'user' }, uiCapabilities: { components: [] } };
  for (const tool of genuiTools(catalog, { showTool: true }))
    expect((await tool.handler.describe?.(scope))?.available).toBe(false);
  const [tree] = genuiTools(catalog, { mode: 'tree' });
  expect((await tree?.handler.describe?.(scope))?.available).toBe(false);
});

describe('transformed portable props through tool registry', () => {
  it.each([false, true])(
    'transforms once through per-component and generic tools (dynamic=%s)',
    async (dynamic) => {
      const { ToolRegistry, DefaultRolesPolicy } = await import('../src/tool-registry.js');
      let transforms = 0;
      const transformed = defineComponent<{ label: string }>({
        name: 'Portable',
        title: 'Portable',
        description: 'Portable',
        version: 1,
        props: z.object({ source: z.string() }).transform(({ source }) => {
          transforms++;
          return { label: `${source}!` };
        }),
        outputProps: z.object({ label: z.string() }),
      });
      const resolved = defineCatalog([transformed]);
      const options = { showTool: true, ...(dynamic ? { resolveCatalog: () => resolved } : {}) };
      const tools = genuiTools(resolved, options);
      const registry = new ToolRegistry();
      for (const tool of tools) registry.register(tool.spec, tool.handler);
      const { ctx, emitUi } = ctxWithEmit();
      await registry.invoke('ui__show_portable', { source: 'x' }, ctx, new DefaultRolesPolicy());
      await registry.invoke(
        'ui__show',
        { component: 'Portable', props: { source: 'x' } },
        ctx,
        new DefaultRolesPolicy(),
      );
      expect(transforms).toBe(2);
      expect(emitUi).toHaveBeenNthCalledWith(1, 'Portable', { label: 'x!' }, { version: 1 });
      expect(emitUi).toHaveBeenNthCalledWith(2, 'Portable', { label: 'x!' }, { version: 1 });
    },
  );
  it('describes author input schema rather than portable output schema', async () => {
    const component = defineComponent({
      name: 'Labels',
      title: 'Labels',
      description: 'Labels',
      props: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] },
      outputProps: {
        type: 'object',
        properties: { label: { type: 'string' } },
        required: ['label'],
      },
    });
    const tools = genuiTools(defineCatalog([component]), { showTool: true });
    const show = tools.find((tool) => tool.spec.name === 'ui__show');
    expect(show?.spec.description).toContain('source');
    expect(show?.spec.description).not.toContain('label:');
  });
});

it.each([false, true])(
  'uses author input and portable output schemas for tree tools (dynamic=%s)',
  async (dynamic) => {
    const { ToolRegistry, DefaultRolesPolicy } = await import('../src/tool-registry.js');
    let transforms = 0;
    const component = defineComponent({
      name: 'TreeLabel',
      title: 'TreeLabel',
      description: 'TreeLabel',
      props: z.object({ source: z.string() }).transform(({ source }) => {
        transforms++;
        return { label: `${source}!` };
      }),
      outputProps: z.object({ label: z.string() }),
    });
    const catalog = defineCatalog([component]);
    const [tool] = genuiTools(catalog, {
      mode: 'tree',
      ...(dynamic ? { resolveCatalog: () => catalog } : {}),
    });
    if (!tool) throw new Error('tree tool missing');
    const registry = new ToolRegistry();
    registry.register(tool.spec, tool.handler);
    const { ctx, emitUi } = ctxWithEmit();
    await registry.invoke(
      'ui__render',
      { type: 'TreeLabel', props: { source: 'x' } },
      ctx,
      new DefaultRolesPolicy(),
    );
    expect(transforms).toBe(1);
    expect(emitUi).toHaveBeenCalledWith(
      GENUI_TREE_COMPONENT,
      { root: { type: 'TreeLabel', props: { label: 'x!' } } },
      {},
    );
  },
);
