import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BUILTIN_COMPONENTS, LAYOUT_COMPONENTS } from '../src/genui/builtins.js';
import { defineCatalog, defineComponent } from '../src/genui/catalog.js';
import {
  type ChannelRenderedMessage,
  channelPrompt,
  describeChannelComponents,
  describeChannelDelivery,
  type GenuiChannels,
  resolveGenuiChannel,
} from '../src/genui/channels.js';
import { Sandbox } from '../src/genui/sandbox.js';
import {
  type Actor,
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  DefaultToolAuthorizer,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  type ModelTurnArgs,
  ToolRegistry,
} from '../src/index.js';
import { createToolUiChannelGuide, withDelivered } from '../src/negotiated-tool-ui.js';
import { FakeModelProvider, InMemoryAgentStore } from '../src/testing/index.js';

/*
 * On a channel the server draws for, the model is told how each component reaches the user THERE
 * (the prompt), and each tool result that pushed UI says what was actually delivered — so it does
 * not describe the web view ("the table above, with a Refund button per row") on WhatsApp.
 */

type Orders = { orders: { id: string; customer: string }[] };

/** Described for the web as a table with Refund buttons; on WhatsApp, a pick-list. */
const OrderList = defineComponent<Orders>(
  {
    name: 'OrderList',
    title: 'Order list',
    description: 'The orders as a table, each row with a Refund button.',
    internal: true,
    props: {
      type: 'object',
      properties: {
        orders: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, customer: { type: 'string' } },
            required: ['id', 'customer'],
          },
        },
      },
      required: ['orders'],
    },
    fallbackText: (props) =>
      props.orders.map((order) => `#${order.id} ${order.customer}`).join('\n'),
  },
  {
    channels: {
      whatsapp: {
        describe:
          'a message listing the orders, with a pick-list of them (no Refund buttons: to refund, the user picks an order and replies).',
        convert: (props) => ({
          text: '*Your orders*',
          list: {
            button: 'Order details',
            items: props.orders.map((order) => ({
              label: `Order #${order.id}`,
              action: 'details',
              value: { orderId: order.id },
            })),
          },
        }),
      },
      telegram: (props) => ({
        text: 'Your orders',
        buttons: props.orders.map((order) => ({ label: `#${order.id}` })),
      }),
    },
  },
);

const catalog = defineCatalog([...BUILTIN_COMPONENTS, ...LAYOUT_COMPONENTS, OrderList, Sandbox]);

const chartImages = { components: ['Chart'], render: async () => ({ url: 'https://x/c.png' }) };

const channels: GenuiChannels = {
  web: { mode: 'tree' },
  whatsapp: { mode: 'per-component', render: 'native', chartImages },
  telegram: { mode: 'per-component' },
  email: { mode: 'per-component', render: 'html' },
};

const channel = (name: string) => resolveGenuiChannel({}, channels, name);

const orders: Orders = {
  orders: [
    { id: '1001', customer: 'Ada' },
    { id: '1002', customer: 'Alan' },
  ],
};

