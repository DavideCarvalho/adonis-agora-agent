import { describe, expect, it, vi } from 'vitest';
import { channels as channelsRoute } from '../src/channels/index.js';
import { BUILTIN_COMPONENTS, Chart, LAYOUT_COMPONENTS } from '../src/genui/builtins.js';
import { defineCatalog, defineComponent } from '../src/genui/catalog.js';
import {
  canRenderOnChannel,
  channelButtonAction,
  channelCatalog,
  type GenuiChannels,
  renderChannelMessages,
  resolveGenuiChannel,
  turnChannel,
} from '../src/genui/channels.js';
import { chartImages, chartSvg } from '../src/genui/chart-image.js';
import { Sandbox } from '../src/genui/sandbox.js';
import { type GenuiTool, genuiTools } from '../src/genui/tools.js';
import { GENUI_TREE_COMPONENT } from '../src/genui/tree.js';
import type { StreamFrame } from '../src/spi/token-stream-sink.js';
import { actor, fakeAdapter, fakeService, inbound, makeCtx } from './helpers/channels.js';

/** A component with a WhatsApp conversion: its orders as reply buttons (or a list past three). */
const OrderList = defineComponent<{ orders: { id: string; total: number }[] }>(
  {
    name: 'OrderList',
    title: 'Orders',
    description: 'A list of orders.',
    props: {
      type: 'object',
      properties: {
        orders: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, total: { type: 'number' } },
            required: ['id', 'total'],
          },
        },
      },
      required: ['orders'],
    },
    fallbackText: (props) => props.orders.map((order) => `${order.id}: ${order.total}`).join('\n'),
  },
  {
    channels: {
      whatsapp: (props) => ({
        text: `You have ${props.orders.length} orders.`,
        buttons: props.orders.map((order) => ({
          label: `Refund ${order.id}`,
          action: 'refund',
          value: { orderId: order.id },
        })),
      }),
      telegram: (props) => ({
        text: 'Orders',
        list: {
          button: 'Pick one',
          items: props.orders.map((order) => ({ label: order.id, value: { orderId: order.id } })),
        },
      }),
    },
  },
);

/** No text summary and no conversion: nothing a text channel could show. */
const Map3d = defineComponent({
  name: 'Map3d',
  title: 'Map',
  description: 'A 3D map.',
  props: { type: 'object', properties: { lat: { type: 'number' } } },
});

const catalog = defineCatalog([
  ...BUILTIN_COMPONENTS,
  ...LAYOUT_COMPONENTS,
  OrderList,
  Map3d,
  Sandbox,
]);

const channels: GenuiChannels = {
  web: { mode: 'tree', streaming: 'partial' },
  whatsapp: { mode: 'per-component' },
  telegram: { mode: 'per-component' },
  email: { mode: 'text' },
};

async function offered(tools: GenuiTool[], channel: string | undefined) {
  const names: string[] = [];
  for (const tool of tools) {
    const described = await tool.handler.describe?.({
      actor: { id: 'u1', roles: [] },
      threadId: 't1',
      ...(channel !== undefined ? { channel } : {}),
    });
    if (described?.available !== false) names.push(tool.spec.name);
  }
  return names;
}

describe('turnChannel — the one rule for which channel a turn runs on', () => {
  it('reads an explicit string, a text channel address (kind, then name), else web', () => {
    expect(turnChannel({ channel: 'mobile' })).toBe('mobile');
    expect(turnChannel({ channel: { name: 'zap', conversation: 'c', kind: 'whatsapp' } })).toBe(
      'whatsapp',
    );
    expect(turnChannel({ channel: { name: 'telegram', conversation: 'c' } })).toBe('telegram');
    expect(turnChannel(undefined)).toBe('web');
    expect(turnChannel({ kind: 'page' })).toBe('web');
  });

  it('resolves a channel: its entry over default over the top level', () => {
    expect(resolveGenuiChannel({ mode: 'tree' }, undefined, 'whatsapp')).toMatchObject({
      configured: false,
      mode: 'tree',
    });
    expect(resolveGenuiChannel({ sandbox: true }, { whatsapp: {} }, 'whatsapp')).toMatchObject({
      configured: true,
      messaging: true,
      mode: 'per-component',
      render: 'native',
      sandbox: false,
    });
    expect(
      resolveGenuiChannel({ mode: 'tree' }, { default: { mode: 'text' } }, 'slack'),
    ).toMatchObject({ configured: true, mode: 'text' });
    expect(resolveGenuiChannel({}, { email: {} }, 'email').render).toBe('html');
  });
});

