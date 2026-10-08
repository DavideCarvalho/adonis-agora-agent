import { Ajv } from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BUILTIN_COMPONENTS, LAYOUT_COMPONENTS } from '../src/genui/builtins.js';
import {
  defineCatalog,
  defineComponent,
  GENUI_TREE_COMPONENT,
  genui,
  genuiTools,
  negotiateCatalog,
  treeJsonSchema,
} from '../src/genui/index.js';
import {
  type AiToolCtx,
  DefaultRolesPolicy,
  type ModelProvider,
  type ModelTurnArgs,
  type ThreadDetail,
  ToolRegistry,
} from '../src/index.js';
import { type BootedApp, bootAgentApp, readSse } from './helpers/boot-agent-app.js';

const catalog = defineCatalog([...BUILTIN_COMPONENTS, ...LAYOUT_COMPONENTS]);

function compile(schema: Record<string, unknown>) {
  return new Ajv({ strict: true, allowUnionTypes: true, allErrors: true }).compile(schema);
}

const table = {
  type: 'DataTable',
  props: { columns: [{ key: 'id', label: 'Order' }], rows: [{ id: '#1' }] },
};

describe('treeJsonSchema (strict)', () => {
  const schema = treeJsonSchema(catalog) as {
    type: string;
    properties: Record<string, Record<string, unknown>>;
    $defs: Record<string, { properties?: Record<string, unknown>; anyOf?: unknown[] }>;
    anyOf?: unknown;
  };

  it('is an object at the root, a union by type below it, children only where taken', () => {
    // No union at the top level: OpenAI and Anthropic refuse one in tool parameters.
    expect(schema.type).toBe('object');
    expect(schema.anyOf).toBeUndefined();
    expect(schema.properties.type?.enum).toEqual(catalog.modelComponents().map((c) => c.name));
    expect(schema.$defs.node?.anyOf).toHaveLength(catalog.modelComponents().length);
    for (const component of catalog.modelComponents()) {
      const variant = schema.$defs[`node_${component.name}`];
      expect(variant?.properties?.type).toEqual({ type: 'string', enum: [component.name] });
      expect(variant?.properties?.props).toEqual({ $ref: `#/$defs/props_${component.name}` });
      expect('children' in (variant?.properties ?? {})).toBe(component.children === true);
    }
    // Each variant carries its component's exact props.
    expect(schema.$defs.props_Chart).toEqual(catalog.jsonSchemaFor('Chart'));
  });

  it('compiles, and describes what validateTree accepts and refuses', () => {
    const validate = compile(schema);
    expect(validate(table)).toBe(true);
    expect(
      validate({ type: 'Card', props: { title: 'Orders' }, children: [table, { ...table }] }),
    ).toBe(true);
    // A leaf with children, a child with the wrong props, an unknown child type.
    expect(validate({ type: 'Card', props: {}, children: [{ ...table, children: [] }] })).toBe(
      false,
    );
    expect(
      validate({ type: 'Stack', props: {}, children: [{ type: 'Chart', props: { type: 'pie' } }] }),
    ).toBe(false);
    expect(validate({ type: 'Stack', props: {}, children: [{ type: 'Pie', props: {} }] })).toBe(
      false,
    );
  });

  it('follows the negotiated catalog', () => {
    const drawable = negotiateCatalog(catalog, {
      components: [
        { name: 'Card', version: 1 },
        { name: 'Text', version: 1 },
      ],
    });
    const narrowed = treeJsonSchema(drawable) as typeof schema;
    expect(narrowed.properties.type?.enum).toEqual(['Card', 'Text']);
    expect(Object.keys(narrowed.$defs).sort()).toEqual(
      ['node', 'node_Card', 'node_Text', 'props_Card', 'props_Text'].sort(),
    );
  });

  it('embeds a Zod props schema without $schema, and a self-referencing one as a plain object', () => {
    type Item = { label: string; items?: Item[] | undefined };
    const item: z.ZodType<Item> = z.lazy(() =>
      z.object({ label: z.string(), items: z.array(item).optional() }),
    );
    const zod = defineCatalog([
      defineComponent({
        name: 'Note',
        title: 'Note',
        description: 'n',
        props: z.object({ text: z.string() }),
      }),
      defineComponent({
        name: 'Outline',
        title: 'Outline',
        description: 'o',
        props: z.object({ root: item }),
      }),
    ]);
    const built = treeJsonSchema(zod) as typeof schema;
    expect(built.$defs.props_Note).toMatchObject({ type: 'object', required: ['text'] });
    expect('$schema' in (built.$defs.props_Note ?? {})).toBe(false);
    expect(built.$defs.props_Outline).toEqual({ type: 'object' });
    expect(compile(built)({ type: 'Note', props: { text: 'hi' } })).toBe(true);
  });

  it("falls back to the generic node shape with treeSchema: 'loose'", async () => {
    const loose = treeJsonSchema(catalog, { schema: 'loose' }) as typeof schema;
    expect(loose.$defs).toBeUndefined();
    expect(loose.properties.props).toMatchObject({ type: 'object' });
    const [tool] = genuiTools(catalog, { treeSchema: 'loose' });
    const described = await tool?.handler.describe?.({ actor: { id: 'u1' } });
    const shown = described?.inputSchema?.['~standard'] as unknown as {
      jsonSchema: { input: () => Record<string, unknown> };
    };
    expect(shown.jsonSchema.input()).toEqual(loose);
  });

  it('is what the static and the per-request tool show the model', async () => {
    const shownBy = (inputSchema: unknown) =>
      (inputSchema as { '~standard': { jsonSchema: { input: () => unknown } } })[
        '~standard'
      ].jsonSchema.input();
    const [fixed] = genuiTools(catalog);
    expect(shownBy(fixed?.spec.inputSchema)).toEqual(treeJsonSchema(catalog));
    const tenant = defineCatalog([...LAYOUT_COMPONENTS]);
    const [dynamic] = genuiTools(catalog, { resolveCatalog: () => tenant });
    const described = await dynamic?.handler.describe?.({ actor: { id: 'u1' } });
    expect(shownBy(described?.inputSchema)).toEqual(treeJsonSchema(tenant));
  });
});

