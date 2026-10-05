import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { chart, createComponent, createComponentRegistry, table } from '../src/genui/index.js';

const definition = {
  name: 'Greeting',
  title: 'Greeting',
  description: 'A greeting',
  version: 2,
  props: z.object({ text: z.string().transform((text) => text.toUpperCase()) }),
  fallbackText: (props: { text: string }) => `Hello ${props.text}`,
};

describe('component presentations', () => {
  it('validates and transforms props and retains the existing definition contract', async () => {
    const greeting = createComponent(definition);
    expect(greeting.definition).toBe(definition);
    expect(await greeting({ text: 'world' })).toEqual({
      component: 'Greeting',
      props: { text: 'WORLD' },
      version: 2,
      fallbackText: 'Hello WORLD',
    });
    await expect(greeting({ text: 3 } as unknown as { text: string })).rejects.toThrow(/text/);
  });
  it('infers schema input and output props including transformations', async () => {
    const factory = createComponent({
      name: 'Length',
      title: 'Length',
      description: 'Length',
      props: z.object({ text: z.string() }).transform(({ text }) => ({ length: text.length })),
      outputProps: z.object({ length: z.number() }),
    });
    const result = await factory({ text: 'hello' });
    const length: number = result.props.length;
    expect(length).toBe(5);
    // @ts-expect-error schema input rejects missing text
    await expect(factory({ missing: true })).rejects.toThrow();
  });
  it('requires an explicit output schema for non-idempotent transformations', async () => {
    const factory = createComponent({
      ...definition,
      props: z.object({ text: z.string().transform((text) => `${text}!`) }),
    });
    await expect(factory({ text: 'x' })).rejects.toThrow(/outputProps/);
  });
  it('renders portable transformed output without applying the input transform again', async () => {
    const def = {
      ...definition,
      props: z.object({ text: z.string().transform((text) => `${text}!`) }),
      outputProps: z.object({ text: z.string() }),
    };
    const presentation = await createComponent(def)({ text: 'x' });
    const registry = createComponentRegistry().register(def, { web: (props) => props.text });
    expect(await registry.render(JSON.parse(JSON.stringify(presentation)), 'web')).toBe('x!');
    expect(registry.catalog.validateSync('Greeting', presentation.props)).toEqual({
      ok: true,
      value: { text: 'x!' },
    });
  });
  it('accepts output schemas that reorder object keys without changing data', async () => {
    const factory = createComponent({
      name: 'Reordered',
      title: 'Reordered',
      description: 'Reordered',
      props: z.object({ a: z.string(), b: z.string() }),
      outputProps: z.object({ b: z.string(), a: z.string() }),
    });
    expect((await factory({ a: 'A', b: 'B' })).props).toEqual({ a: 'A', b: 'B' });
  });
  it('rejects non-JSON props produced by a schema', async () => {
    const factory = createComponent({
      ...definition,
      props: z
        .object({ text: z.string() })
        .transform(() => ({ text: 'ok', callback: () => undefined })),
    });
    await expect(factory({ text: 'x' })).rejects.toThrow(/JSON/);
  });
  it('offers typed factories that preserve builtin contracts', async () => {
    expect((await table({ columns: [{ key: 'x', label: 'X' }], rows: [{ x: 1 }] })).component).toBe(
      'DataTable',
    );
    expect(
      (await chart({ type: 'bar', xKey: 'x', series: [{ key: 'y' }], data: [{ x: 'a', y: 1 }] }))
        .component,
    ).toBe('Chart');
    await expect(table({ columns: [], rows: [] })).rejects.toThrow();
  });
});

describe('app component registry', () => {
  it('renders only validated current versions with transformed props', async () => {
    const renderer = vi.fn(
      (props: { text: string }, ctx?: { prefix: string }) => `${ctx?.prefix}${props.text}`,
    );
    const registry = createComponentRegistry<{ prefix: string }>().register(definition, {
      web: renderer,
    });
    const presentation = await createComponent(definition)({ text: 'hello' });
    expect(await registry.render(presentation, 'web', { prefix: '>' })).toBe('>HELLO');
    await expect(registry.render({ ...presentation, version: 1 }, 'web')).rejects.toThrow(
      /version/,
    );
    await expect(registry.render({ ...presentation, props: { text: 5 } }, 'web')).rejects.toThrow(
      /text/,
    );
    expect(renderer).toHaveBeenCalledTimes(1);
  });
  it('uses authoritative text, exports a plain manifest and rejects duplicates', async () => {
    const registry = createComponentRegistry().register(definition, {});
    const presentation = await createComponent(definition)({ text: 'world' });
    expect(await registry.render({ ...presentation, fallbackText: 'forged' }, 'whatsapp')).toBe(
      'Hello WORLD',
    );
    expect(registry.catalog.has('Greeting')).toBe(true);
    expect(JSON.parse(JSON.stringify(registry.manifest))).toEqual([
      {
        name: 'Greeting',
        title: 'Greeting',
        description: 'A greeting',
        version: 2,
        props: registry.catalog.jsonSchemaFor('Greeting'),
      },
    ]);
    expect(() => registry.register(definition, {})).toThrow(/twice|already/);
    expect(createComponentRegistry().catalog.has('Greeting')).toBe(false);
  });
  it('uses the registered trusted text renderer for absent channels', async () => {
    const registry = createComponentRegistry().register(definition, {
      text: (props: { text: string }) => `Trusted ${props.text}`,
    });
    expect(await registry.render(await createComponent(definition)({ text: 'x' }), 'missing')).toBe(
      'Trusted X',
    );
  });
  it('propagates renderer failures', async () => {
    const registry = createComponentRegistry().register(definition, {
      web: () => {
        throw new Error('render failed');
      },
    });
    await expect(
      registry.render(await createComponent(definition)({ text: 'x' }), 'web'),
    ).rejects.toThrow('render failed');
  });
});
