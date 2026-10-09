import { describe, expect, it } from 'vitest';
import { BUILTIN_COMPONENTS, KpiCards, LAYOUT_COMPONENTS } from '../src/genui/builtins.js';
import { defineCatalog } from '../src/genui/catalog.js';
import { catalogToModelText, componentToText, treeToText } from '../src/genui/text.js';
import {
  GENUI_TREE_COMPONENT,
  treeJsonSchema,
  treeToFlatSpec,
  validateTree,
} from '../src/genui/tree.js';

const catalog = defineCatalog([...BUILTIN_COMPONENTS, ...LAYOUT_COMPONENTS]);

const tree = {
  type: 'Card',
  props: { title: 'Signups' },
  children: [
    { type: 'KpiCards', props: { items: [{ label: 'New', value: 12, delta: '+3' }] } },
    {
      type: 'DataTable',
      props: { columns: [{ key: 'day', label: 'Day' }], rows: [{ day: 'Mon' }] },
    },
  ],
};

describe('validateTree', () => {
  it('accepts a well-formed tree', async () => {
    await expect(validateTree(catalog, tree)).resolves.toEqual({ ok: true, value: tree });
  });

  it('reports every problem with its path', async () => {
    const result = await validateTree(catalog, {
      type: 'Card',
      props: {},
      children: [
        { type: 'Nope', props: {} },
        { type: 'Text', props: {} },
        {
          type: 'Heading',
          props: { text: 'x' },
          children: [{ type: 'Text', props: { text: 'y' } }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    const issues = result.ok ? [] : result.issues;
    expect(issues.map((issue) => issue.path.join('.'))).toEqual([
      'children.0.type',
      'children.1.props.text',
      'children.2.children',
    ]);
    expect(issues[2]?.message).toBe('Heading does not take children');
  });

  it('parses children the model sent as a JSON string, trailing junk included', async () => {
    const result = await validateTree(catalog, {
      type: 'Stack',
      props: {},
      children: `${JSON.stringify([{ type: 'Text', props: { text: 'hi' } }])}}`,
    });
    expect(result).toEqual({
      ok: true,
      value: { type: 'Stack', props: {}, children: [{ type: 'Text', props: { text: 'hi' } }] },
    });
  });

  it('parses a whole tree the model sent as a JSON string', async () => {
    const result = await validateTree(catalog, JSON.stringify(tree, null, 1));
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.type).toBe('Card');
    expect((await validateTree(catalog, 'not a tree')).ok).toBe(false);
    expect((await validateTree(catalog, '[1]')).ok).toBe(false);
  });

  it('enforces size limits', async () => {
    const wide = {
      type: 'Stack',
      props: {},
      children: Array.from({ length: 5 }, () => ({ type: 'Text', props: { text: 'x' } })),
    };
    const result = await validateTree(catalog, wide, { maxNodes: 3 });
    expect(result.ok === false && result.issues[0]?.message).toMatch(/more than 3 elements/);
    let deep: Record<string, unknown> = { type: 'Text', props: { text: 'x' } };
    for (let i = 0; i < 5; i++) deep = { type: 'Stack', props: {}, children: [deep] };
    const tooDeep = await validateTree(catalog, deep, { maxDepth: 3 });
    expect(tooDeep.ok === false && tooDeep.issues[0]?.message).toMatch(/deeper than 3/);
  });

  it('refuses internal components', async () => {
    const withInternal = catalog.extend([
      { name: 'Secret', title: 's', description: 's', props: {}, internal: true },
    ]);
    const result = await validateTree(withInternal, { type: 'Secret', props: {} });
    expect(result.ok).toBe(false);
  });
});

describe('tree helpers', () => {
  it('describes the node shape with the catalog names', () => {
    const schema = treeJsonSchema(catalog) as { properties: { type: { enum: string[] } } };
    expect(schema.properties.type.enum).toContain('DataTable');
    expect(schema.properties.type.enum).toContain('Stack');
  });

  it('converts to a json-render flat spec', () => {
    expect(treeToFlatSpec(tree)).toEqual({
      root: 'el-0',
      elements: {
        'el-0': { type: 'Card', props: { title: 'Signups' }, children: ['el-1', 'el-2'] },
        'el-1': { type: 'KpiCards', props: tree.children[0]?.props, children: [] },
        'el-2': { type: 'DataTable', props: tree.children[1]?.props, children: [] },
      },
    });
  });
});

describe('text', () => {
  it('renders a tree as text through each definition', () => {
    expect(treeToText(catalog, tree)).toBe(
      ['*Signups*', '• *New:* 12 (+3)', '```\nDay\n---\nMon\n```'].join('\n'),
    );
    expect(componentToText(catalog, GENUI_TREE_COMPONENT, { root: tree })).toBe(
      treeToText(catalog, tree),
    );
  });

  it('falls back to JSON for a component without text, and for one whose text throws', () => {
    const custom = catalog.extend([
      { name: 'Plain', title: 'p', description: 'p', props: {} },
      {
        name: 'Broken',
        title: 'b',
        description: 'b',
        props: {},
        fallbackText: () => {
          throw new Error('boom');
        },
      },
    ]);
    expect(componentToText(custom, 'Plain', { a: 1 })).toBe('```\n{\n  "a": 1\n}\n```');
    expect(componentToText(custom, 'Broken', { a: 1 })).toContain('"a": 1');
    expect(componentToText(custom, 'Unknown', { title: 'T' })).toMatch(/^\*T\*\n```/);
  });

  it('renders nothing for an empty fallback (a bare layout), but still renders its children', () => {
    expect(componentToText(catalog, 'Stack', {})).toBe('');
    expect(componentToText(catalog, 'Card', {})).toBe('');
    expect(componentToText(catalog, 'Card', { title: 'T' })).toBe('*T*');
    const layout = {
      type: 'Stack',
      props: { gap: 2 },
      children: [{ type: 'Card', props: {}, children: [{ type: 'Text', props: { text: 'hi' } }] }],
    };
    expect(treeToText(catalog, layout)).toBe('hi');
    expect(componentToText(catalog, GENUI_TREE_COMPONENT, { root: layout })).toBe('hi');
  });

  it('draws every chart series, and a line chart as sparklines plus a table', () => {
    const data = [
      { month: 'Jan', revenue: 10, cost: 4 },
      { month: 'Feb', revenue: 20, cost: 8 },
      { month: 'Mar', revenue: 40, cost: 6 },
    ];
    const series = [
      { key: 'revenue', label: 'Revenue' },
      { key: 'cost', label: 'Cost' },
    ];
    const bar = componentToText(catalog, 'Chart', { type: 'bar', xKey: 'month', series, data });
    expect(bar).toContain('Revenue');
    expect(bar).toContain('Cost');
    expect(bar).toMatch(/Cost\s+█+ 8/);
    expect(bar).toMatch(/Revenue\s+█{20} 40/);
    const single = componentToText(catalog, 'Chart', {
      type: 'bar',
      xKey: 'month',
      series: [{ key: 'revenue' }],
      data,
      unit: 'k',
    });
    expect(single).toContain(`Jan${' '.repeat(16)}█████ 10 k`);
    const line = componentToText(catalog, 'Chart', {
      type: 'line',
      title: 'Trend',
      xKey: 'month',
      series,
      data,
    });
    expect(line).toMatch(/^\*Trend\*\n```/);
    expect(line).not.toContain('█████');
    expect(line).toMatch(/Revenue\s+▁\S▇?█? /);
    expect(line).toContain('10 → 40');
    expect(line).toContain('4 → 6');
    expect(line).toMatch(/month\s+Revenue\s+Cost/);
    expect(line).toMatch(/Mar\s+40\s+6/);
  });

  it('describes the catalog for a model', () => {
    const small = defineCatalog([...LAYOUT_COMPONENTS.slice(0, 2), KpiCards]);
    expect(catalogToModelText(small, { mode: 'tree' })).toMatchInlineSnapshot(`
      "Compose the UI as ONE tree of elements: { "type": <component>, "props": { … }, "children"?: [ … ] }.
      Only components marked "takes children" accept children; \`children\` is a literal JSON array, never a string.
      Components:
      - Stack: Lays its children out vertically (or horizontally with direction=row).
        props: { direction?: "column" | "row", gap?: number }
        takes children
      - Card: A box with an optional title around its children.
        props: { title?: string, subtitle?: string }
        takes children
      - KpiCards: A few key numbers (metrics, totals, counts) as cards.
        props: { title?: string, items: { label: string, value: string | number, delta?: string, trend?: "up" | "down" | "flat", hint?: string }[] }"
    `);
    expect(catalogToModelText(small, { mode: 'per-component' })).toContain(
      '- KpiCards (tool `ui__show_kpi_cards`)',
    );
    // A layout has no tool of its own outside tree mode.
    expect(catalogToModelText(small, { mode: 'per-component' })).not.toContain('Stack');
    expect(catalogToModelText(small, { mode: 'show' })).not.toContain('Card:');
  });
});
