import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ChannelDeliveryError,
  type ChannelRequest,
  evolutionApi,
  telegram,
  whatsappCloud,
} from '../src/channels/index.js';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** A `fetch` that records each call and answers with the next status (200 when none is left). */
function fakeFetch(statuses: number[] = []) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    const status = statuses.shift() ?? 200;
    return new Response(JSON.stringify({ ok: status < 300 }), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function request(partial: Partial<ChannelRequest> & { headers?: Record<string, string> }) {
  const headers = Object.fromEntries(
    Object.entries(partial.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    method: 'POST',
    url: '/webhooks/x',
    params: {},
    body: null,
    rawBody: null,
    ...partial,
    header: (name: string) => headers[name.toLowerCase()],
  } as ChannelRequest;
}

describe('evolutionApi', () => {
  const upsert = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    event: 'messages.upsert',
    instance: 'main',
    data,
    ...extra,
  });
  const incoming = (message: Record<string, unknown>, key: Record<string, unknown> = {}) =>
    upsert({
      key: { remoteJid: '5511999990000@s.whatsapp.net', fromMe: false, id: 'MSG1', ...key },
      message,
    });

  it('verifies the webhook token from the query, a route param or a header', () => {
    const adapter = evolutionApi({
      url: 'https://evo',
      instance: 'main',
      apiKey: 'k',
      webhookToken: 's3cret',
    });
    expect(adapter.verify(request({ url: '/wh?token=s3cret' }))).toBe(true);
    expect(adapter.verify(request({ params: { token: 's3cret' } }))).toBe(true);
    expect(adapter.verify(request({ headers: { authorization: 'Bearer s3cret' } }))).toBe(true);
    expect(adapter.verify(request({ headers: { 'x-webhook-token': 's3cret' } }))).toBe(true);
    expect(adapter.verify(request({ url: '/wh?token=wrong' }))).toBe(false);
    expect(adapter.verify(request({}))).toBe(false);
    const open = evolutionApi({
      url: 'https://evo',
      instance: 'main',
      apiKey: 'k',
      webhookToken: false,
    });
    expect(open.verify(request({}))).toBe(true);
  });

  it('parses text, extended text and button / list replies', () => {
    const adapter = evolutionApi({
      url: 'https://evo',
      instance: 'main',
      apiKey: 'k',
      webhookToken: 's',
    });
    expect(adapter.parse(incoming({ conversation: ' hi ' }))).toEqual([
      {
        id: 'MSG1',
        from: '5511999990000',
        conversation: '5511999990000@s.whatsapp.net',
        text: 'hi',
        raw: expect.any(Object),
      },
    ]);
    expect(adapter.parse(incoming({ extendedTextMessage: { text: 'quoted' } }))).toMatchObject([
      { text: 'quoted' },
    ]);
    expect(
      adapter.parse(
        incoming({
          buttonsResponseMessage: {
            selectedButtonId: 'agora:approve:x',
            selectedDisplayText: 'Confirm',
          },
        }),
      ),
    ).toMatchObject([{ text: 'Confirm', buttonId: 'agora:approve:x' }]);
    expect(
      adapter.parse(
        incoming({
          listResponseMessage: { title: 'Two', singleSelectReply: { selectedRowId: 'r2' } },
        }),
      ),
    ).toMatchObject([{ text: 'Two', buttonId: 'r2' }]);
    expect(
      adapter.parse(
        incoming({
          interactiveResponseMessage: {
            nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: 'agora:reject:y' }) },
          },
        }),
      ),
    ).toMatchObject([{ text: 'agora:reject:y', buttonId: 'agora:reject:y' }]);
  });

  it('ignores its own messages, other events and instances, broadcasts, media and groups', () => {
    const adapter = evolutionApi({
      url: 'https://evo',
      instance: 'main',
      apiKey: 'k',
      webhookToken: 's',
    });
    expect(adapter.parse(incoming({ conversation: 'x' }, { fromMe: true }))).toEqual([]);
    expect(adapter.parse(incoming({ conversation: 'x' }, { fromMe: undefined }))).toEqual([]);
    expect(
      adapter.parse({ ...incoming({ conversation: 'x' }), event: 'messages.update' }),
    ).toBeNull();
    expect(adapter.parse({ ...incoming({ conversation: 'x' }), instance: 'other' })).toBeNull();
    expect(
      adapter.parse(incoming({ conversation: 'x' }, { remoteJid: 'status@broadcast' })),
    ).toEqual([]);
    expect(adapter.parse(incoming({ imageMessage: { caption: '' } }))).toEqual([]);
    const group = incoming(
      { conversation: 'hey bot' },
      { remoteJid: '1203630@g.us', participant: '5511888880000@s.whatsapp.net' },
    );
    expect(adapter.parse(group)).toEqual([]);
    const withGroups = evolutionApi({
      url: 'https://evo',
      instance: 'main',
      apiKey: 'k',
      webhookToken: 's',
      groups: true,
    });
    expect(withGroups.parse(group)).toMatchObject([
      { from: '5511888880000', conversation: '1203630@g.us' },
    ]);
    // MESSAGES_UPSERT spelling (webhook by events) is the same event
    expect(
      adapter.parse({ ...incoming({ conversation: 'x' }), event: 'MESSAGES_UPSERT' }),
    ).toMatchObject([{ text: 'x' }]);
  });

  it('reads the phone number of a @lid chat when Evolution sends it alongside', () => {
    const adapter = evolutionApi({
      url: 'https://evo',
      instance: 'main',
      apiKey: 'k',
      webhookToken: 's',
    });
    expect(
      adapter.parse(
        incoming(
          { conversation: 'x' },
          { remoteJid: '123456@lid', remoteJidAlt: '5511777770000@s.whatsapp.net' },
        ),
      ),
    ).toMatchObject([{ from: '5511777770000', conversation: '123456@lid' }]);
  });

  it('sends text with the apikey header', async () => {
    const { fetch, calls } = fakeFetch();
    const adapter = evolutionApi({
      url: 'https://evo/',
      instance: 'main',
      apiKey: 'k',
      webhookToken: 's',
      fetch,
    });
    await adapter.send('5511999990000@s.whatsapp.net', { text: 'hello' });
    expect(calls).toEqual([
      {
        url: 'https://evo/message/sendText/main',
        headers: expect.objectContaining({ apikey: 'k' }),
        body: { number: '5511999990000', text: 'hello' },
      },
    ]);
  });

  it('without buttons enabled, sends the text fallback of a buttons message', async () => {
    const { fetch, calls } = fakeFetch();
    const adapter = evolutionApi({
      url: 'https://evo',
      instance: 'main',
      apiKey: 'k',
      webhookToken: 's',
      fetch,
    });
    expect(adapter.capabilities.buttons).toBeUndefined();
    await adapter.send('123@lid', {
      text: '*Refund?*',
      buttons: [{ id: 'a', label: 'Confirm' }],
      fallbackText: '*Refund?*\n\nReply *yes*',
    });
    expect(calls[0]!.body).toEqual({ number: '123@lid', text: '*Refund?*\n\nReply *yes*' });
  });

  it('with buttons enabled, uses sendButtons — and falls back to text on a definite refusal only', async () => {
    const message = {
      text: '*Refund order A-1?*\nAmount: 10.00',
      buttons: [
        { id: 'agora:approve:x', label: 'Confirm' },
        { id: 'agora:reject:x', label: 'Cancel' },
      ],
      fallbackText: 'Refund order A-1?\n\nReply yes or no.',
    };
    const ok = fakeFetch();
    const options = {
      url: 'https://evo',
      instance: 'main',
      apiKey: 'k',
      webhookToken: 's',
      buttons: true,
    };
    await evolutionApi({ ...options, fetch: ok.fetch }).send(
      '5511999990000@s.whatsapp.net',
      message,
    );
    expect(ok.calls).toEqual([
      {
        url: 'https://evo/message/sendButtons/main',
        headers: expect.any(Object),
        body: {
          number: '5511999990000',
          title: 'Refund order A-1?',
          description: 'Amount: 10.00',
          buttons: [
            { type: 'reply', displayText: 'Confirm', id: 'agora:approve:x' },
            { type: 'reply', displayText: 'Cancel', id: 'agora:reject:x' },
          ],
        },
      },
    ]);

    const refused = fakeFetch([400]);
    await evolutionApi({ ...options, fetch: refused.fetch }).send(
      '5511999990000@s.whatsapp.net',
      message,
    );
    expect(refused.calls.map((call) => call.url)).toEqual([
      'https://evo/message/sendButtons/main',
      'https://evo/message/sendText/main',
    ]);
    expect(refused.calls[1]!.body.text).toBe(message.fallbackText);

    const down = fakeFetch([502]);
    await expect(
      evolutionApi({ ...options, fetch: down.fetch }).send('5511999990000@s.whatsapp.net', message),
    ).rejects.toBeInstanceOf(ChannelDeliveryError);
    expect(down.calls).toHaveLength(1);
  });
});

