import { expect, it } from 'vitest';
import { z } from 'zod';
import { defineCatalog } from '../src/genui/index.js';
import { createNegotiatedUiCollector } from '../src/negotiated-tool-ui.js';

it('validates current catalog before collecting full fallback text for unsupported UI', async () => {
  const catalog = defineCatalog([
    {
      name: 'Card',
      title: 'Card',
      description: 'card',
      props: z.object({ title: z.string() }),
      fallbackText: ({ title }) => title,
    },
  ]);
  const collector = createNegotiatedUiCollector(
    'call',
    { actor: { id: 'actor' }, uiCapabilities: { components: [] } },
    () => catalog,
  );
  await collector.emit('Card', { title: 'Complete text' });
  expect(collector.components()).toEqual([]);
  expect(collector.text()).toBe('Complete text');
  await expect(collector.emit('Card', { title: 1 })).rejects.toThrow();
});
it('without a server catalog, draws declared components and degrades the rest to text', async () => {
  const collector = createNegotiatedUiCollector('call', {
    actor: { id: 'actor' },
    uiCapabilities: { components: [{ name: 'Card', version: 2 }] },
  });
  await collector.emit('Card', { title: 'Drawn' }, { version: 2, fallbackText: 'Drawn' });
  await collector.emit('Card', { title: 'Old' }, { fallbackText: 'Old version as text' });
  await collector.emit('Chart', { points: [1] }, { fallbackText: 'Chart as text' });
  await collector.emit('Forged', {});
  expect(collector.components().map((ui) => [ui.component, ui.version])).toEqual([['Card', 2]]);
  expect(collector.text()).toBe('Old version as text\nChart as text');
});
it('snapshots emitted props before asynchronous catalog resolution', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const catalog = defineCatalog([
    {
      name: 'Card',
      title: 'Card',
      description: 'card',
      props: z.object({ title: z.string() }),
      fallbackText: ({ title }) => title,
    },
  ]);
  const collector = createNegotiatedUiCollector(
    'call',
    { actor: { id: 'actor' }, uiCapabilities: { components: [] } },
    async () => {
      await gate;
      return catalog;
    },
  );
  const props = { title: 'Original' };
  const pending = collector.emit('Card', props);
  props.title = 'Mutated';
  release();
  await pending;
  expect(collector.text()).toBe('Original');
});

it('escapes unsafe human-text units while preserving ordinary Unicode and paired emoji', async () => {
  const { escapeUnsafeToolUiText } = await import('../src/tool-ui.js');
  expect(escapeUnsafeToolUiText('Olá 😀\u0000\ud800 end\udfff')).toBe(
    'Olá 😀\\u0000\\ud800 end\\udfff',
  );
});

it('preserves trusted child-version and fallback metadata for stored supported trees', async () => {
  const catalog = defineCatalog([
    {
      name: 'Card',
      title: 'Card',
      description: 'card',
      version: 3,
      props: z.object({ title: z.string() }),
      fallbackText: ({ title }) => title,
    },
  ]);
  const collector = createNegotiatedUiCollector(
    'tree',
    { actor: { id: 'actor' }, uiCapabilities: { components: [{ name: 'Card', version: 3 }] } },
    () => catalog,
  );
  await collector.emit('genui:tree', { root: { type: 'Card', props: { title: 'Stored text' } } });
  expect(collector.components()[0]).toMatchObject({
    componentVersions: { Card: 3 },
    fallbackText: 'Stored text',
  });
});
