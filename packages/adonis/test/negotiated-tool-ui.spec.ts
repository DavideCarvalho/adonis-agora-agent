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
it('refuses explicit capabilities when there is no server-owned catalog', async () => {
  const collector = createNegotiatedUiCollector('call', {
    actor: { id: 'actor' },
    uiCapabilities: { components: [] },
  });
  await expect(collector.emit('Forged', {})).rejects.toThrow('catalog');
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
