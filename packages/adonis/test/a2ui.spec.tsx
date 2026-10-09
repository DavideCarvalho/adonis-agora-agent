// @vitest-environment jsdom
import { A2uiSurface, basicCatalog } from '@a2ui/react/v0_9';
import { A2uiMessageSchema, MessageProcessor } from '@a2ui/web_core/v0_9';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  A2UI_BASIC_CATALOG_ID,
  A2uiProjector,
  type A2uiServerMessage,
  a2uiActivityEvent,
  a2uiCatalog,
  a2uiSurfaceMessages,
  readA2uiAction,
  toA2uiComponents,
} from '../src/a2ui/index.js';
import { AgUiEncoder } from '../src/ag-ui/core/index.js';
import { readForwardedProps } from '../src/ag-ui/core/input.js';
import {
  Callout,
  Card,
  Chart,
  DataTable,
  Heading,
  KpiCards,
  Link,
  Stack,
  Text,
} from '../src/genui/builtins.js';
import { defineCatalog, Sandbox } from '../src/genui/index.js';

const catalog = defineCatalog([
  Stack,
  Card,
  Heading,
  Text,
  KpiCards,
  DataTable,
  Chart,
  Callout,
  Link,
  Sandbox,
]);

const dashboard = {
  type: 'Card',
  props: { title: 'Sales', subtitle: 'Q1' },
  children: [
    { type: 'KpiCards', props: { items: [{ label: 'Revenue', value: '$9k', delta: '+12%' }] } },
    {
      type: 'Stack',
      props: { direction: 'row' },
      children: [
        { type: 'Heading', props: { text: 'Top orders' } },
        { type: 'Callout', props: { tone: 'info', title: 'Note', text: 'Refunds pending' } },
      ],
    },
    {
      type: 'DataTable',
      props: {
        columns: [
          { key: 'id', label: 'Order' },
          { key: 'total', label: 'Total' },
        ],
        rows: [
          { id: '#1', total: 120 },
          { id: '#2', total: 80 },
        ],
      },
    },
    {
      type: 'Chart',
      props: {
        type: 'bar',
        title: 'Revenue',
        xKey: 'month',
        series: [{ key: 'revenue' }],
        data: [{ month: 'Jan', revenue: 1 }],
      },
    },
    { type: 'Link', props: { text: 'Docs', url: 'https://a2ui.org' } },
  ],
};

/** Every message must pass the official v0.9 schema (`@a2ui/web_core`). */
function assertValid(messages: readonly unknown[]): void {
  for (const message of messages) {
    const result = A2uiMessageSchema.safeParse(message);
    if (!result.success) {
      throw new Error(
        `not a valid A2UI v0.9 message: ${JSON.stringify(result.error.issues).slice(0, 500)}\n${JSON.stringify(message).slice(0, 500)}`,
      );
    }
  }
}

function surfaceOf(messages: A2uiServerMessage[], surfaceId = 's1') {
  const actions: unknown[] = [];
  const processor = new MessageProcessor(
    [basicCatalog],
    (action: unknown) => void actions.push(action),
  );
  processor.processMessages(messages as never);
  const surface = processor.model.surfacesMap.get(surfaceId);
  if (surface === undefined) throw new Error('no surface');
  return { surface, actions, processor };
}