describe('whatsappCloud', () => {
  const options = {
    phoneNumberId: '1061',
    accessToken: 'EAAG',
    appSecret: 'app-secret',
    verifyToken: 'verify-me',
  };
  const envelope = (messages: unknown[], phoneNumberId = '1061') => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: phoneNumberId },
              messages,
            },
          },
        ],
      },
    ],
  });

  it('answers the subscription check with the challenge, and refuses a wrong token', () => {
    const adapter = whatsappCloud(options);
    expect(
      adapter.challenge!(
        request({
          method: 'GET',
          url: '/wh?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444',
        }),
      ),
    ).toEqual({ status: 200, body: '1158201444', contentType: 'text/plain' });
    expect(
      adapter.challenge!(
        request({
          method: 'GET',
          url: '/wh?hub.mode=subscribe&hub.verify_token=no&hub.challenge=1',
        }),
      )?.status,
    ).toBe(403);
    expect(adapter.challenge!(request({ method: 'POST' }))).toBeNull();
  });

  it('verifies X-Hub-Signature-256 over the raw body', () => {
    const adapter = whatsappCloud(options);
    const raw = JSON.stringify(envelope([]));
    const signature = `sha256=${createHmac('sha256', 'app-secret').update(raw).digest('hex')}`;
    expect(
      adapter.verify(request({ rawBody: raw, headers: { 'x-hub-signature-256': signature } })),
    ).toBe(true);
    expect(
      adapter.verify(
        request({ rawBody: `${raw} `, headers: { 'x-hub-signature-256': signature } }),
      ),
    ).toBe(false);
    expect(adapter.verify(request({ rawBody: raw }))).toBe(false);
    expect(adapter.verify(request({ headers: { 'x-hub-signature-256': signature } }))).toBe(false);
  });

  it('parses text and interactive replies for its own number only', () => {
    const adapter = whatsappCloud(options);
    expect(
      adapter.parse(
        envelope([
          { from: '5511999990000', id: 'wamid.1', type: 'text', text: { body: 'hello' } },
          {
            from: '5511999990000',
            id: 'wamid.2',
            type: 'interactive',
            interactive: {
              type: 'button_reply',
              button_reply: { id: 'agora:approve:x', title: 'Confirm' },
            },
          },
          { from: '5511999990000', id: 'wamid.3', type: 'image', image: { id: 'm' } },
        ]),
      ),
    ).toEqual([
      {
        id: 'wamid.1',
        from: '5511999990000',
        conversation: '5511999990000',
        text: 'hello',
        raw: expect.any(Object),
      },
      {
        id: 'wamid.2',
        from: '5511999990000',
        conversation: '5511999990000',
        text: 'Confirm',
        buttonId: 'agora:approve:x',
        raw: expect.any(Object),
      },
    ]);
    expect(
      adapter.parse(envelope([{ from: '1', id: 'w', type: 'text', text: { body: 'x' } }], '999')),
    ).toEqual([]);
    expect(adapter.parse({ object: 'page', entry: [] })).toBeNull();
  });

  it('sends text and interactive reply buttons', async () => {
    const { fetch, calls } = fakeFetch();
    const adapter = whatsappCloud({ ...options, fetch });
    await adapter.send('5511999990000', { text: 'hello' });
    await adapter.send('5511999990000', {
      text: '*Refund?*',
      buttons: [
        { id: 'agora:approve:x', label: 'Confirm' },
        { id: 'agora:reject:x', label: 'Cancel this refund please' },
      ],
      fallbackText: 'Refund? Reply yes or no.',
    });
    expect(calls[0]).toEqual({
      url: 'https://graph.facebook.com/v23.0/1061/messages',
      headers: expect.objectContaining({ authorization: 'Bearer EAAG' }),
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '5511999990000',
        type: 'text',
        text: { body: 'hello', preview_url: false },
      },
    });
    expect(calls[1]!.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5511999990000',
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: '*Refund?*' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'agora:approve:x', title: 'Confirm' } },
            { type: 'reply', reply: { id: 'agora:reject:x', title: 'Cancel this refund p' } },
          ],
        },
      },
    });
  });
});