describe('channel tool filtering', () => {
  const tools = genuiTools(catalog, { channels, sandbox: true });

  it('registers the tools of every mode in use', () => {
    const names = tools.map((tool) => tool.spec.name);
    expect(names).toContain('ui__render');
    expect(names).toContain('ui__show_order_list');
    expect(names).toContain('ui__show_sandbox');
  });

  it('web: only ui__render, whose catalog carries the sandbox', async () => {
    expect(await offered(tools, 'web')).toEqual(['ui__render']);
    const render = tools.find((tool) => tool.spec.name === 'ui__render');
    const described = await render?.handler.describe?.({ actor, channel: 'web' });
    expect(described?.description).toContain('- Sandbox');
    expect(described?.description).toContain('- OrderList');
  });

  it('whatsapp: only per-component tools of components that can be drawn there', async () => {
    const names = await offered(tools, 'whatsapp');
    expect(names).toContain('ui__show_order_list');
    expect(names).toContain('ui__show_data_table');
    expect(names).not.toContain('ui__render');
    // No text summary, no conversion → nothing to send; and a sandbox cannot run on WhatsApp.
    expect(names).not.toContain('ui__show_map3d');
    expect(names).not.toContain('ui__show_sandbox');
    const order = tools.find((tool) => tool.spec.name === 'ui__show_order_list');
    const described = await order?.handler.describe?.({ actor, channel: 'whatsapp' });
    expect(described?.description).toContain('This conversation is on WhatsApp');
  });

  it('componentTools: the flat ui__sandbox is offered where the tree is, not on per-component channels', async () => {
    const withOwn = genuiTools(catalog, { channels, sandbox: true, componentTools: ['Sandbox'] });
    expect(await offered(withOwn, 'web')).toEqual(['ui__render', 'ui__sandbox']);
    expect(await offered(withOwn, 'whatsapp')).not.toContain('ui__sandbox');
    expect(await offered(withOwn, 'email')).toEqual([]);
  });

  it('a text-mode channel gets no UI tools', async () => {
    expect(await offered(tools, 'email')).toEqual([]);
  });

  it('a channel without an entry (and no default) keeps the top-level mode', async () => {
    expect(await offered(tools, 'slack')).toEqual(['ui__render']);
  });

  it('without channels, nothing changes', async () => {
    const plain = genuiTools(catalog, {});
    expect(plain.map((tool) => tool.spec.name)).toEqual(['ui__render']);
    expect(await offered(plain, 'whatsapp')).toEqual(['ui__render']);
  });

  it('a web channel may turn its sandbox off or give it its own options', () => {
    const off = channelCatalog(
      catalog,
      resolveGenuiChannel({}, { web: { sandbox: false } }, 'web'),
    );
    expect(off.has('Sandbox')).toBe(false);
    const own = channelCatalog(
      catalog,
      resolveGenuiChannel({}, { web: { sandbox: { instructions: 'Use brand colors.' } } }, 'web'),
    );
    expect(own.get('Sandbox')?.description).toContain('Use brand colors.');
  });

  it('a component may opt out of a channel', () => {
    const quiet = defineComponent(
      { ...OrderList, name: 'Quiet' },
      { channels: { whatsapp: false } },
    );
    const whatsapp = resolveGenuiChannel({}, { whatsapp: {} }, 'whatsapp');
    expect(canRenderOnChannel(quiet as never, whatsapp)).toBe(false);
    expect(canRenderOnChannel(OrderList as never, whatsapp)).toBe(true);
  });
});