describe('outbound: ui frames as A2UI v0.9', () => {
  it('maps a composed tree onto the basic catalog, ids by position, root first', () => {
    const components = toA2uiComponents(
      { component: 'genui:tree', props: { root: dashboard } },
      { catalog },
    );
    expect(components[0]).toMatchObject({ id: 'root', component: 'Card' });
    const ids = new Set(components.map((component) => component.id));
    expect(ids.size).toBe(components.length);
    for (const component of components) {
      for (const ref of [
        ...((component.children as string[] | undefined) ?? []),
        ...(typeof component.child === 'string' ? [component.child] : []),
      ]) {
        expect(ids.has(ref), `${component.id} → ${ref}`).toBe(true);
      }
    }
    expect(ids.has('root.1')).toBe(true);
    expect(components.find((c) => c.id === 'root.1')?.component).toBe('Row');
    const messages = a2uiSurfaceMessages('s1', components, { create: true });
    expect(messages[0]).toEqual({
      version: 'v0.9',
      createSurface: { surfaceId: 's1', catalogId: A2UI_BASIC_CATALOG_ID },
    });
    assertValid(messages);
  });

  it('renders with the official React renderer (@a2ui/react v0_9)', async () => {
    const messages = a2uiSurfaceMessages(
      's1',
      toA2uiComponents({ component: 'genui:tree', props: { root: dashboard } }, { catalog }),
      { create: true },
    );
    const { surface } = surfaceOf(messages);
    render(<A2uiSurface surface={surface as never} />);
    expect(await screen.findByText('Sales')).toBeTruthy();
    expect(screen.getByText('$9k')).toBeTruthy();
    expect(screen.getByText('Top orders')).toBeTruthy();
    expect(screen.getByText('Refunds pending')).toBeTruthy();
    expect(screen.getByText('#2')).toBeTruthy();
    expect(screen.getByText('Docs')).toBeTruthy();
  });

  it('streams: a partial tree grows the same surface, a held node is a placeholder', async () => {
    const preview = {
      id: 'root',
      type: 'Card',
      props: { title: 'Sales' },
      incomplete: true,
      children: [
        {
          id: 'root.0',
          type: 'KpiCards',
          props: { items: [{ label: 'Revenue' }] },
          incomplete: true,
        },
        { id: 'root.1', type: 'Chart', props: {}, held: true, incomplete: true },
      ],
    };
    const first = toA2uiComponents(
      { component: 'genui:tree', props: { root: preview } },
      { catalog },
    );
    expect(first.some((component) => component.id === 'root.1')).toBe(false);
    const projector = new A2uiProjector({ catalog });
    const early = projector.project({
      type: 'CUSTOM',
      name: 'agora.ui',
      value: { id: 'c1:ui:0', component: 'genui:tree', props: { root: preview }, partial: true },
    });
    const late = projector.project({
      type: 'CUSTOM',
      name: 'agora.ui',
      value: { id: 'c1:ui:0', component: 'genui:tree', props: { root: dashboard } },
    });
    expect(early.map((m) => Object.keys(m)[1])).toEqual(['createSurface', 'updateComponents']);
    expect(late.map((m) => Object.keys(m)[1])).toEqual(['updateComponents']);
    assertValid([...early, ...late]);
    const processor = new MessageProcessor([basicCatalog]);
    processor.processMessages(early as never);
    const surface = processor.model.surfacesMap.get('c1:ui:0');
    if (surface === undefined) throw new Error('no surface');
    render(<A2uiSurface surface={surface as never} />);
    expect(await screen.findByText('Revenue')).toBeTruthy();
    expect(screen.queryByText('Top orders')).toBeNull();
    await act(async () => processor.processMessages(late as never));
    expect(await screen.findByText('Top orders')).toBeTruthy();
    // A withdrawn preview takes its surface away.
    const withdrawn = projector.project({
      type: 'CUSTOM',
      name: 'agora.ui',
      value: { id: 'c1:ui:0', component: 'genui:tree', props: {}, partial: true },
    });
    expect(withdrawn).toEqual([{ version: 'v0.9', deleteSurface: { surfaceId: 'c1:ui:0' } }]);
  });

  it('sends an app component through a mapping — or as a custom component of the app catalog', async () => {
    const orders = { orders: [{ id: '7', customer: 'Ada' }] };
    const mapped = toA2uiComponents(
      { component: 'OrderList', props: orders },
      {
        components: {
          OrderList: (props, ctx) => [
            { id: ctx.id, component: 'Column', children: [ctx.derive('b')] },
            {
              id: ctx.derive('b'),
              component: 'Button',
              child: ctx.derive('l'),
              action: { event: { name: 'refund', context: { orderId: '7' } } },
            },
            {
              id: ctx.derive('l'),
              component: 'Text',
              text: `Refund #${(props.orders as { id: string }[])[0]?.id}`,
            },
          ],
        },
      },
    );
    const messages = a2uiSurfaceMessages('s1', mapped, { create: true });
    assertValid(messages);
    const { surface, actions } = surfaceOf(messages);
    render(<A2uiSurface surface={surface as never} />);
    const button = await screen.findByRole('button', { name: 'Refund #7' });
    await act(async () => button.click());
    expect(actions).toHaveLength(1);
    const action = readA2uiAction(actions[0]);
    expect(action).toMatchObject({
      source: 'a2ui',
      name: 'refund',
      context: { orderId: '7' },
      surfaceId: 's1',
    });

    const custom = toA2uiComponents(
      { component: 'Sandbox', props: { html: '<b>x</b>' } },
      { components: { Sandbox: 'custom' } },
    );
    expect(custom).toEqual([{ id: 'root', component: 'Sandbox', html: '<b>x</b>' }]);
    const inline = a2uiCatalog(catalog, { catalogId: 'https://shop.test/a2ui', only: ['Sandbox'] });
    expect(Object.keys(inline.components)).toEqual(['Sandbox']);
    expect(inline.components.Sandbox?.properties).toHaveProperty('html');
  });

  it('draws what nothing maps as its text', () => {
    const [only] = toA2uiComponents(
      { component: 'Sandbox', props: { title: 'Calc', summary: 'A calculator.' } },
      { catalog },
    );
    expect(only).toMatchObject({ id: 'root', component: 'Text' });
    expect(String(only?.text)).toContain('A calculator.');
    // A mapping that breaks draws the text instead of breaking the stream.
    const event = a2uiActivityEvent(
      { id: 'u1', component: 'Text', props: { text: 'still here' } },
      {
        catalog,
        components: {
          Text: () => {
            throw new Error('boom');
          },
        },
      },
    ) as unknown as {
      content: { a2ui_operations: { updateComponents?: { components: unknown[] } }[] };
    };
    expect(event.content.a2ui_operations[1]?.updateComponents?.components).toEqual([
      { id: 'root', component: 'Text', text: 'still here' },
    ]);
  });
});