describe("genui's default mode", () => {
  it('is tree: one ui__render tool, no ui__show_* ones', () => {
    expect(genuiTools(catalog).map((tool) => tool.spec.name)).toEqual(['ui__render']);
    expect(genuiTools(catalog, { mode: 'per-component' }).map((tool) => tool.spec.name)).toContain(
      'ui__show_data_table',
    );
  });
});

describe('a single-node tree', () => {
  function ctx() {
    const emitUi = vi.fn(async (..._args: unknown[]) => ({ id: 'c1:ui:0' }));
    return {
      emitUi,
      ctx: { actor: { id: 'u1' }, threadId: 't', runId: 'r', requestId: 'q', emitUi } as AiToolCtx,
    };
  }

  it('is pushed exactly as the component tool pushes it', async () => {
    const registry = new ToolRegistry();
    for (const tool of [...genuiTools(catalog), ...genuiTools(catalog, { mode: 'per-component' })])
      registry.register(tool.spec, tool.handler);
    const tree = ctx();
    await registry.invoke('ui__render', table, tree.ctx, new DefaultRolesPolicy());
    const show = ctx();
    await registry.invoke('ui__show_data_table', table.props, show.ctx, new DefaultRolesPolicy());
    expect(tree.emitUi.mock.calls).toEqual(show.emitUi.mock.calls);
    expect(tree.emitUi.mock.calls[0]?.[0]).toBe('DataTable');
  });

  it('stays a tree for a layout, even an empty one', async () => {
    const registry = new ToolRegistry();
    const [tool] = genuiTools(catalog);
    if (tool) registry.register(tool.spec, tool.handler);
    const card = ctx();
    await registry.invoke(
      'ui__render',
      { type: 'Card', props: { title: 'x' } },
      card.ctx,
      new DefaultRolesPolicy(),
    );
    expect(card.emitUi.mock.calls[0]?.[0]).toBe(GENUI_TREE_COMPONENT);
  });
});

describe('the default tree mode end to end', () => {
  let booted: BootedApp | null = null;
  afterEach(async () => {
    await booted?.close();
    booted = null;
  });
  const headers = { 'content-type': 'application/json', 'x-actor-id': 'u1' };

  it('streams a single DataTable from ui__render as the ui__show_data_table frame, with its text', async () => {
    const model: ModelProvider = {
      async runTurn(args: ModelTurnArgs) {
        const done = args.messages.some((message) => (message.toolResults ?? []).length > 0);
        return done
          ? { text: 'There.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
          : {
              text: '',
              toolCalls: [{ id: 'c1', name: 'ui__render', input: table }],
              usage: { inputTokens: 1, outputTokens: 1 },
            };
      },
    };
    booted = await bootAgentApp({ model, genui: genui({ catalog }) });
    const tools = (await (await fetch(`${booted.url}/agent/tools`, { headers })).json()) as Array<{
      name: string;
    }>;
    expect(tools.map((tool) => tool.name)).toEqual(['ui__render']);
    const response = await fetch(`${booted.url}/agent/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'orders' }),
    });
    const threadId = response.headers.get('x-agent-thread-id');
    const ui = (await readSse(response)).filter((frame) => frame.data.kind === 'ui');
    expect(ui.map((frame) => frame.data)).toEqual([
      {
        kind: 'ui',
        id: 'c1:ui:0',
        component: 'DataTable',
        props: table.props,
        version: 1,
        fallbackText: expect.stringContaining('#1'),
        toolCallId: 'c1',
      },
    ]);
    const thread = (await (
      await fetch(`${booted.url}/agent/threads/${threadId}`, { headers })
    ).json()) as ThreadDetail;
    expect(thread.messages.flatMap((message) => message.ui ?? [])).toEqual([
      expect.objectContaining({ id: 'c1:ui:0', component: 'DataTable', props: table.props }),
    ]);
  });
});
