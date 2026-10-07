import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelTurnService,
  InboundMessage,
  OutboundMessage,
} from '../../src/channels/index.js';
import type { StreamFrame } from '../../src/spi/token-stream-sink.js';

/** Fakes for the channel handler specs: an Adonis ctx, an adapter that records, a scripted service. */

export function makeCtx(
  body: unknown,
  opts: { headers?: Record<string, string>; method?: string } = {},
) {
  const headers = { 'x-ok': '1', ...opts.headers };
  const sent: { status: number; body: unknown } = { status: 0, body: undefined };
  const ctx = {
    request: {
      method: () => opts.method ?? 'POST',
      url: () => '/webhooks/test',
      header: (name: string) => headers[name.toLowerCase() as keyof typeof headers],
      body: () => body,
      raw: () => JSON.stringify(body),
    },
    params: {},
    response: {
      status(code: number) {
        sent.status = code;
        return this;
      },
      header() {
        return this;
      },
      send(value: unknown) {
        sent.body = value;
      },
    },
    containerResolver: {
      make: async () => {
        throw new Error('no container in this test');
      },
    },
  };
  return { ctx: ctx as never, sent };
}

export function fakeAdapter(capabilities: Partial<ChannelCapabilities> = {}) {
  const outbox: { conversation: string; message: OutboundMessage }[] = [];
  const adapter: ChannelAdapter = {
    name: 'test',
    capabilities: { markdown: 'whatsapp', maxLength: 4096, ...capabilities },
    verify: (request) => request.header('x-ok') === '1',
    parse: (body) => body as InboundMessage,
    send: async (conversation, message) => {
      outbox.push({ conversation, message });
    },
  };
  return { adapter, outbox };
}

export const inbound = (text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
  id: `m-${Math.random()}`,
  from: '5511999990000',
  conversation: 'chat-1',
  text,
  raw: {},
  ...extra,
});

export interface FakeService extends ChannelTurnService {
  sends: any[];
  decided: any[];
  skipped: any[];
  subscribed: string[];
}

export function fakeService(
  frames: StreamFrame[] | ((runId: string) => AsyncIterable<StreamFrame>),
  overrides: Partial<ChannelTurnService> = {},
): FakeService {
  const service: FakeService = {
    sends: [],
    decided: [],
    skipped: [],
    subscribed: [],
    send: async (params) => {
      service.sends.push(params);
      return { runId: 'run-1', threadId: params.threadId ?? 'thread-new' };
    },
    subscribe: (runId) => {
      service.subscribed.push(runId);
      if (typeof frames === 'function') return frames(runId);
      return (async function* () {
        yield* frames;
      })();
    },
    skip: async (args) => {
      service.skipped.push(args);
    },
    cancel: async () => {},
    actionProposalReply: (result, decision) =>
      result.status === 'applied' ? `${decision}!` : `could not: ${result.status}`,
    ...overrides,
  } as FakeService;
  return service;
}

export const texts = (outbox: { message: OutboundMessage }[]) =>
  outbox.map((item) => item.message.text);

export const actor = { id: 'u1', roles: [] };
