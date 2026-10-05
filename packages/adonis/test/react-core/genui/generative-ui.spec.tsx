// @vitest-environment jsdom

import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_COMPONENTS, LAYOUT_COMPONENTS } from '../../../src/genui/builtins.js';
import { defineCatalog } from '../../../src/genui/index.js';
import { MessageItem } from '../../../src/react/core/components/message-item.js';
import {
  GenerativeUI,
  GenuiProvider,
  GenuiTree,
  useGenerativeUI,
} from '../../../src/react/core/genui/generative-ui.js';
import {
  GenuiProvider as JsonRenderGenuiProvider,
  jsonRenderTree,
  toJsonRenderRegistry,
  treeToJsonRenderSpec,
} from '../../../src/react/core/genui/json-render.js';
import { GENUI_TREE_COMPONENT, type GenuiRegistry } from '../../../src/react/core/genui/types.js';

afterEach(cleanup);

const registry: GenuiRegistry = {
  Callout: ({ text, tone }: { text: string; tone?: string }) => (
    <p data-testid="callout" data-tone={tone}>
      {text}
    </p>
  ),
  Card: ({ title, children }: { title?: string; children?: ReactNode }) => (
    <section data-testid="card" aria-label={title}>
      {children}
    </section>
  ),
  Text: ({ text }: { text: string }) => <span>{text}</span>,
  Boom: () => {
    throw new Error('renderer exploded');
  },
};

const catalog = defineCatalog([...BUILTIN_COMPONENTS, ...LAYOUT_COMPONENTS]);

const block = (component: string, props: Record<string, unknown>, version?: number) => ({
  kind: 'ui' as const,
  key: `m1-ui-${component}`,
  id: `${component}-1`,
  component,
  props,
  version: version ?? null,
  toolCallId: null,
});

describe('<GenerativeUI>', () => {
  it('renders a transcript block and a data-ui part with the app renderer, adding no element', () => {
    const { container } = render(
      <GenerativeUI
        part={block('Callout', { text: 'Heads up', tone: 'warning' })}
        registry={registry}
      />,
    );
    expect(container.innerHTML).toBe('<p data-testid="callout" data-tone="warning">Heads up</p>');
    cleanup();
    render(
      <GenerativeUI
        part={{
          type: 'data-ui',
          id: 'u1',
          data: { id: 'u1', component: 'Text', props: { text: 'hi' } },
        }}
        registry={registry}
      />,
    );
    expect(screen.getByText('hi')).toBeTruthy();
  });

  it('hands an unknown component to the fallback', () => {
    render(
      <GenerativeUI
        part={block('Mystery', {})}
        registry={registry}
        fallback={(problem) => <i>{`${problem.reason}:${problem.item.component}`}</i>}
      />,
    );
    expect(screen.getByText('unknown:Mystery')).toBeTruthy();
  });

  it('refuses props the catalog rejects, on the first render', () => {
    render(
      <GenerativeUI
        part={block('Callout', { tone: 'loud' })}
        registry={registry}
        catalog={catalog}
        fallback={(problem) =>
          problem.reason === 'invalid' ? (
            <i>{problem.issues.map((i) => i.path.join('.')).join(',')}</i>
          ) : null
        }
      />,
    );
    expect(screen.getByText('text,tone')).toBeTruthy();
    expect(screen.queryByTestId('callout')).toBeNull();
  });

  it('resolves a tenant component by name and version, once, showing loading meanwhile', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolveComponent = vi.fn(async (name: string, version: number | null) => {
      await gate;
      return name === 'DealCard'
        ? ({ stage }: { stage: string }) => <b>{`deal v${version}: ${stage}`}</b>
        : null;
    });
    const props = { part: block('DealCard', { stage: 'won' }, 3), registry, resolveComponent };
    const { rerender } = render(<GenerativeUI {...props} loading={<i>loading</i>} />);
    expect(screen.getByText('loading')).toBeTruthy();
    await act(async () => {
      release();
      await gate;
    });
    expect(screen.getByText('deal v3: won')).toBeTruthy();
    rerender(<GenerativeUI {...props} loading={<i>loading</i>} />);
    expect(resolveComponent).toHaveBeenCalledTimes(1);
  });

  it('contains a renderer that throws to its own item', () => {
    const onError = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <div>
        <GenerativeUI
          part={block('Boom', {})}
          registry={registry}
          onError={onError}
          fallback={(problem) => <i>{problem.reason}</i>}
        />
        <GenerativeUI part={block('Text', { text: 'still here' })} registry={registry} />
      </div>,
    );
    expect(screen.getByText('error')).toBeTruthy();
    expect(screen.getByText('still here')).toBeTruthy();
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ component: 'Boom' }),
    );
  });

  it('renders a tree frame node by node, with per-node fallbacks', () => {
    const root = {
      type: 'Card',
      props: { title: 'Signups' },
      children: [
        { type: 'Text', props: { text: 'first' } },
        { type: 'Nope', props: {} },
        { type: 'Callout', props: {} },
      ],
    };
    render(
      <GenerativeUI
        part={block(GENUI_TREE_COMPONENT, { root })}
        registry={registry}
        catalog={catalog}
        fallback={(problem) => <i>{`${problem.reason}:${problem.item.component}`}</i>}
      />,
    );
    const card = screen.getByTestId('card');
    expect(card.getAttribute('aria-label')).toBe('Signups');
    expect(card.textContent).toBe('firstunknown:Nopeinvalid:Callout');
  });

  it('lets the registry override the tree renderer', () => {
    render(
      <GenerativeUI
        part={block(GENUI_TREE_COMPONENT, { root: { type: 'Text', props: { text: 'x' } } })}
        registry={{ ...registry, [GENUI_TREE_COMPONENT]: () => <i>custom tree</i> }}
      />,
    );
    expect(screen.getByText('custom tree')).toBeTruthy();
  });
});

