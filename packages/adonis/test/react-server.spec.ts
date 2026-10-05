import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { DataTable } from '../src/genui/builtins.js';
import { createComponent, defineComponent } from '../src/genui/index.js';
import { createReactComponentRegistry } from '../src/react/core/genui/react-registry.js';
import { createReactServerRenderer } from '../src/react/core/genui/server.js';

const definition = defineComponent<{ value: string }>({
  name: 'Greeting',
  title: 'Greeting',
  description: 'test',
  version: 2,
  props: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
});
describe('React server renderer', () => {
  it('validates every DataTable slice and bounds public pagination sizes', async () => {
    const constrained = defineComponent<{ rows: { name: string }[] }>({
      name: 'DataTable',
      title: 'Constrained table',
      description: 'test',
      props: {
        type: 'object',
        properties: { rows: { type: 'array', minItems: 2, items: { type: 'object' } } },
        required: ['rows'],
      },
    });
    let rendered = 0;
    const registry = createReactComponentRegistry().register(constrained, {
      react: () => {
        rendered++;
        return createElement('p', null, 'table');
      },
    });
    const presentation = await createComponent(constrained)({
      rows: [{ name: 'one' }, { name: 'two' }, { name: 'three' }],
    });
    const capture = { images: async () => [new Uint8Array()], pdf: async () => new Uint8Array() };
    await expect(
      createReactServerRenderer({ registry }).images(presentation, { rowsPerPage: 2, capture }),
    ).rejects.toThrow(/props/);
    expect(rendered).toBe(0);
    await expect(registry.paginate(presentation, 0)).rejects.toThrow(/rowsPerPage/);
  });

  it('reads trusted filesystem stylesheets on the server', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'genui-style-'));
    try {
      const path = join(directory, 'app.css');
      await writeFile(path, 'main { color: blue }');
      const registry = createReactComponentRegistry().register(definition, {
        react: ({ value }) => createElement('p', null, value),
      });
      expect(
        await createReactServerRenderer({ registry, stylesheet: { path } }).html(
          await createComponent(definition)({ value: 'hello' }),
        ),
      ).toContain('main { color: blue }');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps transformed portable props unchanged through HTML and capture', async () => {
    const transformed = defineComponent<{ value: string }>({
      ...definition,
      outputProps: definition.props,
      props: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value: unknown) => ({
            value: { value: `${(value as { value: string }).value}!` },
          }),
        },
      },
    });
    const registry = createReactComponentRegistry().register(transformed, {
      react: ({ value }) => createElement('p', null, value),
    });
    const renderer = createReactServerRenderer({ registry });
    const presentation = await createComponent(transformed)({ value: 'hello' });
    expect(await renderer.html(presentation)).toContain('<p>hello!</p>');
    await renderer.images(presentation, {
      capture: {
        images: async (pages) => {
          expect(pages[0]).toContain('<p>hello!</p>');
          return [new Uint8Array()];
        },
        pdf: async () => new Uint8Array(),
      },
    });
  });

  it('validates before rendering, escapes content and theme, and uses app CSS', async () => {
    let calls = 0;
    const registry = createReactComponentRegistry().register(definition, {
      react: ({ value }) => {
        calls++;
        return createElement('p', null, value);
      },
    });
    const renderer = createReactServerRenderer({
      registry,
      stylesheet: 'p { color: red }',
      theme: '" onload="evil',
    });
    const presentation = await createComponent(definition)({ value: '<script>evil</script>' });
    const html = await renderer.html(presentation);
    expect(html).toContain('&lt;script&gt;evil&lt;/script&gt;');
    expect(html).toContain('p { color: red }');
    expect(html).toContain('&quot; onload=&quot;evil');
    expect(registry.components.Greeting).toBeDefined();
    await expect(renderer.html({ ...presentation, props: { value: 123 } })).rejects.toThrow();
    await expect(renderer.html({ ...presentation, version: 1 })).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it('splits every table row before rendering and sends pages to capture', async () => {
    const registry = createReactComponentRegistry().register(DataTable, {
      react: (props) =>
        createElement(
          'table',
          null,
          createElement(
            'tbody',
            null,
            (props.rows as { name: string }[]).map((row) =>
              createElement('tr', { key: row.name }, createElement('td', null, row.name)),
            ),
          ),
        ),
    });
    const presentation = await createComponent(DataTable)({
      columns: [{ key: 'name', label: 'Name' }],
      rows: Array.from({ length: 7 }, (_, i) => ({ name: `record-${i}` })),
    });
    const captured: string[][] = [];
    const capture = {
      images: async (html: readonly string[]) => {
        captured.push([...html]);
        return html.map(() => new Uint8Array([137, 80, 78, 71]));
      },
      pdf: async (html: readonly string[]) => {
        captured.push([...html]);
        return new Uint8Array([37, 80, 68, 70]);
      },
    };
    const renderer = createReactServerRenderer({ registry });
    expect(await renderer.images(presentation, { rowsPerPage: 3, capture })).toHaveLength(3);
    expect(captured[0]?.map((html) => (html.match(/record-/g) ?? []).length)).toEqual([3, 3, 1]);
    for (let i = 0; i < 7; i++) expect(captured[0]?.join('')).toContain(`record-${i}`);
    await renderer.pdf(presentation, { rowsPerPage: 3, capture });
    expect(captured[1]).toHaveLength(3);
    await expect(renderer.images(presentation, { capture, width: 10000 })).rejects.toThrow();
    await expect(renderer.images(presentation)).rejects.toThrow(/capture/i);
  });
  it('validates custom pagination output before rendering', async () => {
    let rendered = 0;
    const registry = createReactComponentRegistry().register(definition, {
      react: ({ value }) => {
        rendered++;
        return createElement('p', null, value);
      },
      paginate: () => [{ value: 'first' }, { value: 'second' }],
    });
    const renderer = createReactServerRenderer({ registry });
    const capture = {
      images: async (pages: readonly string[]) => {
        expect(pages[0]).toContain('first');
        expect(pages[1]).toContain('second');
        return pages.map(() => new Uint8Array());
      },
      pdf: async () => new Uint8Array(),
    };
    await renderer.images(await createComponent(definition)({ value: 'original' }), { capture });
    expect(rendered).toBe(2);
    const invalid = createReactComponentRegistry().register(definition, {
      react: () => {
        throw new Error('Should not render invalid page');
      },
      paginate: () => [{ value: 12 } as unknown as { value: string }],
    });
    await expect(
      createReactServerRenderer({ registry: invalid }).images(
        await createComponent(definition)({ value: 'original' }),
        { capture },
      ),
    ).rejects.toThrow(/props/);
  });
  it('supports custom pagination and trusted fallback without React mapping', async () => {
    const registry = createReactComponentRegistry().register(definition, {
      text: ({ value }) => `trusted ${value}`,
    });
    const renderer = createReactServerRenderer({ registry });
    expect(await renderer.html(await createComponent(definition)({ value: '<hello>' }))).toContain(
      'trusted &lt;hello&gt;',
    );
  });
});