describe('WhatsApp / Telegram conversion', () => {
  const whatsapp = resolveGenuiChannel({}, { whatsapp: {} }, 'whatsapp');
  const orders = {
    orders: [
      { id: 'A1', total: 10 },
      { id: 'B2', total: 20 },
    ],
  };

  it('uses the component conversion for its channel', async () => {
    const out = await renderChannelMessages(
      catalog,
      { id: 'ui-1', name: 'OrderList', props: orders },
      whatsapp,
    );
    expect(out).toEqual([
      {
        text: 'You have 2 orders.',
        buttons: [
          { label: 'Refund A1', action: 'refund', value: { orderId: 'A1' } },
          { label: 'Refund B2', action: 'refund', value: { orderId: 'B2' } },
        ],
        component: 'OrderList',
        componentId: 'ui-1',
      },
    ]);
  });

  it('falls back to the text summary without a conversion, and flattens a tree', async () => {
    const out = await renderChannelMessages(
      catalog,
      {
        id: 'ui-2',
        name: GENUI_TREE_COMPONENT,
        props: {
          root: {
            type: 'Stack',
            props: {},
            children: [
              { type: 'Heading', props: { text: 'Your orders' } },
              { type: 'OrderList', props: orders },
            ],
          },
        },
      },
      whatsapp,
    );
    expect(out.map((message) => message.text)).toEqual(['*Your orders*', 'You have 2 orders.']);
    expect(out[1]?.buttons).toHaveLength(2);
  });

  it('render: text always sends the summary', async () => {
    const out = await renderChannelMessages(
      catalog,
      { name: 'OrderList', props: orders },
      resolveGenuiChannel({}, { whatsapp: { render: 'text' } }, 'whatsapp'),
    );
    expect(out).toEqual([{ text: 'A1: 10\nB2: 20', component: 'OrderList' }]);
  });

  it('render: html gives an email its markup', async () => {
    const out = await renderChannelMessages(
      catalog,
      { name: 'OrderList', props: orders },
      resolveGenuiChannel({}, { email: { mode: 'per-component' } }, 'email'),
    );
    expect(out[0]?.html).toBe('<p>A1: 10<br>B2: 20</p>');
  });

  it('a pressed button is a UI action, like a sandbox send', () => {
    const action = channelButtonAction(
      { label: 'Refund A1', action: 'refund', value: { orderId: 'A1' } },
      { componentId: 'ui-1', title: 'Orders' },
    );
    expect(action).toMatchObject({
      source: 'component',
      name: 'refund',
      text: 'Refund A1',
      context: { orderId: 'A1' },
      componentId: 'ui-1',
    });
  });

  it('draws charts as PNG images on an image-capable channel', async () => {
    const props = {
      type: 'bar',
      title: 'Revenue',
      xKey: 'month',
      series: [{ key: 'total' }],
      data: [
        { month: 'Jan', total: 10 },
        { month: 'Feb', total: 25 },
      ],
    };
    expect(chartSvg(props as never)).toContain('<rect');
    const out = await renderChannelMessages(
      defineCatalog([Chart]),
      { name: 'Chart', props },
      resolveGenuiChannel({}, { whatsapp: { chartImages: chartImages() } }, 'whatsapp'),
    );
    expect(out[0]?.text).toBe('*Revenue*');
    const png = out[0]?.image?.data as Uint8Array;
    expect(Buffer.from(png.slice(1, 4)).toString('ascii')).toBe('PNG');
    expect(out[0]?.image?.contentType).toBe('image/png');
  });
});