describe('channelPrompt — how each component reaches the user on the channel', () => {
  it('WhatsApp: no web view, each component as WhatsApp shows it', () => {
    const prompt = channelPrompt(catalog, channel('whatsapp')) ?? '';
    expect(prompt).toContain('## Channel: WhatsApp');
    expect(prompt).toContain('not on a web page');
    expect(prompt).toMatch(/no tables/);
    // The conversion's own words, for the component a tool pushes (internal ones included).
    expect(prompt).toContain(
      '- Order list (OrderList): a message listing the orders, with a pick-list of them (no Refund buttons',
    );
    // A chart drawn as an image; the rest as text; layouts as their contents; never the sandbox.
    expect(prompt).toMatch(/- Chart: a picture of the chart/);
    expect(prompt).toMatch(
      /- As plain text \(its summary\), with no table, no buttons[^\n]*Data table/,
    );
    expect(prompt).toMatch(/- Layouts, sent as their contents[^\n]*Stack/);
    expect(prompt).not.toContain('Sandbox');
    expect(prompt).toContain('`delivered`');
  });

  it('a bare conversion is described from what it can send', () => {
    const prompt = channelPrompt(catalog, channel('telegram')) ?? '';
    expect(prompt).toContain('## Channel: Telegram');
    expect(prompt).toMatch(/- Order list \(OrderList\): a Telegram message of its own/);
    // No chart renderer on Telegram: the chart is text there.
    expect(prompt).toMatch(/- As plain text[^\n]*Chart/);
  });

  it('email: formatted text, nothing interactive', () => {
    const prompt = channelPrompt(catalog, channel('email')) ?? '';
    expect(prompt).toContain('nothing in it is interactive');
  });

  it('render: text puts every component in text', () => {
    const prompt =
      channelPrompt(
        catalog,
        resolveGenuiChannel({}, { whatsapp: { render: 'text' } }, 'whatsapp'),
      ) ?? '';
    expect(prompt).not.toContain('pick-list of them');
    expect(prompt).toMatch(/- As plain text[^\n]*Order list \(OrderList\)/);
  });

  it('says nothing on the web, a client channel, or without channels', () => {
    expect(channelPrompt(catalog, channel('web'))).toBeUndefined();
    expect(channelPrompt(catalog, resolveGenuiChannel({}, channels, 'mobile'))).toBeUndefined();
    expect(channelPrompt(catalog, resolveGenuiChannel({}, undefined, 'whatsapp'))).toBeUndefined();
  });
});

describe('describeChannelDelivery — what the user actually received', () => {
  const at = (message: Omit<ChannelRenderedMessage, 'component'>): ChannelRenderedMessage => ({
    component: 'OrderList',
    ...message,
  });

  it('a list: its entries, and that there was no table or other buttons', async () => {
    const text = await describeChannelComponents(
      catalog,
      [{ id: 'ui1', name: 'OrderList', props: orders }],
      channel('whatsapp'),
    );
    expect(text).toContain('Shown on WhatsApp as a message "*Your orders*" with a pick-list');
    expect(text).toContain(
      '(opened with "Order details") of 2 entries: "Order #1001", "Order #1002"',
    );
    expect(text).toContain('no table, no web view, and no buttons other than the ones listed');
    expect(text).not.toMatch(/Refund/);
  });

  it('more reply buttons than WhatsApp shows are described as the list they become', () => {
    const buttons = ['a', 'b', 'c', 'd'].map((label) => ({ label }));
    expect(describeChannelDelivery([at({ buttons })], channel('whatsapp'))).toContain('pick-list');
    expect(describeChannelDelivery([at({ buttons })], channel('telegram'))).toContain(
      '4 reply buttons',
    );
  });

  it("follows the adapter's limits, the way the channel handler sends the choices", () => {
    const items = Array.from({ length: 12 }, (_, index) => ({ label: `Order #${index + 1}` }));
    const list = { button: 'Pick', items };
    // A list past the adapter's rows: only the rows that fit are sent.
    expect(describeChannelDelivery([at({ text: 'Orders', list })], channel('whatsapp'))).toContain(
      'of 10 entries (only the first 10 of 12)',
    );
    // Telegram shows up to 8 buttons; more become its list.
    const nine = items.slice(0, 9);
    expect(describeChannelDelivery([at({ buttons: nine })], channel('telegram'))).toContain(
      'pick-list (opened with "Options") of 9 entries',
    );
    // An adapter with neither buttons nor lists: numbered text the user answers by replying.
    const plain = describeChannelDelivery([at({ text: 'Orders', list })], channel('whatsapp'), {
      buttons: 0,
      lists: 0,
    });
    expect(plain).toContain('with 12 numbered choices as text');
    expect(plain).toContain('they answer by replying with a message');
    expect(plain).not.toContain('pick-list');
  });

  it('text only: nothing to click, the user can only reply', async () => {
    const text = await describeChannelComponents(
      catalog,
      [
        {
          id: 'ui1',
          name: 'DataTable',
          props: { columns: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }] },
        },
      ],
      channel('whatsapp'),
    );
    expect(text).toMatch(/^Shown on WhatsApp as a text message/);
    expect(text).toContain('no table, no web view, no buttons and nothing to click');
  });

  it('an image, several messages in order', () => {
    const text = describeChannelDelivery(
      [at({ image: { url: 'https://x/c.png' }, text: '*Revenue*' }), at({ text: 'Up 10%.' })],
      channel('whatsapp'),
    );
    expect(text).toBe(
      'Shown on WhatsApp as 1) an image captioned "*Revenue*"; 2) a text message "Up 10%.". That is all the user got: no table, no web view, no buttons and nothing to click — they can only reply with a message.',
    );
  });

  it('a preview frame is not a delivery; a web channel has none', async () => {
    expect(
      await describeChannelComponents(
        catalog,
        [{ id: 'p', name: 'OrderList', props: orders, partial: true }],
        channel('whatsapp'),
      ),
    ).toBe('Nothing was shown on WhatsApp for this.');
    expect(
      await describeChannelComponents(
        catalog,
        [{ id: 'ui1', name: 'OrderList', props: orders }],
        channel('web'),
      ),
    ).toBeUndefined();
  });

  it('rides the tool output as `delivered`', () => {
    expect(withDelivered({ orders: [] }, 'x')).toEqual({ orders: [], delivered: 'x' });
    expect(withDelivered([1], 'x')).toEqual({ result: [1], delivered: 'x' });
    expect(withDelivered({ delivered: true }, 'x')).toEqual({
      result: { delivered: true },
      delivered: 'x',
    });
  });
});

