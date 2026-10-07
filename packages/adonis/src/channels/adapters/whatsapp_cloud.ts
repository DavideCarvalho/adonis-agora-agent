import { createHmac } from 'node:crypto';
import { type ChannelFetch, postJson, queryParam, record, safeEqual, str } from '../http.js';
import type { ChannelAdapter, ChannelRequest, InboundMessage, OutboundMessage } from '../types.js';

export interface WhatsappCloudOptions {
  /** The business phone number's id (WhatsApp Manager → API setup) — not the number itself. */
  phoneNumberId: string;
  /** A system-user (or temporary) access token with `whatsapp_business_messaging`. */
  accessToken: string;
  /** The Meta app's secret: `X-Hub-Signature-256` is an HMAC of the raw body under it. */
  appSecret: string;
  /** The "Verify token" typed into the app's webhook settings, echoed by the subscription check. */
  verifyToken: string;
  /** Graph API version. Default `'v23.0'`. */
  graphVersion?: string;
  /** The adapter's name — the dedupe prefix and the decision's `via`. Default `'whatsapp'`. */
  name?: string;
  /** Per-request timeout. Default 20 s. */
  timeoutMs?: number;
  fetch?: ChannelFetch;
}

/** Cloud API limits: text body, interactive body, button title. */
const MAX_TEXT = 4096;
const MAX_INTERACTIVE_BODY = 1024;
const MAX_BUTTON_TITLE = 20;
const MAX_BUTTONS = 3;

function parseMessage(message: Record<string, unknown>): InboundMessage | null {
  const id = str(message.id);
  const from = str(message.from);
  if (!id || !from) return null;
  const interactive = record(message.interactive);
  const reply = record(interactive?.button_reply) ?? record(interactive?.list_reply);
  // A template's quick-reply button.
  const button = record(message.button);
  const buttonId = str(reply?.id) ?? str(button?.payload);
  const text =
    str(record(message.text)?.body) ?? str(reply?.title) ?? str(button?.text) ?? buttonId;
  if (text === undefined || text.trim() === '') return null;
  return {
    id,
    from,
    conversation: from,
    text: text.trim(),
    ...(buttonId !== undefined ? { buttonId } : {}),
    raw: message,
  };
}

/**
 * WhatsApp through Meta's [Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api).
 * Route both `GET` (the subscription check) and `POST` (messages) to the same handler, and subscribe
 * the app to the `messages` field.
 *
 * Verifies `X-Hub-Signature-256` over the raw body; reads text, interactive button/list replies and
 * template quick replies addressed to `phoneNumberId` (status updates are ignored); sends text and
 * interactive reply buttons (at most 3, 20-character titles).
 */
export function whatsappCloud(options: WhatsappCloudOptions): ChannelAdapter {
  const name = options.name ?? 'whatsapp';
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const endpoint = `https://graph.facebook.com/${options.graphVersion ?? 'v23.0'}/${encodeURIComponent(options.phoneNumberId)}/messages`;
  const post = (body: Record<string, unknown>) =>
    postJson(
      name,
      fetcher,
      endpoint,
      { authorization: `Bearer ${options.accessToken}` },
      { messaging_product: 'whatsapp', recipient_type: 'individual', ...body },
      timeoutMs,
    );
  const sendText = (to: string, body: string) =>
    post({ to, type: 'text', text: { body, preview_url: false } });

  return {
    name,
    capabilities: { buttons: MAX_BUTTONS, markdown: 'whatsapp', maxLength: MAX_TEXT },

    challenge(request: ChannelRequest) {
      if (request.method !== 'GET') return null;
      const mode = queryParam(request.url, 'hub.mode');
      const token = queryParam(request.url, 'hub.verify_token');
      const challenge = queryParam(request.url, 'hub.challenge');
      if (mode === 'subscribe' && challenge !== undefined && safeEqual(token, options.verifyToken))
        return { status: 200, body: challenge, contentType: 'text/plain' };
      return { status: 403, body: 'Forbidden', contentType: 'text/plain' };
    },

    verify(request: ChannelRequest) {
      const signature = request.header('x-hub-signature-256');
      if (request.rawBody === null || signature === undefined) return false;
      const expected = `sha256=${createHmac('sha256', options.appSecret).update(request.rawBody, 'utf8').digest('hex')}`;
      return safeEqual(signature, expected);
    },

    parse(body) {
      const envelope = record(body);
      if (envelope?.object !== 'whatsapp_business_account' || !Array.isArray(envelope.entry))
        return null;
      const messages: InboundMessage[] = [];
      for (const entry of envelope.entry) {
        const changes = record(entry)?.changes;
        if (!Array.isArray(changes)) continue;
        for (const change of changes) {
          const value = record(record(change)?.value);
          if (record(change)?.field !== 'messages' || !value) continue;
          if (str(record(value.metadata)?.phone_number_id) !== options.phoneNumberId) continue;
          if (!Array.isArray(value.messages)) continue;
          for (const message of value.messages) {
            const parsed = record(message) ? parseMessage(record(message)!) : null;
            if (parsed) messages.push(parsed);
          }
        }
      }
      return messages;
    },

    async send(conversation: string, message: OutboundMessage) {
      if (message.buttons === undefined || message.buttons.length === 0) {
        await sendText(
          conversation,
          message.buttons === undefined ? message.text : message.fallbackText,
        );
        return;
      }
      let body = message.text;
      if (body.length > MAX_INTERACTIVE_BODY) {
        // The interactive body is short: the text goes first, the buttons under its last paragraph.
        const cut = body.lastIndexOf('\n\n', body.length - 1);
        const tail = cut > 0 ? body.slice(cut + 2) : '';
        const head =
          tail.length > 0 && tail.length <= MAX_INTERACTIVE_BODY ? body.slice(0, cut) : body;
        await sendText(conversation, head);
        body = head === body ? '…' : tail;
      }
      await post({
        to: conversation,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: body },
          action: {
            buttons: message.buttons.slice(0, MAX_BUTTONS).map((button) => ({
              type: 'reply',
              reply: { id: button.id, title: button.label.slice(0, MAX_BUTTON_TITLE) },
            })),
          },
        },
      });
    },
  };
}
