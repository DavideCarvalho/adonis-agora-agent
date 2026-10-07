import {
  ChannelDeliveryError,
  type ChannelFetch,
  postJson,
  queryParam,
  record,
  safeEqual,
  str,
} from '../http.js';
import type { ChannelAdapter, ChannelRequest, InboundMessage, OutboundMessage } from '../types.js';

export interface EvolutionApiOptions {
  /**
   * The Evolution API server, without a trailing slash — `https://evolution.example.com`. A
   * compatible host that serves the same routes under a prefix takes it here
   * (`https://api.whatsmiau.dev/v2`).
   */
  url: string;
  /** The instance (the connected WhatsApp number) to send from and accept webhooks for. */
  instance: string;
  /** The `apikey` header — the instance token or the global key. */
  apiKey: string;
  /**
   * The secret a webhook must carry: as `?token=` in the webhook URL, a `:token` route param, an
   * `Authorization: Bearer` header or an `x-webhook-token` header. Evolution signs nothing, so this
   * token is the only thing standing between the route and anyone who wants to post as any phone
   * number. `false` turns the check off — only for a server that cannot be reached from outside.
   */
  webhookToken: string | false;
  /**
   * Send proposals with reply buttons (`POST /message/sendButtons/{instance}`). Off by default:
   * WhatsApp does not reliably render buttons sent from a non-Business-API session, so many
   * instances show nothing. When on, a 4xx from that endpoint falls back to the text instruction.
   */
  buttons?: boolean;
  /** Answer messages in groups too (the sender is the participant). Default `false`. */
  groups?: boolean;
  /** Longest message text. Default 4096. */
  maxLength?: number;
  /** The adapter's name — the dedupe prefix and the decision's `via`. Default `'whatsapp'`. */
  name?: string;
  /** Per-request timeout. Default 20 s. */
  timeoutMs?: number;
  fetch?: ChannelFetch;
}

const PHONE_JID = /^(\d{5,20})@s\.whatsapp\.net$/;

/** A phone jid's digits; any other jid as is. */
function addressOf(jid: string): string {
  return PHONE_JID.exec(jid)?.[1] ?? jid;
}

/** The id and label of a button / list reply, in any of the shapes Evolution forwards them. */
function buttonReply(
  message: Record<string, unknown>,
): { id: string; label: string | undefined } | undefined {
  const buttons = record(message.buttonsResponseMessage);
  const template = record(message.templateButtonReplyMessage);
  const list = record(message.listResponseMessage);
  const interactive = record(record(message.interactiveResponseMessage)?.nativeFlowResponseMessage);
  const id =
    str(buttons?.selectedButtonId) ??
    str(template?.selectedId) ??
    str(record(list?.singleSelectReply)?.selectedRowId) ??
    (() => {
      const params = str(interactive?.paramsJson);
      if (params === undefined) return undefined;
      try {
        return str(record(JSON.parse(params))?.id);
      } catch {
        return undefined;
      }
    })();
  if (id === undefined) return undefined;
  return {
    id,
    label:
      str(buttons?.selectedDisplayText) ?? str(template?.selectedDisplayText) ?? str(list?.title),
  };
}

function parseOne(
  data: Record<string, unknown>,
  options: EvolutionApiOptions,
): InboundMessage | null {
  const key = record(data.key);
  const remoteJid = str(key?.remoteJid);
  const id = str(key?.id);
  if (!key || !remoteJid || !id) return null;
  // Only a message explicitly marked as incoming: never assume a missing `fromMe` means "not mine".
  if (!(key.fromMe === false || data.fromMe === false) || key.fromMe === true) return null;
  if (remoteJid.endsWith('@broadcast') || remoteJid.endsWith('@newsletter')) return null;
  const group = remoteJid.endsWith('@g.us');
  if (group && options.groups !== true) return null;
  const sender = group
    ? str(key.participant)
    : // A `@lid` chat hides the number; Evolution adds it alongside when it knows it.
      ([remoteJid, str(key.remoteJidAlt), str(key.senderPn)].find(
        (jid) => jid !== undefined && PHONE_JID.test(jid),
      ) ?? remoteJid);
  if (sender === undefined) return null;
  const message = record(data.message);
  if (!message) return null;
  const button = buttonReply(message);
  const text = button
    ? (button.label ?? button.id)
    : (str(message.conversation) ?? str(record(message.extendedTextMessage)?.text));
  if (text === undefined || text.trim() === '') return null;
  return {
    id,
    from: addressOf(sender),
    conversation: remoteJid,
    text: text.trim(),
    ...(button ? { buttonId: button.id } : {}),
    raw: data,
  };
}