describe('A2UI over AG-UI', () => {
  it('adds an a2ui-surface activity after each agora.ui event when asked', () => {
    const frame = {
      kind: 'ui' as const,
      id: 'c1:ui:0',
      component: 'genui:tree',
      props: { root: dashboard },
    };
    const plain = new AgUiEncoder({ threadId: 't', runId: 'r', streamRunId: 'r' });
    expect(plain.encode(frame).some((event) => event.type === 'ACTIVITY_SNAPSHOT')).toBe(false);
    const encoder = new AgUiEncoder({
      threadId: 't',
      runId: 'r',
      streamRunId: 'r',
      a2ui: { catalog },
    });
    const events = encoder.encode(frame);
    const activity = events.find((event) => event.type === 'ACTIVITY_SNAPSHOT');
    expect(activity).toMatchObject({
      messageId: 'a2ui-surface-c1:ui:0',
      activityType: 'a2ui-surface',
      replace: true,
    });
    assertValid(
      (activity as unknown as { content: { a2ui_operations: unknown[] } }).content.a2ui_operations,
    );
    expect(
      a2uiActivityEvent({ id: 'x', component: 'genui:tree', props: {}, partial: true }),
    ).toBeNull();
  });

  it('reads an A2UI user action from forwardedProps', () => {
    const forwarded = readForwardedProps({
      a2uiAction: {
        userAction: {
          name: 'refund',
          surfaceId: 's1',
          sourceComponentId: 'b',
          context: { orderId: '7' },
        },
      },
    });
    expect(forwarded.uiAction).toMatchObject({ source: 'a2ui', name: 'refund', componentId: 'b' });
    expect(readForwardedProps({ uiAction: { name: 'go', context: 'nope' } }).uiAction).toMatch(
      /context/,
    );
  });
});

describe('the A2UI stream projection', () => {
  it('streams text into a data-bound surface, and an approval as buttons', async () => {
    const projector = new A2uiProjector();
    const messages = [
      ...projector.project({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }),
      ...projector.project({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hel' }),
      ...projector.project({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'lo' }),
      ...projector.project({
        type: 'RUN_FINISHED',
        threadId: 't',
        runId: 'r',
        outcome: {
          type: 'interrupt',
          interrupts: [{ id: 'agora_x', reason: 'tool_approval', message: 'Refund #7?' }],
        },
      } as never),
    ];
    assertValid(messages);
    const actions: unknown[] = [];
    const processor = new MessageProcessor(
      [basicCatalog],
      (action: unknown) => void actions.push(action),
    );
    processor.processMessages(messages as never);
    const text = processor.model.surfacesMap.get('text-m1');
    const approval = processor.model.surfacesMap.get('interrupt-agora_x');
    if (text === undefined || approval === undefined) throw new Error('missing surface');
    render(
      <>
        <A2uiSurface surface={text as never} />
        <A2uiSurface surface={approval as never} />
      </>,
    );
    expect(await screen.findByText('Hello')).toBeTruthy();
    expect(screen.getByText('Refund #7?')).toBeTruthy();
    await act(async () => screen.getByRole('button', { name: 'Approve' }).click());
    expect(readA2uiAction(actions[0])).toMatchObject({
      name: 'agora.approve',
      context: { interruptId: 'agora_x' },
    });
  });

  it('accepts the v0.9 client message, v0.8 userAction and the bare action', () => {
    const v09 = {
      version: 'v0.9',
      action: {
        name: 'go',
        surfaceId: 's',
        sourceComponentId: 'b',
        timestamp: '2026-01-01T00:00:00Z',
        context: { a: 1 },
      },
    };
    expect(readA2uiAction(v09)).toMatchObject({
      name: 'go',
      context: { a: 1 },
      timestamp: '2026-01-01T00:00:00Z',
    });
    expect(readA2uiAction({ userAction: { name: 'go', context: {} } })).toMatchObject({
      name: 'go',
    });
    expect(readA2uiAction({ name: 'go' })).toMatchObject({ name: 'go' });
    expect(readA2uiAction({ action: {} })).toMatch(/name/);
  });
});
