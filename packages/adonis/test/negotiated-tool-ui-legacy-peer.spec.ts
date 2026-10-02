import { expect, it, vi } from 'vitest';

vi.mock('../src/genui/index.js', () => ({
  defineCatalog: () => ({}),
  prepareUiEmission: undefined,
}));

import type { Catalog } from '../src/genui/index.js';
import { createNegotiatedUiCollector } from '../src/negotiated-tool-ui.js';

it('preserves legacy UI when the optional core peer lacks negotiation and capabilities are omitted', async () => {
  const collector = createNegotiatedUiCollector(
    'call',
    { actor: { id: 'actor' } },
    () => ({}) as Catalog,
  );
  await collector.emit('Card', { title: 'Legacy' });
  expect(collector.components()[0]).toMatchObject({
    component: 'Card',
    props: { title: 'Legacy' },
  });
});
it('requires an upgraded peer when renderer capabilities were explicitly supplied', async () => {
  const collector = createNegotiatedUiCollector(
    'call',
    { actor: { id: 'actor' }, uiCapabilities: { components: [] } },
    () => ({}) as Catalog,
  );
  await expect(collector.emit('Card', { title: 'Legacy' })).rejects.toThrow('upgraded');
});