/** The WhatsApp reply-button limit. */
const MAX_BUTTONS = 3;

/**
 * WhatsApp through [Evolution API](https://doc.evolution-api.com) v2 (or a server with the same
 * routes). Point the instance's webhook — event `MESSAGES_UPSERT` — at the route, with the token:
 * `https://app.example.com/webhooks/whatsapp?token=<webhookToken>`.
 *
 * Reads `messages.upsert` (text, extended text, button and list replies); ignores the instance's own
 * messages, broadcasts and (unless `groups`) groups. Sends with `POST {url}/message/sendText/{instance}`.
 */
export function evolutionApi(options: EvolutionApiOptions): ChannelAdapter {
  const name = options.name ?? 'whatsapp';
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const base = options.url.replace(/\/+$/, '');
  const instance = encodeURIComponent(options.instance);
  const headers = { apikey: options.apiKey };
  const post = (path: string, body: unknown) =>
    postJson(name, fetcher, `${base}${path}/${instance}`, headers, body, timeoutMs);

  return {
    name,
    capabilities: {
      ...(options.buttons === true ? { buttons: MAX_BUTTONS } : {}),
      markdown: 'whatsapp',
      maxLength: options.maxLength ?? 4096,
    },

    verify(request: ChannelRequest) {
      if (options.webhookToken === false) return true;
      const bearer = request.header('authorization')?.replace(/^Bearer\s+/i, '');
      const supplied = [
        queryParam(request.url, 'token'),
        typeof request.params.token === 'string' ? request.params.token : undefined,
        bearer,
        request.header('x-webhook-token'),
      ];
      return supplied.some((token) => safeEqual(token, options.webhookToken as string));
    },

    parse(body) {
      const envelope = record(body);
      if (!envelope) return null;
      const event = str(envelope.event)?.toLowerCase().replace(/_/g, '.');
      if (event !== 'messages.upsert') return null;
      const from = str(envelope.instance);
      if (from !== undefined && from !== options.instance) return null;
      const items = Array.isArray(envelope.data) ? envelope.data : [envelope.data];
      return items
        .map((item) => record(item))
        .filter((item): item is Record<string, unknown> => item !== undefined)
        .map((item) => parseOne(item, options))
        .filter((item): item is InboundMessage => item !== null);
    },

    async send(conversation: string, message: OutboundMessage) {
      const number = addressOf(conversation);
      if (message.buttons !== undefined && options.buttons === true) {
        const [first = '', ...rest] = message.text.split('\n');
        const title = first.replace(/[*_~]/g, '').trim();
        const description = rest.join('\n').trim();
        if (title.length <= 60 && description.length <= 1024 && message.buttons.length > 0) {
          try {
            await post('/message/sendButtons', {
              number,
              title,
              description: description === '' ? title : description,
              buttons: message.buttons.slice(0, MAX_BUTTONS).map((button) => ({
                type: 'reply',
                displayText: button.label.slice(0, 20),
                id: button.id,
              })),
            });
            return;
          } catch (error) {
            // Only a definite refusal falls back: a timeout may have delivered the buttons already.
            if (!(error instanceof ChannelDeliveryError) || !error.definite) throw error;
          }
        }
        await post('/message/sendText', { number, text: message.fallbackText });
        return;
      }
      await post('/message/sendText', {
        number,
        text: message.buttons !== undefined ? message.fallbackText : message.text,
      });
    },
  };
}
