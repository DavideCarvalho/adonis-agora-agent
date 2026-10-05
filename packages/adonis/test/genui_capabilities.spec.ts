import { describe, expect, it } from 'vitest';
import {
  negotiateCatalog,
  prepareUiEmission,
  validateUiCapabilities,
} from '../src/genui/capabilities.js';
import { defineCatalog, defineComponent } from '../src/genui/catalog.js';
import { GENUI_TREE_COMPONENT } from '../src/genui/tree.js';

const text = defineComponent<{ text: string }>({
  name: 'Text',
  title: 'Text',
  description: 'Text',
  props: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  fallbackText: (props) => props.text,
});
const layout = defineComponent({
  name: 'Stack',
  title: 'Stack',
  description: 'Layout',
  props: { type: 'object' },
  children: true,
});
const catalog = defineCatalog([
  text,
  layout,
  { ...text, name: 'Private', internal: true },
  { ...text, name: 'New', version: 2 },
]);

describe('trusted UI capability negotiation', () => {
  it('intersects names and exact versions with the server catalog, defaulting version to one', () => {
    expect(
      negotiateCatalog(catalog)
        .modelComponents()
        .map((definition) => definition.name),
    ).toEqual(['Text', 'Stack', 'New']);
    expect(negotiateCatalog(catalog, { components: [] }).modelComponents()).toEqual([]);
    expect(
      negotiateCatalog(catalog, {
        components: [
          { name: 'Text', version: 1 },
          { name: 'New', version: 1 },
          { name: 'Unknown', version: 1 },
        ],
      })
        .modelComponents()
        .map((definition) => definition.name),
    ).toEqual(['Text']);
  });
  it('validates advertisements and component versions rather than accepting client schemas', () => {
    for (const value of [
      null,
      {},
      { components: [{ name: 'Text', version: 0 }] },
      { components: [{ name: 'Text', version: 1, props: {} }] },
      { components: [], permissions: ['admin'] },
    ])
      expect(() => validateUiCapabilities(value)).toThrow();
    expect(() => defineComponent({ ...text, version: 0 })).toThrow();
    expect(validateUiCapabilities({ components: [{ name: 'Text', version: 1 }] })).toEqual({
      components: [{ name: 'Text', version: 1 }],
    });
  });
  it('validates unsupported props before text fallback and retains every unsupported tree child', async () => {
    expect(
      await prepareUiEmission(catalog, { components: [] }, 'Text', { text: 'complete answer' }),
    ).toEqual({ kind: 'text', text: 'complete answer' });
    await expect(
      prepareUiEmission(catalog, { components: [] }, 'Text', { text: 2 }),
    ).rejects.toThrow();
    await expect(prepareUiEmission(catalog, { components: [] }, 'Unknown', {})).rejects.toThrow();
    const tree = {
      root: {
        type: 'Stack',
        props: {},
        children: [
          { type: 'Text', props: { text: 'one' } },
          { type: 'Text', props: { text: 'two' } },
        ],
      },
    };
    expect(
      await prepareUiEmission(
        catalog,
        { components: [{ name: 'Stack', version: 1 }] },
        GENUI_TREE_COMPONENT,
        tree,
      ),
    ).toEqual({ kind: 'text', text: 'one\ntwo' });
    expect((await prepareUiEmission(catalog, undefined, GENUI_TREE_COMPONENT, tree)).kind).toBe(
      'ui',
    );
  });
});

it('preserves complete generic fallback content and refuses malformed versioned emissions', async () => {
  const plain = defineCatalog([
    defineComponent({
      name: 'Plain',
      title: 'Plain',
      description: 'Plain',
      props: { type: 'object' },
    }),
  ]);
  const long = 'x'.repeat(4000);
  const emission = await prepareUiEmission(plain, { components: [] }, 'Plain', { text: long });
  expect(emission.kind === 'text' && emission.text.includes(long)).toBe(true);
  await expect(
    prepareUiEmission(catalog, undefined, 'Text', { text: 'answer' }, 2),
  ).rejects.toThrow();
});

it('persists validated text even for drawable components and complete trees', async () => {
  expect(await prepareUiEmission(catalog, undefined, 'Text', { text: 'answer' })).toMatchObject({
    kind: 'ui',
    fallbackText: 'answer',
  });
  expect(
    await prepareUiEmission(catalog, undefined, GENUI_TREE_COMPONENT, {
      root: {
        type: 'Stack',
        props: {},
        children: [
          { type: 'Text', props: { text: 'one' } },
          { type: 'Text', props: { text: 'two' } },
        ],
      },
    }),
  ).toMatchObject({ kind: 'ui', fallbackText: 'one\ntwo' });
});

it('records trusted versions of every validated tree component', async () => {
  expect(
    await prepareUiEmission(catalog, undefined, GENUI_TREE_COMPONENT, {
      root: { type: 'Stack', props: {}, children: [{ type: 'New', props: { text: 'answer' } }] },
    }),
  ).toMatchObject({ kind: 'ui', componentVersions: { Stack: 1, New: 2 }, fallbackText: 'answer' });
});
