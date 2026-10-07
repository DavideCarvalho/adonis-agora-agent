import {
  ChannelDeliveryError,
  type ChannelFetch,
  ChannelMediaTooLargeError,
  decodeBase64,
  fetchBytes,
  postJson,
  queryParam,
  record,
  safeEqual,
  sizeOf,
  str,
} from '../http.js';
import type {
  ChannelAdapter,
  ChannelRequest,
  InboundMedia,
  InboundMessage,
  OutboundMessage,
} from '../types.js';

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
   * Which server speaks the Evolution routes — it decides whether {@link buttons} defaults on:
   *
   * - `'evolution'` (default): Evolution API itself, on Baileys. Its `sendButtons` goes out as a
   *   `nativeFlow` interactive message that WhatsApp did not show at all in our test (2.3.7, Android
   *   recipient) — while Evolution still reports it sent — so buttons stay off.
   * - `'whatsmiau'`: [Whatsmiau](https://whatsmiau.dev), on whatsmeow, whose `sendButtons` renders a
   *   buttons card — buttons default on.
   */
  provider?: 'evolution' | 'whatsmiau';
  /**
   * Send proposals with reply buttons (`POST /message/sendButtons/{instance}`). Default: on for
   * `provider: 'whatsmiau'`, off for Evolution — a Baileys session's buttons may not be rendered by
   * WhatsApp, and the message then does not show at all. The buttons message carries the text
   * instruction too ("Reply *yes* to confirm…"), for a phone that shows the text but not the
   * buttons; a 4xx from that endpoint falls back to the text-only message.
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

const MEDIA_FIELDS = [
  ['imageMessage', 'image'],
  ['audioMessage', 'audio'],
  ['videoMessage', 'video'],
  ['documentMessage', 'document'],
  ['stickerMessage', 'sticker'],
] as const;

/** What {@link evolutionApi}'s `download` needs: the message key, and the bytes if Evolution inlined them. */
interface EvolutionMediaRef {
  key: Record<string, unknown>;
  base64?: string | undefined;
  mediaUrl?: string | undefined;
}

/** The file a message carries, and its caption. */
function mediaOf(
  message: Record<string, unknown>,
  key: Record<string, unknown>,
): { media: InboundMedia; caption: string | undefined } | undefined {
  // A document sent with a caption arrives wrapped.
  const wrapped = record(record(message.documentWithCaptionMessage)?.message);
  const source = wrapped ?? message;
  for (const [field, kind] of MEDIA_FIELDS) {
    const body = record(source[field]);
    if (!body) continue;
    const ref: EvolutionMediaRef = {
      key,
      ...(str(message.base64) !== undefined ? { base64: str(message.base64) } : {}),
      ...(str(message.mediaUrl) !== undefined ? { mediaUrl: str(message.mediaUrl) } : {}),
    };
    const contentType = str(body.mimetype);
    const filename = str(body.fileName);
    const sizeBytes = sizeOf(body.fileLength);
    return {
      media: {
        kind,
        ref,
        ...(contentType !== undefined ? { contentType } : {}),
        ...(filename !== undefined ? { filename } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      },
      caption: str(body.caption),
    };
  }
  return undefined;
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
  // A `@lid` chat (`addressingMode: 'lid'`) hides the number; Evolution adds it alongside
  // (`remoteJidAlt`, older versions `senderPn`) when it knows it.
  const phoneJid = [remoteJid, str(key.remoteJidAlt), str(key.senderPn)].find(
    (jid) => jid !== undefined && PHONE_JID.test(jid),
  );
  const sender = group ? str(key.participant) : (phoneJid ?? remoteJid);
  if (sender === undefined) return null;
  const message = record(data.message);
  if (!message) return null;
  const button = buttonReply(message);
  const file = button ? undefined : mediaOf(message, key);
  const text = button
    ? (button.label ?? button.id)
    : file
      ? (file.caption ?? '')
      : (str(message.conversation) ?? str(record(message.extendedTextMessage)?.text));
  if (text === undefined || (text.trim() === '' && !file)) return null;
  return {
    id,
    from: addressOf(sender),
    // Replies go to the phone when it is known — `sendText`'s `number` is a phone number, and the
    // same chat arrives under its phone jid or its `@lid` one; the `@lid` jid only when it is all
    // there is.
    conversation: group ? remoteJid : (phoneJid ?? remoteJid),
    text: text.trim(),
    ...(button ? { buttonId: button.id } : {}),
    ...(file ? { media: [file.media] } : {}),
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
 * Reads `messages.upsert` (text, extended text, button and list replies, images, audio, video,
 * documents and stickers); ignores the instance's own messages, broadcasts and (unless `groups`)
 * groups. Sends with `POST {url}/message/sendText/{instance}`. Downloads media from the webhook's
 * inline `base64` (Evolution's "webhook base64" setting), else its `mediaUrl`, else
 * `POST {url}/chat/getBase64FromMediaMessage/{instance}`.
 */
export function evolutionApi(options: EvolutionApiOptions): ChannelAdapter {
  const name = options.name ?? 'whatsapp';
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const base = options.url.replace(/\/+$/, '');
  const instance = encodeURIComponent(options.instance);
  const headers = { apikey: options.apiKey };
  const buttons = options.buttons ?? options.provider === 'whatsmiau';
  const post = (path: string, body: unknown) =>
    postJson(name, fetcher, `${base}${path}/${instance}`, headers, body, timeoutMs);

  return {
    name,
    capabilities: {
      ...(buttons ? { buttons: MAX_BUTTONS } : {}),
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

    async download(media: InboundMedia, { maxBytes }) {
      const ref = media.ref as EvolutionMediaRef;
      if (media.sizeBytes !== undefined && media.sizeBytes > maxBytes) {
        throw new ChannelMediaTooLargeError(maxBytes);
      }
      const fallbackType = media.contentType ?? 'application/octet-stream';
      const named = media.filename !== undefined ? { filename: media.filename } : {};
      if (ref.base64 !== undefined) {
        return { data: decodeBase64(ref.base64, maxBytes), contentType: fallbackType, ...named };
      }
      if (ref.mediaUrl !== undefined) {
        // The instance's key goes only to the Evolution server itself, never to a storage host.
        const sameHost = new URL(ref.mediaUrl).origin === new URL(base).origin;
        const file = await fetchBytes(
          name,
          fetcher,
          ref.mediaUrl,
          sameHost ? headers : {},
          timeoutMs,
          maxBytes,
        );
        return {
          data: file.data,
          contentType: media.contentType ?? file.contentType ?? fallbackType,
          ...named,
        };
      }
      const answer = record(
        await post('/chat/getBase64FromMediaMessage', {
          message: { key: ref.key },
          convertToMp4: false,
        }),
      );
      const base64 = str(answer?.base64);
      if (base64 === undefined) {
        throw new ChannelDeliveryError(name, null, `${name}: the media could not be downloaded`);
      }
      const filename = str(answer?.fileName) ?? media.filename;
      return {
        data: decodeBase64(base64, maxBytes),
        contentType: str(answer?.mimetype) ?? fallbackType,
        ...(filename !== undefined ? { filename } : {}),
      };
    },

    async send(conversation: string, message: OutboundMessage) {
      const number = addressOf(conversation);
      if (message.buttons !== undefined && buttons) {
        const [first = '', ...rest] = message.text.split('\n');
        const title = first.replace(/[*_~]/g, '').trim();
        // The reply instruction rides along: a phone that shows the text but not the buttons can
        // still answer by text.
        const description = [rest.join('\n').trim(), message.instruction?.trim() ?? '']
          .filter((part) => part !== '')
          .join('\n\n');
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
