// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { GenerativeUI } from '../../../src/react/core/genui/generative-ui.js';

it('renders persisted text safely when a renderer is absent, incompatible or throws', () => {
  const item = {
    id: 'card',
    component: 'Card',
    props: {},
    version: 1,
    fallbackText: '<script>complete answer</script>',
  };
  const missing = render(<GenerativeUI part={item} registry={{}} />);
  expect(screen.getByText(item.fallbackText)).toBeTruthy();
  expect(missing.container.querySelector('script')).toBeNull();
  missing.unmount();
  const mismatch = render(
    <GenerativeUI
      part={item}
      registry={{ Card: () => <span>wrong version</span> }}
      catalog={{
        has: () => true,
        get: () => ({ version: 2 }),
        validate: async () => ({ ok: true, value: {} }),
      }}
    />,
  );
  expect(screen.queryByText('wrong version')).toBeNull();
  expect(screen.getByText(item.fallbackText)).toBeTruthy();
  mismatch.unmount();
  render(
    <GenerativeUI
      part={item}
      registry={{
        Card: () => {
          throw new Error('renderer failed');
        },
      }}
    />,
  );
  expect(screen.getByText(item.fallbackText)).toBeTruthy();
});

it('falls back to complete tree text when any child is unavailable', () => {
  render(
    <GenerativeUI
      part={{
        id: 'tree',
        component: 'genui:tree',
        fallbackText: 'one\ntwo',
        props: { root: { type: 'Stack', props: {}, children: [{ type: 'Missing', props: {} }] } },
      }}
      registry={{ Stack: ({ children }) => <div>{children}</div> }}
    />,
  );
  expect(screen.getByText(/one\s+two/)).toBeTruthy();
});

it('keeps explicit custom fallback priority and allows an exact-version resolver', () => {
  const item = {
    id: 'card',
    component: 'Card',
    props: {},
    version: 1,
    fallbackText: 'saved answer',
  };
  const hidden = render(<GenerativeUI part={item} registry={{}} fallback={null} />);
  expect(hidden.container.textContent).toBe('');
  hidden.unmount();
  render(
    <GenerativeUI
      part={item}
      registry={{ Card: () => <span>wrong version</span> }}
      resolveComponent={(_name, version) =>
        version === 1 ? () => <span>historic renderer</span> : null
      }
      catalog={{
        has: () => true,
        get: () => ({ version: 2 }),
        validate: async () => ({ ok: true, value: {} }),
      }}
    />,
  );
  expect(screen.getByText('historic renderer')).toBeTruthy();
  expect(screen.queryByText('wrong version')).toBeNull();
});

it('uses complete historical tree text when a child definition changes version with compatible props', () => {
  render(
    <GenerativeUI
      part={{
        id: 'tree',
        component: 'genui:tree',
        fallbackText: 'historical answer',
        componentVersions: { Stack: 1, Card: 1 },
        props: { root: { type: 'Stack', props: {}, children: [{ type: 'Card', props: {} }] } },
      }}
      registry={{
        Stack: ({ children }) => <div>{children}</div>,
        Card: () => <span>new renderer</span>,
      }}
      catalog={{
        has: () => true,
        get: (name) => ({ version: name === 'Card' ? 2 : 1 }),
        validateSync: (_name, props) => ({ ok: true, value: props as Record<string, unknown> }),
        validate: async () => ({ ok: true, value: {} }),
      }}
    />,
  );
  expect(screen.getByText('historical answer')).toBeTruthy();
  expect(screen.queryByText('new renderer')).toBeNull();
});

it('preserves stored text for a malformed historical tree root', () => {
  render(
    <GenerativeUI
      part={{ id: 'tree', component: 'genui:tree', props: {}, fallbackText: 'saved answer' }}
      registry={{}}
    />,
  );
  expect(screen.getByText('saved answer')).toBeTruthy();
});
