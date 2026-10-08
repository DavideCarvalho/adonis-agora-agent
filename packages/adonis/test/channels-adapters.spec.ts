import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ChannelDeliveryError,
  ChannelMediaTooLargeError,
  type ChannelRequest,
  evolutionApi,
  type InboundMessage,
  telegram,
  whatsappCloud,
  whatsmiau,
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

  it('ignores its own messages, other events and instances, broadcasts and groups', () => {
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
    expect(adapter.parse(incoming({ reactionMessage: { text: '👍' } }))).toEqual([]);
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
    ).toMatchObject([{ from: '5511777770000', conversation: '5511777770000@s.whatsapp.net' }]);
    // Without the phone, the @lid jid is all there is.
    expect(
      adapter.parse(incoming({ conversation: 'x' }, { remoteJid: '123456@lid' })),
    ).toMatchObject([{ from: '123456@lid', conversation: '123456@lid' }]);
  });

  it('LID addressing (Evolution 2.3.7): from and the reply number are the phone', async () => {
    const { fetch, calls } = fakeFetch();
    const adapter = evolutionApi({
      url: 'https://evo',
      instance: 'main',
      apiKey: 'k',
      webhookToken: 's',
      fetch,
    });
    // The payload shape Evolution 2.3.7 posts for a chat WhatsApp addresses by LID.
    const body = {
      event: 'messages.upsert',
      instance: 'main',
      data: {
        key: {
          remoteJid: '187654321098765@lid',
          remoteJidAlt: '5511912345678@s.whatsapp.net',
          fromMe: false,
          id: '3EB0C4F1A2B3C4D5E6F7',
          participant: '',
          addressingMode: 'lid',
        },
        pushName: 'Maria',
        status: 'DELIVERY_ACK',
        message: { conversation: 'oi' },
        messageType: 'conversation',
        messageTimestamp: 1760000000,
        instanceId: 'b1c2d3',
        source: 'android',
      },
      destination: 'https://app.example.com/webhooks/whatsapp',
      date_time: '2026-10-07T10:00:00.000Z',
      sender: '5511900000000@s.whatsapp.net',
      server_url: 'https://evo',
      apikey: 'k',
    };
    const [message] = adapter.parse(body) as InboundMessage[];
    expect(message).toMatchObject({
      id: '3EB0C4F1A2B3C4D5E6F7',
      from: '5511912345678',
      conversation: '5511912345678@s.whatsapp.net',
      text: 'oi',
    });
    // The same chat addressed by phone is the same conversation.
    const byPhone = adapter.parse({
      ...body,
      data: {
        ...body.data,
        key: { remoteJid: '5511912345678@s.whatsapp.net', fromMe: false, id: 'X2' },
      },
    }) as InboundMessage[];
    expect(byPhone[0]!.conversation).toBe(message!.conversation);
    await adapter.send(message!.conversation, { text: 'olá' });
    expect(calls[0]!.body).toEqual({ number: '5511912345678', text: 'olá' });
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
      instruction: 'Reply *yes* or *no*.',
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
          // The text instruction rides along, for a phone that shows no buttons.
          description: 'Amount: 10.00\n\nReply *yes* or *no*.',
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

  it('evolutionApi: buttons off by default', () => {
    const options = { url: 'https://evo', instance: 'main', apiKey: 'k', webhookToken: 's' };
    expect(evolutionApi(options).capabilities.buttons).toBeUndefined();
    expect(evolutionApi({ ...options, buttons: true }).capabilities.buttons).toBe(3);
  });
});