describe('a genui channel end to end (handler)', () => {
  const ordersFrame = (count: number): StreamFrame => ({
    t: 'component',
    id: 'call-1:ui:0',
    name: 'OrderList',
    data: {
      orders: Array.from({ length: count }, (_, index) => ({ id: `O${index}`, total: index })),
    },
    fallbackText: 'orders as text',
  });

  function whatsappHandler(frames: StreamFrame[], capabilities = { buttons: 3, lists: 10 }) {
    const { adapter, outbox } = fakeAdapter({ media: true, ...capabilities });
    const kinded = { ...adapter, kind: 'whatsapp' };
    const service = fakeService(frames);
    const handle = channelsRoute.handle(kinded, {
      service,
      actor: () => actor,
      thread: () => 't',
      genui: { catalog, channels },
    });
    return { handle, outbox, service };
  }

  it('turns on a whatsapp channel carry its kind and no empty capabilities', async () => {
    const { handle, service } = whatsappHandler([{ t: 'text', v: 'Hi' }]);
    await handle(makeCtx(inbound('hello')).ctx);
    await handle.drain();
    expect(service.sends[0].pageContext.channel).toEqual({
      name: 'test',
      conversation: 'chat-1',
      kind: 'whatsapp',
    });
    expect(service.sends[0].uiCapabilities).toBeUndefined();
  });

  it('sends a component as reply buttons, in the order of the text, and a press is the next turn', async () => {
    const { handle, outbox, service } = whatsappHandler([
      { t: 'text', v: 'Here they are.' },
      ordersFrame(2),
      { t: 'text', v: 'Anything else?' },
    ]);
    await handle(makeCtx(inbound('my orders')).ctx);
    await handle.drain();
    expect(outbox.map((item) => item.message.text)).toEqual([
      'Here they are.',
      'You have 2 orders.',
      'Anything else?',
    ]);
    const buttons = outbox[1]?.message.buttons ?? [];
    expect(buttons.map((button) => button.label)).toEqual(['Refund O0', 'Refund O1']);
    expect(buttons[0]?.id).toMatch(/^ui:[A-Za-z0-9_-]{16}$/);
    expect(outbox[1]?.message.fallbackText).toContain('1. Refund O0');

    await handle(makeCtx(inbound('Refund O1', { buttonId: buttons[1]?.id as string })).ctx);
    await handle.drain();
    expect(service.sends).toHaveLength(2);
    const turn = service.sends[1].message as string;
    expect(turn).toContain('Refund O1');
    expect(turn).toContain('[UI action "refund" from UI');
    expect(turn).toContain('"orderId": "O1"');
  });

  it('more choices than buttons become a list message', async () => {
    const { handle, outbox } = whatsappHandler([ordersFrame(5)]);
    await handle(makeCtx(inbound('my orders')).ctx);
    await handle.drain();
    const list = outbox[0]?.message.list;
    expect(list?.rows.map((row) => row.title)).toEqual([
      'Refund O0',
      'Refund O1',
      'Refund O2',
      'Refund O3',
      'Refund O4',
    ]);
    expect(list?.rows[0]?.id).toMatch(/^ui:/);
  });

  it('a channel with neither buttons nor lists gets numbered text', async () => {
    const { handle, outbox } = whatsappHandler([ordersFrame(5)], { buttons: 0, lists: 0 });
    await handle(makeCtx(inbound('my orders')).ctx);
    await handle.drain();
    expect(outbox[0]?.message.text).toContain('5. Refund O4');
    expect(outbox[0]?.message.buttons).toBeUndefined();
  });

  it('a label-only press (Whatsmiau) finds the button by its label', async () => {
    const { handle, service } = whatsappHandler([ordersFrame(2)]);
    await handle(makeCtx(inbound('my orders')).ctx);
    await handle.drain();
    await handle(makeCtx(inbound('Refund O0', { buttonWithoutId: true })).ctx);
    await handle.drain();
    expect(service.sends[1].message).toContain('"orderId": "O0"');
  });

  it('without channels configured, a text channel works exactly as before', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([ordersFrame(2)]);
    const handle = channelsRoute.handle(adapter, {
      service,
      actor: () => actor,
      thread: () => 't',
      genui: { catalog },
    });
    await handle(makeCtx(inbound('my orders')).ctx);
    await handle.drain();
    expect(service.sends[0].uiCapabilities).toEqual({ components: [] });
    expect(outbox.map((item) => item.message)).toEqual([{ text: 'orders as text' }]);
  });

  it('a failing conversion falls back to the summary', async () => {
    const broken = defineComponent(
      { ...OrderList, name: 'Broken' },
      {
        channels: {
          whatsapp: () => {
            throw new Error('nope');
          },
        },
      },
    );
    const out = await renderChannelMessages(
      defineCatalog([broken]),
      { name: 'Broken', props: { orders: [{ id: 'X', total: 1 }] } },
      resolveGenuiChannel({}, { whatsapp: {} }, 'whatsapp'),
    );
    expect(out[0]?.text).toBe('X: 1');
    vi.restoreAllMocks();
  });
});
