import { expect, it } from 'vitest';
import { defineCatalog } from '../src/genui/index.js';
import { createNegotiatedUiCollector } from '../src/negotiated-tool-ui.js';

const catalog = defineCatalog([
  {
    name: 'Card',
    title: 'Card',
    description: 'A card',
    version: 2,
    props: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    fallbackText: ({ title }) => title,
  },
]);

it('always validates against the owned catalog when no capabilities were supplied', async () => {
  const collector = createNegotiatedUiCollector('call', { actor: { id: 'actor' } }, () => catalog);
  await collector.emit('Card', { title: 'Owned' });
  expect(collector.components()[0]).toMatchObject({
    component: 'Card',
    version: 2,
    props: { title: 'Owned' },
  });
  await expect(collector.emit('Card', { title: 42 })).rejects.toThrow();
});

it('supports negotiated UI without any external core peer', async () => {
  const collector = createNegotiatedUiCollector(
    'call',
    {
      actor: { id: 'actor' },
      uiCapabilities: { components: [{ name: 'Card', version: 2 }] },
    },
    () => catalog,
  );
  await collector.emit('Card', { title: 'Supported' });
  expect(collector.components()[0]).toMatchObject({
    component: 'Card',
    version: 2,
    fallbackText: 'Supported',
  });
});