describe('whatsmiau', () => {
  const options = { instance: 'main', apiKey: 'k', webhookToken: 's' };

  it('adds the /v1 prefix to a bare host, keeps a versioned url', async () => {
    for (const [url, expected] of [
      ['http://whatsmiau:8080', 'http://whatsmiau:8080/v1/message/sendText/main'],
      ['http://whatsmiau:8080/', 'http://whatsmiau:8080/v1/message/sendText/main'],
      ['http://whatsmiau:8080/v1', 'http://whatsmiau:8080/v1/message/sendText/main'],
      ['https://api.whatsmiau.dev/v2/', 'https://api.whatsmiau.dev/v2/message/sendText/main'],
    ] as const) {
      const { fetch, calls } = fakeFetch();
      await whatsmiau({ ...options, url, fetch }).send('5511999990000@s.whatsapp.net', {
        text: 'hi',
      });
      expect(calls[0]!.url).toBe(expected);
      expect(calls[0]!.body).toEqual({ number: '5511999990000', text: 'hi' });
    }
  });

  it('is named whatsapp, has buttons by default, and sends them without the text instruction', async () => {
    const adapter = whatsmiau({ ...options, url: 'http://whatsmiau:8080' });
    expect(adapter.name).toBe('whatsapp');
    expect(adapter.capabilities.buttons).toBe(3);
    expect(
      whatsmiau({ ...options, url: 'http://whatsmiau:8080', buttons: false }).capabilities.buttons,
    ).toBeUndefined();
    const { fetch, calls } = fakeFetch();
    await whatsmiau({ ...options, url: 'http://whatsmiau:8080', fetch }).send('5511999990000', {
      text: '*Refund order A-1?*',
      buttons: [
        { id: 'agora:approve:x', label: 'Confirmar' },
        { id: 'agora:reject:x', label: 'Cancelar' },
      ],
      fallbackText: '*Refund order A-1?*\n\nResponda *sim* ou *não*.',
      instruction: 'Responda *sim* ou *não*.',
    });
    expect(calls[0]!.url).toBe('http://whatsmiau:8080/v1/message/sendButtons/main');
    // The buttons render on Whatsmiau: the card is the summary and the buttons, no instruction line.
    expect(calls[0]!.body).toMatchObject({
      title: 'Refund order A-1?',
      description: 'Refund order A-1?',
    });
    expect(JSON.stringify(calls[0]!.body)).not.toContain('Responda');
  });

  it('keeps the full instruction in the text fallback when the buttons are refused or off', async () => {
    const proposal = {
      text: '*Refund order A-1?*\nAmount: R$ 10',
      buttons: [
        { id: 'agora:approve:x', label: 'Confirmar' },
        { id: 'agora:reject:x', label: 'Cancelar' },
      ],
      fallbackText: '*Refund order A-1?*\nAmount: R$ 10\n\nResponda *sim* ou *não*.',
      instruction: 'Responda *sim* ou *não*.',
    };
    const refused = fakeFetch([400]);
    await whatsmiau({ ...options, url: 'http://whatsmiau:8080', fetch: refused.fetch }).send(
      '5511999990000',
      proposal,
    );
    expect(refused.calls[0]!.body).toMatchObject({
      title: 'Refund order A-1?',
      description: 'Amount: R$ 10',
    });
    expect(refused.calls[1]!.url).toBe('http://whatsmiau:8080/v1/message/sendText/main');
    expect(refused.calls[1]!.body).toEqual({
      number: '5511999990000',
      text: proposal.fallbackText,
    });
    const off = fakeFetch();
    await whatsmiau({
      ...options,
      url: 'http://whatsmiau:8080',
      buttons: false,
      fetch: off.fetch,
    }).send('5511999990000', proposal);
    expect(off.calls.map((call) => call.body)).toEqual([
      { number: '5511999990000', text: proposal.fallbackText },
    ]);
  });

  it('parses the same Evolution-format webhook', () => {
    const adapter = whatsmiau({ ...options, url: 'http://whatsmiau:8080' });
    expect(
      adapter.parse({
        event: 'messages.upsert',
        instance: 'main',
        data: {
          key: {
            remoteJid: '187654321098765@lid',
            remoteJidAlt: '5511912345678@s.whatsapp.net',
            fromMe: false,
            id: 'W1',
          },
          message: { conversation: 'oi' },
        },
      }),
    ).toMatchObject([{ from: '5511912345678', conversation: '5511912345678@s.whatsapp.net' }]);
  });

  // A real Whatsmiau v1.5.0 (whatsmeow) incoming message: Go's `omitempty` drops `fromMe: false`, the
  // chat is addressed by phone with the LID alongside in `remoteLid`.
  const whatsmiauIncoming = (data: Record<string, unknown> = {}) => ({
    event: 'messages.upsert',
    instance: 'agora-test',
    data: {
      key: {
        remoteJid: '5513981450000@s.whatsapp.net',
        remoteLid: '239611947270000@lid',
        id: '3EB0B66E111010A5A90000',
        participant: '5513981450000@s.whatsapp.net',
        addressingMode: 'lid',
      },
      pushName: 'Davi de Carvalho',
      status: 'received',
      message: { conversation: 'Oi vó' },
      contextInfo: {},
      messageType: 'conversation',
      messageTimestamp: 1791420602,
      instanceId: 'instance-id',
      source: 'whatsapp',
      ...data,
    },
  });

  it('reads an incoming message without fromMe (status received), addressed by phone', () => {
    const adapter = whatsmiau({ ...options, instance: 'agora-test', url: 'http://whatsmiau:8080' });
    expect(adapter.parse(whatsmiauIncoming())).toMatchObject([
      {
        id: '3EB0B66E111010A5A90000',
        from: '5513981450000',
        conversation: '5513981450000@s.whatsapp.net',
        text: 'Oi vó',
      },
    ]);
    // The same chat addressed by its LID keeps the same conversation id.
    expect(
      adapter.parse({
        event: 'messages.upsert',
        instance: 'agora-test',
        data: {
          key: {
            remoteJid: '239611947270000@lid',
            remoteJidAlt: '5513981450000@s.whatsapp.net',
            id: 'W2',
          },
          status: 'received',
          message: { conversation: 'de novo' },
        },
      }),
    ).toMatchObject([{ from: '5513981450000', conversation: '5513981450000@s.whatsapp.net' }]);
    // Only the LID known: it is the conversation.
    expect(
      adapter.parse(
        whatsmiauIncoming({
          key: { remoteJid: '239611947270000@lid', remoteLid: '239611947270000@lid', id: 'W3' },
        }),
      ),
    ).toMatchObject([{ from: '239611947270000@lid', conversation: '239611947270000@lid' }]);
  });

  it('marks a button press Whatsmiau forwards with only its label', () => {
    const adapter = whatsmiau({ ...options, instance: 'agora-test', url: 'http://whatsmiau:8080' });
    const pressed = adapter.parse(
      whatsmiauIncoming({
        key: { remoteJid: '5513981450000@s.whatsapp.net', id: '3EB0B1' },
        messageType: 'buttonsResponseMessage',
        message: { conversation: 'Confirmar' },
      }),
    ) as InboundMessage[];
    expect(pressed).toMatchObject([{ text: 'Confirmar', buttonWithoutId: true }]);
    expect(pressed[0]?.buttonId).toBeUndefined();
    // A typed message is not a press.
    expect(
      (adapter.parse(whatsmiauIncoming()) as InboundMessage[])[0]?.buttonWithoutId,
    ).toBeUndefined();
  });

  it('never takes a message without fromMe for incoming unless its status is received', () => {
    const adapter = whatsmiau({ ...options, instance: 'agora-test', url: 'http://whatsmiau:8080' });
    for (const status of ['SERVER_ACK', 'PENDING', 'DELIVERY_ACK', undefined]) {
      const body = whatsmiauIncoming({ status });
      expect(adapter.parse(body)).toEqual([]);
      expect(adapter.ignored?.(body)).toEqual({
        event: 'messages.upsert',
        reason: `fromMe missing and status ${String(status)}`,
        unexpected: true,
      });
    }
    // An explicit fromMe: true stays the instance's own message, whatever the status.
    const own = whatsmiauIncoming({
      key: { remoteJid: '5513981450000@s.whatsapp.net', id: 'W4', fromMe: true },
    });
    expect(adapter.parse(own)).toEqual([]);
    expect(adapter.ignored?.(own)).toEqual({ event: 'messages.upsert', reason: 'own message' });
    expect(adapter.parse(whatsmiauIncoming({ fromMe: true }))).toEqual([]);
    expect(adapter.ignored?.({ event: 'messages.update', instance: 'agora-test' })).toEqual({
      event: 'messages.update',
      reason: 'not a messages.upsert event',
    });
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
          { from: '5511999990000', id: 'wamid.3', type: 'reaction', reaction: { emoji: 'x' } },
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

// ── media ─────────────────────────────────────────────────────────────────────

/** A `fetch` answering by url: JSON for an object, bytes for a Buffer. */
function routedFetch(routes: Record<string, unknown>) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: any }[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      ...(init.body !== undefined ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const answer = routes[url];
    if (answer === undefined) return new Response('not found', { status: 404 });
    if (Buffer.isBuffer(answer))
      return new Response(new Uint8Array(answer), { headers: { 'content-type': 'image/jpeg' } });
    return new Response(JSON.stringify(answer), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('media', () => {
  const jpeg = Buffer.from('fake-jpeg-bytes');

  it('evolutionApi: parses an image with its caption and a document; downloads three ways', async () => {
    const base64 = jpeg.toString('base64');
    const { fetch, calls } = routedFetch({
      'https://files.example/m.jpg': jpeg,
      'https://evo/chat/getBase64FromMediaMessage/main': {
        base64,
        mimetype: 'application/pdf',
        fileName: 'report.pdf',
      },
    });
    const adapter = evolutionApi({
      url: 'https://evo',
      instance: 'main',
      apiKey: 'k',
      webhookToken: 's',
      fetch,
    });
    const key = { remoteJid: '5511999990000@s.whatsapp.net', fromMe: false, id: 'M1' };
    const [image] = adapter.parse({
      event: 'messages.upsert',
      instance: 'main',
      data: {
        key,
        message: {
          imageMessage: { caption: 'my rash', mimetype: 'image/jpeg', fileLength: '15' },
          base64,
        },
      },
    }) as any[];
    expect(image).toMatchObject({
      text: 'my rash',
      media: [{ kind: 'image', contentType: 'image/jpeg', sizeBytes: 15 }],
    });
    expect((await adapter.download!(image.media[0], { maxBytes: 100 })).data).toEqual(jpeg);
    await expect(adapter.download!(image.media[0], { maxBytes: 5 })).rejects.toBeInstanceOf(
      ChannelMediaTooLargeError,
    );

    const [linked] = adapter.parse({
      event: 'messages.upsert',
      instance: 'main',
      data: {
        key,
        message: {
          imageMessage: { mimetype: 'image/jpeg' },
          mediaUrl: 'https://files.example/m.jpg',
        },
      },
    }) as any[];
    expect(linked.text).toBe('');
    expect((await adapter.download!(linked.media[0], { maxBytes: 100 })).data).toEqual(jpeg);
    // the instance key never goes to a storage host
    expect(calls[0]).toMatchObject({ url: 'https://files.example/m.jpg', headers: {} });

    const [document] = adapter.parse({
      event: 'messages.upsert',
      instance: 'main',
      data: {
        key,
        message: {
          documentWithCaptionMessage: {
            message: {
              documentMessage: {
                fileName: 'report.pdf',
                mimetype: 'application/pdf',
                caption: 'see',
              },
            },
          },
        },
      },
    }) as any[];
    expect(document).toMatchObject({
      text: 'see',
      media: [{ kind: 'document', filename: 'report.pdf' }],
    });
    expect(await adapter.download!(document.media[0], { maxBytes: 100 })).toEqual({
      data: jpeg,
      contentType: 'application/pdf',
      filename: 'report.pdf',
    });
    expect(calls[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ apikey: 'k' }),
      body: { message: { key }, convertToMp4: false },
    });
  });

  it('whatsappCloud: resolves the media id, then downloads with the token', async () => {
    const { fetch, calls } = routedFetch({
      'https://graph.facebook.com/v23.0/MEDIA1': {
        url: 'https://lookaside.fbsbx.com/m?x=1',
        mime_type: 'audio/ogg',
        file_size: 15,
      },
      'https://lookaside.fbsbx.com/m?x=1': jpeg,
    });
    const adapter = whatsappCloud({
      phoneNumberId: '1061',
      accessToken: 'EAAG',
      appSecret: 's',
      verifyToken: 'v',
      fetch,
    });
    const [voice] = adapter.parse({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '1061' },
                messages: [
                  {
                    from: '55119',
                    id: 'wamid.9',
                    type: 'audio',
                    audio: { id: 'MEDIA1', mime_type: 'audio/ogg; codecs=opus' },
                  },
                ],
              },
            },
          ],
        },
      ],
    }) as any[];
    expect(voice).toMatchObject({
      text: '',
      media: [{ kind: 'audio', ref: 'MEDIA1', contentType: 'audio/ogg; codecs=opus' }],
    });
    const file = await adapter.download!(voice.media[0], { maxBytes: 100 });
    expect(file.data).toEqual(jpeg);
    expect(calls.map((call) => call.headers.authorization)).toEqual(['Bearer EAAG', 'Bearer EAAG']);
    await expect(adapter.download!(voice.media[0], { maxBytes: 10 })).rejects.toBeInstanceOf(
      ChannelMediaTooLargeError,
    );
  });

  it('telegram: takes the largest photo size, and downloads through getFile', async () => {
    const { fetch } = routedFetch({
      'https://api.telegram.org/bot1:x/getFile': {
        ok: true,
        result: { file_path: 'photos/p.jpg' },
      },
      'https://api.telegram.org/file/bot1:x/photos/p.jpg': jpeg,
    });
    const adapter = telegram({ botToken: '1:x', secretToken: 's', fetch });
    const message = adapter.parse({
      update_id: 5,
      message: {
        chat: { id: 42, type: 'private' },
        from: { id: 42 },
        caption: 'look',
        photo: [
          { file_id: 'small', file_size: 10 },
          { file_id: 'big', file_size: 15 },
        ],
      },
    }) as any;
    expect(message).toMatchObject({
      text: 'look',
      media: [{ kind: 'image', ref: 'big', contentType: 'image/jpeg', sizeBytes: 15 }],
    });
    expect(await adapter.download!(message.media[0], { maxBytes: 100 })).toEqual({
      data: jpeg,
      contentType: 'image/jpeg',
    });
    await expect(adapter.download!(message.media[0], { maxBytes: 10 })).rejects.toBeInstanceOf(
      ChannelMediaTooLargeError,
    );
    const voice = adapter.parse({
      update_id: 6,
      message: {
        chat: { id: 42, type: 'private' },
        from: { id: 42 },
        voice: { file_id: 'v1', file_size: 3 },
      },
    }) as any;
    expect(voice.media).toEqual([
      { kind: 'audio', ref: 'v1', contentType: 'audio/ogg', sizeBytes: 3 },
    ]);
  });
});