describe('telegram', () => {
  const options = { botToken: '123:abc', secretToken: 'tg-secret' };

  it('checks X-Telegram-Bot-Api-Secret-Token', () => {
    const adapter = telegram(options);
    expect(
      adapter.verify(request({ headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' } })),
    ).toBe(true);
    expect(
      adapter.verify(request({ headers: { 'x-telegram-bot-api-secret-token': 'nope' } })),
    ).toBe(false);
    expect(adapter.verify(request({}))).toBe(false);
  });

  it('parses private text messages and button presses; ignores groups and bots', () => {
    const adapter = telegram(options);
    expect(
      adapter.parse({
        update_id: 77,
        message: {
          message_id: 5,
          chat: { id: 42, type: 'private' },
          from: { id: 42, is_bot: false },
          text: 'hi',
        },
      }),
    ).toEqual({ id: '77', from: '42', conversation: '42', text: 'hi', raw: expect.any(Object) });
    expect(
      adapter.parse({
        update_id: 78,
        callback_query: {
          id: 'cq1',
          from: { id: 42 },
          data: 'agora:approve:x',
          message: {
            message_id: 6,
            chat: { id: 42, type: 'private' },
            reply_markup: {
              inline_keyboard: [[{ text: 'Confirm', callback_data: 'agora:approve:x' }]],
            },
          },
        },
      }),
    ).toMatchObject({ id: '78', text: 'Confirm', buttonId: 'agora:approve:x', conversation: '42' });
    expect(
      adapter.parse({
        update_id: 79,
        message: { chat: { id: -5, type: 'group' }, from: { id: 42 }, text: 'hi' },
      }),
    ).toBeNull();
    expect(
      adapter.parse({
        update_id: 80,
        message: { chat: { id: 9, type: 'private' }, from: { id: 9, is_bot: true }, text: 'hi' },
      }),
    ).toBeNull();
    expect(adapter.parse({ update_id: 81, edited_message: {} })).toBeNull();
  });

  it('answers a button press and removes the keyboard', async () => {
    const { fetch, calls } = fakeFetch();
    const adapter = telegram({ ...options, fetch });
    const [message] = [
      adapter.parse({
        update_id: 78,
        callback_query: {
          id: 'cq1',
          from: { id: 42 },
          data: 'agora:approve:x',
          message: { message_id: 6, chat: { id: 42, type: 'private' } },
        },
      }),
    ].flat();
    await adapter.acknowledge!(message!);
    expect(calls).toEqual([
      {
        url: 'https://api.telegram.org/bot123:abc/answerCallbackQuery',
        headers: expect.any(Object),
        body: { callback_query_id: 'cq1' },
      },
      {
        url: 'https://api.telegram.org/bot123:abc/editMessageReplyMarkup',
        headers: expect.any(Object),
        body: { chat_id: '42', message_id: 6, reply_markup: { inline_keyboard: [] } },
      },
    ]);
  });

  it('sends MarkdownV2 with an inline keyboard, and plain text when the formatting is refused', async () => {
    const { fetch, calls } = fakeFetch([200, 400, 200]);
    const adapter = telegram({ ...options, fetch });
    await adapter.send('42', {
      text: '*Refund?*',
      buttons: [
        { id: 'agora:approve:x', label: 'Confirm' },
        { id: 'agora:reject:x', label: 'Cancel' },
      ],
      fallbackText: 'unused',
    });
    expect(calls[0]!.body).toEqual({
      chat_id: '42',
      text: '*Refund?*',
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Confirm', callback_data: 'agora:approve:x' },
            { text: 'Cancel', callback_data: 'agora:reject:x' },
          ],
        ],
      },
    });
    await adapter.send('42', { text: 'Total: 10\\.00' });
    expect(calls[1]!.body.parse_mode).toBe('MarkdownV2');
    expect(calls[2]!.body).toEqual({
      chat_id: '42',
      text: 'Total: 10.00',
      link_preview_options: { is_disabled: true },
    });
  });

  it('plain mode sends no parse_mode', async () => {
    const { fetch, calls } = fakeFetch();
    const adapter = telegram({ ...options, markdown: false, fetch });
    expect(adapter.capabilities.markdown).toBe('none');
    await adapter.send('42', { text: 'hi' });
    expect(calls[0]!.body).toEqual({
      chat_id: '42',
      text: 'hi',
      link_preview_options: { is_disabled: true },
    });
  });
});