describe('useGenerativeUI', () => {
  it('reports each state, and null for a part that is not a pushed component', () => {
    const { result, rerender } = renderHook(
      ({ part }: { part: unknown }) => useGenerativeUI(part, { registry, catalog }),
      { initialProps: { part: { type: 'text', text: 'hi' } as unknown } },
    );
    expect(result.current).toBeNull();
    rerender({ part: block('Callout', { text: 'ok' }) });
    expect(result.current).toMatchObject({ status: 'ready', props: { text: 'ok' } });
    rerender({
      part: block(GENUI_TREE_COMPONENT, { root: { type: 'Text', props: { text: 'x' } } }),
    });
    expect(result.current).toMatchObject({ status: 'ready', Component: GenuiTree });
    rerender({ part: block('Mystery', {}) });
    expect(result.current).toMatchObject({ status: 'problem', reason: 'unknown' });
  });

  it('waits for an async catalog validation', async () => {
    const asyncCatalog = {
      has: () => true,
      validate: async (_name: string, props: unknown) => ({
        ok: true as const,
        value: { ...(props as Record<string, unknown>), checked: true },
      }),
    };
    const part = block('Text', { text: 'x' });
    const { result } = renderHook(() => useGenerativeUI(part, { registry, catalog: asyncCatalog }));
    expect(result.current?.status).toBe('loading');
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toMatchObject({ status: 'ready', props: { text: 'x', checked: true } });
  });
});

