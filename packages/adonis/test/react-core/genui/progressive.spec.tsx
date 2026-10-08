// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { type ReactNode, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeFrame, foldPart, settleParts } from '../../../src/client/sse.js';
import { Card, Chart, KpiCards } from '../../../src/genui/builtins.js';
import { defineCatalog } from '../../../src/genui/index.js';
import { reframeAgUiStream } from '../../../src/react/core/ag-ui-backend.js';
import { GenerativeUI, useGenuiNode } from '../../../src/react/core/genui/generative-ui.js';
import { treeToJsonRenderSpec } from '../../../src/react/core/genui/json-render.js';
import type { GenuiRegistry } from '../../../src/react/core/genui/types.js';
import { storedMessageToUiMessage } from '../../../src/react/core/stored-message-to-ui-message.js';
import { buildTranscriptBlocks } from '../../../src/react/core/transcript/model.js';

afterEach(cleanup);

const catalog = defineCatalog([Card, Chart, KpiCards]);
const mounts = new Map<string, number>();

function Mounted({ name, children }: { name: string; children?: ReactNode }) {
  useEffect(() => {
    mounts.set(name, (mounts.get(name) ?? 0) + 1);
  }, [name]);
  return <>{children}</>;
}

const registry: GenuiRegistry = {
  Card: ({ title, children }: { title?: string; children?: ReactNode }) => {
    const node = useGenuiNode();
    return (
      <Mounted name="card">
        <section data-testid="card" data-incomplete={String(node?.incomplete)} data-id={node?.id}>
          <h2>{title}</h2>
          {children}
        </section>
      </Mounted>
    );
  },
  Chart: ({ title, data }: { title?: string; data?: unknown[] }) => {
    const node = useGenuiNode();
    return (
      <Mounted name="chart">
        <figure data-testid="chart" data-incomplete={String(node?.incomplete)} data-id={node?.id}>
          {node?.incomplete && !data?.length ? `skeleton ${title ?? ''}` : `${data?.length} points`}
        </figure>
      </Mounted>
    );
  },
};

const tree = (root: unknown, partial: boolean) => ({
  kind: 'ui' as const,
  key: 'm1-ui-call-0:ui:0',
  id: 'call-0:ui:0',
  component: 'genui:tree',
  props: { root },
  version: 1,
  toolCallId: 'call-0',
  ...(partial ? { partial: true as const } : {}),
});

const finalChart = {
  type: 'Chart',
  props: {
    type: 'bar',
    title: 'Revenue',
    xKey: 'm',
    series: [{ key: 'v' }],
    data: [{ m: 'a', v: 1 }],
  },
};