describe('a turn per channel (scripted model)', () => {
  const actor: Actor = { id: 'u1', roles: ['ADMIN'] };

  function build() {
    const store = new InMemoryAgentStore();
    const registry = new ToolRegistry();
    const seen: ModelTurnArgs[] = [];
    const factory = new AgentDepsFactory({
      model: new FakeModelProvider((args, turn) => {
        seen.push(args);
        return turn === 0
          ? { text: '', toolCall: { name: 'list_orders', input: {} } }
          : { text: 'Here are your orders.' };
      }),
      store,
      sink: new InProcessTokenStreamSink(),
      rolesPolicy: new DefaultToolAuthorizer(),
      registry,
      agents: new AgentRegistry(),
      resolveUiCatalog: () => catalog,
      uiChannelGuide: createToolUiChannelGuide({ channels, resolveCatalog: () => catalog }),
    });
    registry.register(
      {
        name: 'list_orders',
        kind: 'read',
        description: 'List the orders. Also shows them as a table with a Refund button per row.',
        inputSchema: z.object({}),
        roles: ['ADMIN'],
      },
      {
        async execute(_input, ctx) {
          await ctx.emitUi('OrderList', orders);
          return { orders: orders.orders };
        },
      },
    );
    const service = new AgentService(new InlineAgentRunner(factory, store), store, factory);
    return { service, seen };
  }

  async function turn(channelName?: string) {
    const g = build();
    const { runId } = await g.service.chat({
      actor,
      message: 'Show my recent orders',
      ...(channelName !== undefined ? { channel: channelName } : {}),
    });
    for await (const _frame of g.service.subscribe(runId)) {
      /* drain */
    }
    const result = g.seen[1]?.messages.flatMap((message) => message.toolResults ?? [])[0];
    return { system: g.seen[0]?.system ?? '', output: result?.output as Record<string, unknown> };
  }

  it('WhatsApp: the prompt says how OrderList appears, the tool result what was delivered', async () => {
    const { system, output } = await turn('whatsapp');
    expect(system).toContain('## Channel: WhatsApp');
    expect(system).toContain(
      'Order list (OrderList): a message listing the orders, with a pick-list',
    );
    expect(output.orders).toEqual(orders.orders);
    expect(output.delivered).toContain(
      'with a pick-list (opened with "Order details") of 2 entries',
    );
    expect(output.delivered).toContain('no table');
  });

  it('Telegram: its own words, its own delivery', async () => {
    const { system, output } = await turn('telegram');
    expect(system).toContain('## Channel: Telegram');
    expect(output.delivered).toContain(
      'Shown on Telegram as a message "Your orders" with 2 reply buttons',
    );
  });

  it('web: nothing added — the page draws the table', async () => {
    const { system, output } = await turn();
    expect(system).not.toContain('## Channel');
    expect(output).toEqual({ orders: orders.orders });
  });
});