describe('json-render adapter', () => {
  const root = {
    type: 'Card',
    props: { title: 'T' },
    children: [{ type: 'Text', props: { text: 'inside' } }],
  };

  it('flattens a tree into a json-render spec', () => {
    expect(treeToJsonRenderSpec(root)).toEqual({
      root: 'el-0',
      elements: {
        'el-0': { type: 'Card', props: { title: 'T' }, children: ['el-1'] },
        'el-1': { type: 'Text', props: { text: 'inside' }, children: [] },
      },
    });
  });

  it('renders a tree frame through json-render with the same components', () => {
    render(
      <GenerativeUI
        part={block(GENUI_TREE_COMPONENT, { root })}
        registry={{ [GENUI_TREE_COMPONENT]: jsonRenderTree(toJsonRenderRegistry(registry)) }}
      />,
    );
    expect(screen.getByTestId('card').textContent).toBe('inside');
  });

  it('jsonRender: true derives the json-render registry from the provider registry', () => {
    render(
      <JsonRenderGenuiProvider registry={registry} jsonRender>
        <GenerativeUI part={block(GENUI_TREE_COMPONENT, { root })} />
      </JsonRenderGenuiProvider>,
    );
    expect(screen.getByTestId('card').textContent).toBe('inside');
  });

  it('jsonRender takes a json-render registry of its own', () => {
    const own = toJsonRenderRegistry({
      Card: ({ children }: { children?: ReactNode }) => (
        <article data-testid="own">{children}</article>
      ),
      Text: ({ text }: { text: string }) => <b>{text}</b>,
    });
    render(
      <JsonRenderGenuiProvider registry={registry} jsonRender={own}>
        <GenerativeUI part={block(GENUI_TREE_COMPONENT, { root })} />
      </JsonRenderGenuiProvider>,
    );
    expect(screen.getByTestId('own').textContent).toBe('inside');
  });
});

describe('<GenuiProvider>', () => {
  it('supplies registry, catalog and fallback to every <GenerativeUI> below it', () => {
    render(
      <GenuiProvider
        registry={registry}
        catalog={catalog}
        fallback={(problem) => <i>{`${problem.reason}:${problem.item.component}`}</i>}
      >
        <GenerativeUI part={block('Callout', { text: 'ok' })} />
        <GenerativeUI part={block('Callout', { tone: 'loud' })} />
        <GenerativeUI part={block('Mystery', {})} />
      </GenuiProvider>,
    );
    expect(screen.getByTestId('callout').textContent).toBe('ok');
    expect(screen.getByText('invalid:Callout')).toBeTruthy();
    expect(screen.getByText('unknown:Mystery')).toBeTruthy();
  });

  it("lets a <GenerativeUI>'s own props win", () => {
    render(
      <GenuiProvider registry={registry} fallback={<i>provider fallback</i>}>
        <GenerativeUI
          part={block('Callout', { text: 'mine' })}
          registry={{ Callout: ({ text }: { text: string }) => <em>{`own ${text}`}</em> }}
        />
        <GenerativeUI part={block('Mystery', {})} fallback={<i>own fallback</i>} />
      </GenuiProvider>,
    );
    expect(screen.getByText('own mine')).toBeTruthy();
    expect(screen.getByText('own fallback')).toBeTruthy();
    expect(screen.queryByText('provider fallback')).toBeNull();
  });

  it('renders trees through a treeRenderer instead of node by node', () => {
    render(
      <GenuiProvider registry={registry} treeRenderer={() => <i>whole tree</i>}>
        <GenerativeUI
          part={block(GENUI_TREE_COMPONENT, { root: { type: 'Text', props: { text: 'x' } } })}
        />
      </GenuiProvider>,
    );
    expect(screen.getByText('whole tree')).toBeTruthy();
  });

  it('makes MessageItem draw pushed components with no renderUi', () => {
    const message: UIMessage = {
      id: 'm1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Before' },
        {
          type: 'data-ui',
          id: 'ui-1',
          data: { id: 'ui-1', component: 'Callout', props: { text: 'pushed' } },
        },
      ],
    };
    const { container } = render(
      <GenuiProvider registry={registry} catalog={catalog}>
        <MessageItem message={message} />
      </GenuiProvider>,
    );
    expect(screen.getByTestId('callout').textContent).toBe('pushed');
    expect(container.querySelector('[data-slot="ui"]')?.getAttribute('data-component')).toBe(
      'Callout',
    );
    cleanup();
    // An explicit renderUi still wins.
    render(
      <GenuiProvider registry={registry}>
        <MessageItem message={message} renderUi={(ui) => <b>{`custom ${ui.component}`}</b>} />
      </GenuiProvider>,
    );
    expect(screen.getByText('custom Callout')).toBeTruthy();
  });

  it('useGenerativeUI reads the provider when given no options', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <GenuiProvider registry={registry}>{children}</GenuiProvider>
    );
    const { result } = renderHook(() => useGenerativeUI(block('Text', { text: 'x' })), { wrapper });
    expect(result.current?.status).toBe('ready');
  });
});