describe('<GenerativeUI> with a streaming tree', () => {
  it('draws incomplete nodes unvalidated, tells the renderer, and never remounts them', () => {
    mounts.clear();
    const first = tree(
      {
        id: 'root',
        type: 'Card',
        props: { title: 'Sal' },
        incomplete: true,
        children: [{ id: 'root.0', type: 'Chart', props: { title: 'Rev' }, incomplete: true }],
      },
      true,
    );
    const view = render(<GenerativeUI part={first} registry={registry} catalog={catalog} />);
    expect(screen.getByTestId('card').dataset.incomplete).toBe('true');
    expect(screen.getByTestId('card').dataset.id).toBe('root');
    // A Chart without its required props would fail validation; while incomplete it is not checked.
    expect(screen.getByTestId('chart').textContent).toBe('skeleton Rev');
    expect(screen.getByTestId('chart').dataset.id).toBe('root.0');

    // The final frame replaces the preview in place: same nodes, no longer incomplete.
    view.rerender(
      <GenerativeUI
        part={tree({ type: 'Card', props: { title: 'Sales' }, children: [finalChart] }, false)}
        registry={registry}
        catalog={catalog}
      />,
    );
    expect(screen.getByTestId('card').dataset.incomplete).toBe('false');
    expect(screen.getByTestId('chart').textContent).toBe('1 points');
    expect(screen.getByTestId('chart').dataset.id).toBe('root.0');
    expect(mounts).toEqual(
      new Map([
        ['card', 1],
        ['chart', 1],
      ]),
    );
  });

  it('validates the final tree as before: invalid props fall back', () => {
    render(
      <GenerativeUI
        part={tree({ type: 'Chart', props: { title: 'Rev' } }, false)}
        registry={registry}
        catalog={catalog}
        fallback={({ reason }) => <i>fallback {reason}</i>}
      />,
    );
    expect(screen.getByText('fallback invalid')).toBeTruthy();
  });

  it('draws a placeholder for a held node, with the node state', () => {
    render(
      <GenerativeUI
        part={tree(
          {
            id: 'root',
            type: 'Card',
            props: {},
            incomplete: true,
            children: [{ id: 'root.0', type: 'Chart', props: {}, incomplete: true, held: true }],
          },
          true,
        )}
        registry={registry}
        catalog={catalog}
        placeholder={(node) => <i data-testid="placeholder">{`${node.type} ${node.id}`}</i>}
      />,
    );
    expect(screen.getByTestId('placeholder').textContent).toBe('Chart root.0');
    expect(screen.queryByTestId('chart')).toBeNull();
  });

  it('draws nothing for a withdrawn preview', () => {
    const { container } = render(
      <GenerativeUI
        part={{ ...tree(undefined, true), props: {} }}
        registry={registry}
        catalog={catalog}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('leaves held nodes out of a json-render spec', () => {
    expect(
      treeToJsonRenderSpec({
        type: 'Card',
        props: {},
        children: [{ type: 'Chart', props: {}, held: true }],
      }).elements,
    ).toEqual({ 'el-0': { type: 'Card', props: {}, children: [] } });
  });
});

describe('the transcript keeps a preview only while its call is being written', () => {
  const ui = (props: Record<string, unknown>, partial = true) => ({
    type: 'data-ui' as const,
    id: 'call-0:ui:0',
    data: {
      id: 'call-0:ui:0',
      component: 'genui:tree',
      props,
      toolCallId: 'call-0',
      ...(partial ? { partial: true } : {}),
    },
  });
  const call = (state: string) =>
    ({ type: 'tool-ui__render', toolCallId: 'call-0', state, input: {} }) as never;
  const blocks = (parts: unknown[]) =>
    buildTranscriptBlocks({ id: 'm1', role: 'assistant', parts } as UIMessage, {
      isReasoningOpen: () => false,
      toggleReasoning: () => undefined,
    }).filter((block) => block.kind === 'ui');

  it('keeps a standing preview, flagged partial', () => {
    expect(blocks([call('input-streaming'), ui({ root: { type: 'Card' } })])).toEqual([
      expect.objectContaining({ id: 'call-0:ui:0', partial: true }),
    ]);
  });

  it('drops a withdrawn one, and one its call settled without replacing', () => {
    expect(blocks([call('input-available'), ui({})])).toEqual([]);
    expect(blocks([call('output-error'), ui({ root: { type: 'Card' } })])).toEqual([]);
    // Replaced by the final push: kept.
    expect(blocks([call('output-available'), ui({ root: { type: 'Card' } }, false)])).toHaveLength(
      1,
    );
  });
});

describe('the framework-free client', () => {
  const frame = (props: Record<string, unknown>, partial = true) =>
    decodeFrame({
      event: 'message',
      data: JSON.stringify({
        kind: 'ui',
        id: 'call-0:ui:0',
        component: 'genui:tree',
        props,
        ...(partial ? { partial: true } : {}),
      }),
    } as never);

  it('replaces a preview in place, removes a withdrawn one, and settles leftovers', () => {
    const preview = frame({ root: { type: 'Card' } });
    expect(preview).toMatchObject({ type: 'component', partial: true });
    let parts = foldPart([], preview as never);
    parts = foldPart(parts, frame({ root: { type: 'Card', props: { title: 'S' } } }) as never);
    expect(parts).toHaveLength(1);
    expect(settleParts(parts)).toEqual([]);
    expect(foldPart(parts, frame({}) as never)).toEqual([]);
    const final = foldPart(parts, frame({ root: { type: 'Card' } }, false) as never);
    expect(final).toEqual([
      {
        type: 'component',
        name: 'genui:tree',
        id: 'call-0:ui:0',
        data: { root: { type: 'Card' } },
      },
    ]);
    expect(settleParts(final)).toBe(final);
  });
});

describe('agUiBackend re-framing', () => {
  it('turns repeated agora.ui events into ui frames with the same id, partial kept', async () => {
    const events = [
      { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
      {
        type: 'CUSTOM',
        name: 'agora.ui',
        value: {
          id: 'c:ui:0',
          component: 'genui:tree',
          props: { root: { type: 'Card' } },
          partial: true,
        },
      },
      {
        type: 'CUSTOM',
        name: 'agora.ui',
        value: {
          id: 'c:ui:0',
          component: 'genui:tree',
          props: { root: { type: 'Card', props: {} } },
        },
      },
      { type: 'RUN_FINISHED', threadId: 't', runId: 'r' },
    ];
    const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
    const text = await new Response(
      reframeAgUiStream(new Response(body).body as ReadableStream<Uint8Array>, { threadId: 't' }),
    ).text();
    const ui = text
      .split('\n\n')
      .filter((block) => block.includes('"kind":"ui"'))
      .map((block) => JSON.parse(block.slice(block.indexOf('data: ') + 6)));
    expect(ui.map((frame) => [frame.id, frame.partial])).toEqual([
      ['c:ui:0', true],
      ['c:ui:0', undefined],
    ]);
  });
});

describe('threads persisted before tree mode was the default', () => {
  it('still draw their per-component ui parts (a ui__show_* push) with the same renderer', () => {
    const stored = storedMessageToUiMessage({
      id: 'm-old',
      threadId: 't',
      role: 'assistant',
      content: 'Your revenue:',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      toolCalls: [{ id: 'c1', name: 'ui__show_chart', input: finalChart.props }],
      toolResults: [
        { id: 'c1', name: 'ui__show_chart', output: { shown: 'Chart', id: 'c1:ui:0' } },
      ],
      ui: [
        {
          id: 'c1:ui:0',
          component: 'Chart',
          props: finalChart.props,
          version: 1,
          fallbackText: 'Revenue',
          toolCallId: 'c1',
        },
      ],
    } as never);
    const [block] = buildTranscriptBlocks(stored, {
      isReasoningOpen: () => false,
      toggleReasoning: () => undefined,
    }).filter((each) => each.kind === 'ui');
    expect(block).toMatchObject({ component: 'Chart', id: 'c1:ui:0' });
    render(<GenerativeUI part={block} registry={registry} catalog={catalog} />);
    expect(screen.getByTestId('chart').textContent).toBe('1 points');
    // Outside a tree: no node state, nothing incomplete.
    expect(screen.getByTestId('chart').dataset.incomplete).toBe('undefined');
  });
});
