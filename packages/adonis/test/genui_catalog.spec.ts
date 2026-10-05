import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BUILTIN_COMPONENTS, LAYOUT_COMPONENTS } from '../src/genui/builtins.js';
import { defineCatalog, defineComponent, toolNameFor, toSnakeCase } from '../src/genui/catalog.js';
import { ajvValidator, builtinJsonSchemaValidator, formatIssues } from '../src/genui/schema.js';

const dealCard = defineComponent({
  name: 'DealCard',
  title: 'Deal',
  description: 'A deal in the pipeline.',
  props: z.object({ name: z.string(), amount: z.number().default(0) }),
});

const badgeJson = defineComponent({
  name: 'Pill',
  title: 'Pill',
  description: 'A label.',
  props: {
    type: 'object',
    properties: { text: { type: 'string', minLength: 1 }, tone: { enum: ['a', 'b'] } },
    required: ['text'],
    additionalProperties: false,
  },
});

describe('defineComponent / defineCatalog', () => {
  it('rejects names that cannot become a registry key or tool name', () => {
    expect(() =>
      defineComponent({ name: 'not ok', title: 'x', description: 'x', props: {} }),
    ).toThrow(/letters and digits/);
    expect(() =>
      defineComponent({ name: 'genui:tree', title: 'x', description: 'x', props: {} }),
    ).toThrow();
  });

  it('refuses a duplicate name, and extend() replaces one', () => {
    expect(() => defineCatalog([dealCard, dealCard])).toThrow(/defined twice/);
    const catalog = defineCatalog([dealCard]);
    const replaced = catalog.extend([{ ...dealCard, title: 'Opportunity' }]);
    expect(replaced.get('DealCard')?.title).toBe('Opportunity');
    expect(catalog.get('DealCard')?.title).toBe('Deal');
  });

  it('validates Standard Schema props and returns the schema output (defaults applied)', async () => {
    const catalog = defineCatalog([dealCard]);
    await expect(catalog.validate('DealCard', { name: 'Acme' })).resolves.toEqual({
      ok: true,
      value: { name: 'Acme', amount: 0 },
    });
    const bad = await catalog.validate('DealCard', { name: 3 });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.issues[0]?.path).toEqual(['name']);
  });

  it('validates JSON Schema props with the builtin validator', async () => {
    const catalog = defineCatalog([badgeJson]);
    await expect(catalog.validate('Pill', { text: 'hi' })).resolves.toMatchObject({ ok: true });
    const bad = await catalog.validate('Pill', { text: '', tone: 'c', extra: 1 });
    expect(bad.ok === false && formatIssues(bad.issues)).toBe(
      'text: must be at least 1 characters; tone: must be one of "a", "b"; extra: is not a known property',
    );
  });

  it('validates synchronously when the schema can', () => {
    const catalog = defineCatalog([dealCard, badgeJson]);
    expect(catalog.validateSync('DealCard', { name: 'Acme' })).toEqual({
      ok: true,
      value: { name: 'Acme', amount: 0 },
    });
    expect(catalog.validateSync('Pill', {})).toMatchObject({ ok: false });
    expect(catalog.validateSync('Nope', {})).toMatchObject({ ok: false });
    const asyncOnly = defineCatalog([
      {
        name: 'Later',
        title: 'l',
        description: 'l',
        props: {
          '~standard': { version: 1, vendor: 'x', validate: async (value: unknown) => ({ value }) },
        },
      },
    ]);
    expect(asyncOnly.validateSync('Later', {})).toBeUndefined();
  });

  it('treats an unknown component as a validation failure', async () => {
    const catalog = defineCatalog([badgeJson]);
    await expect(catalog.validate('Nope', {})).resolves.toEqual({
      ok: false,
      issues: [{ path: [], message: 'unknown component "Nope"' }],
    });
  });

  it('accepts an Ajv-backed validator', async () => {
    const catalog = defineCatalog([badgeJson], {
      jsonSchemaValidator: ajvValidator(new Ajv({ allErrors: true })),
    });
    const bad = await catalog.validate('Pill', { tone: 'a' });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.issues[0]?.message).toMatch(/text/);
  });

  it('keeps internal components out of the model-facing list', () => {
    const catalog = defineCatalog([dealCard, { ...badgeJson, internal: true }]);
    expect(catalog.modelComponents().map((component) => component.name)).toEqual(['DealCard']);
  });

  it('derives tool names', () => {
    expect(toSnakeCase('DataTable')).toBe('data_table');
    expect(toSnakeCase('KPICards')).toBe('kpi_cards');
    expect(toolNameFor('KpiCards')).toBe('ui__show_kpi_cards');
    expect(toolNameFor('KpiCards', 'show_')).toBe('show_kpi_cards');
  });
});

describe('builtin definitions', () => {
  const catalog = defineCatalog([...BUILTIN_COMPONENTS, ...LAYOUT_COMPONENTS]);

  it('ships the documented set', () => {
    expect(catalog.components.map((component) => component.name)).toEqual([
      'DataTable',
      'Chart',
      'KpiCards',
      'SourceCards',
      'Checklist',
      'Timeline',
      'CodeBlock',
      'Diff',
      'Callout',
      'Stack',
      'Card',
      'Heading',
      'Text',
      'Badge',
      'Link',
      'Image',
    ]);
  });

  it('agrees with Ajv on valid and invalid props', async () => {
    const ajv = ajvValidator(new Ajv({ allErrors: true, strict: false }));
    const samples: [string, unknown][] = [
      ['DataTable', { columns: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }] }],
      ['DataTable', { columns: [], rows: [] }],
      ['Chart', { type: 'pie', xKey: 'x', series: [{ key: 'y' }], data: [{ x: 1 }] }],
      ['KpiCards', { items: [{ label: 'MRR', value: 10 }] }],
      ['Link', { text: 'x', url: 'javascript:alert(1)' }],
      ['Image', { url: 'https://example.com/a.png' }],
    ];
    for (const [name, props] of samples) {
      const schema = catalog.get(name)?.props as Record<string, unknown>;
      expect(builtinJsonSchemaValidator.validate(schema, props).length === 0).toBe(
        ajv.validate(schema, props).length === 0,
      );
    }
  });
});
