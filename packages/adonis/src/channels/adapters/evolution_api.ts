import {
  ChannelDeliveryError,
  type ChannelFetch,
  ChannelMediaTooLargeError,
  decodeBase64,
  fetchBytes,
  mediaFilename,
  postJson,
  queryParam,
  record,
  safeEqual,
  sizeOf,
  str,
} from '../http.js';
import type {
  ChannelAdapter,
  ChannelIgnored,
  ChannelRequest,
  InboundMedia,
  InboundMessage,
  OutboundMessage,
} from '../types.js';

export interface EvolutionApiOptions {
  /**
   * The Evolution API server — `https://evolution.example.com`. A compatible host that serves the
   * same routes under a prefix takes it here (`https://evolution.example.com/api`).
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
   * Evolution (Baileys) sends them as a `nativeFlow` interactive message that WhatsApp did not show
   * at all in our test (2.3.7, Android recipient) — while Evolution still reported it sent. For
   * Whatsmiau, whose buttons render, use `whatsmiau()` (buttons on). The buttons message carries the
   * text instruction too ("Reply *yes* to confirm…"), for a phone that shows the text but not the
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

/** Why a webhook item is not a message to answer — logged by the handler, never message content. */
interface Skipped {
  skipped: string;
  /** An item that looked like a person's message but could not be read — worth a warning. */
  unexpected?: boolean;
}

const LID_JID = /@lid$/;

/** The message types of a button or list reply. */
const REPLY_TYPES = new Set([
  'buttonsResponseMessage',
  'templateButtonReplyMessage',
  'listResponseMessage',
  'interactiveResponseMessage',
]);

/**
 * Is the message from the person (not sent by the instance itself)? Explicit `fromMe: false` → yes,
 * `fromMe: true` → no. Absent from both the key and the data — Whatsmiau (Go, `omitempty`) drops a
 * `false` — only a `status: 'received'` says it came in; any other status is never assumed incoming,
 * so the agent never answers its own messages.
 */
function direction(
  key: Record<string, unknown>,
  data: Record<string, unknown>,
): 'incoming' | 'own' | 'unknown' {
  if (key.fromMe === true || data.fromMe === true) return 'own';
  if (key.fromMe === false || data.fromMe === false) return 'incoming';
  if (key.fromMe === undefined && data.fromMe === undefined && data.status === 'received') {
    return 'incoming';
  }
  return 'unknown';
}

function parseOne(
  data: Record<string, unknown>,
  options: EvolutionApiOptions,
): InboundMessage | Skipped {
  const key = record(data.key);
  const remoteJid = str(key?.remoteJid);
  const id = str(key?.id);
  if (!key || !remoteJid || !id) return { skipped: 'no message key', unexpected: true };
  const from = direction(key, data);
  if (from === 'own') return { skipped: 'own message' };
  if (from === 'unknown') {
    return { skipped: `fromMe missing and status ${String(data.status)}`, unexpected: true };
  }
  if (remoteJid.endsWith('@broadcast') || remoteJid.endsWith('@newsletter')) {
    return { skipped: 'broadcast' };
  }
  const group = remoteJid.endsWith('@g.us');
  if (group && options.groups !== true) return { skipped: 'group' };
  // A chat is addressed by its phone jid or by its `@lid` one (`addressingMode: 'lid'`), and the
  // server adds the other alongside when it knows it: Evolution `remoteJidAlt` (older versions
  // `senderPn`), Whatsmiau `remoteLid`. The phone wins, so the chat keeps one id either way.
  const aliases = [remoteJid, str(key.remoteJidAlt), str(key.senderPn), str(key.remoteLid)];
  const phoneJid = aliases.find((jid) => jid !== undefined && PHONE_JID.test(jid));
  const lidJid = aliases.find((jid) => jid !== undefined && LID_JID.test(jid));
  const chat = phoneJid ?? lidJid ?? remoteJid;
  const sender = group ? str(key.participant) : chat;
  if (sender === undefined) return { skipped: 'no group participant', unexpected: true };
  const message = record(data.message);
  if (!message) return { skipped: 'no message body' };
  const button = buttonReply(message);
  const file = button ? undefined : mediaOf(message, key);
  const text = button
    ? (button.label ?? button.id)
    : file
      ? (file.caption ?? '')
      : (str(message.conversation) ?? str(record(message.extendedTextMessage)?.text));
  if (text === undefined || (text.trim() === '' && !file)) {
    return { skipped: 'unsupported message type' };
  }
  // Whatsmiau forwards a button press as `messageType: 'buttonsResponseMessage'` with only the
  // label in `message.conversation` — the button's id is lost.
  const pressWithoutId = !button && !file && REPLY_TYPES.has(str(data.messageType) ?? '');
  return {
    id,
    from: addressOf(sender),
    // Replies go to the phone when it is known — `sendText`'s `number` is a phone number; the `@lid`
    // jid only when it is all there is.
    conversation: group ? remoteJid : chat,
    text: text.trim(),
    ...(button ? { buttonId: button.id } : {}),
    ...(pressWithoutId ? { buttonWithoutId: true } : {}),
    ...(file ? { media: [file.media] } : {}),
    raw: data,
  };
}

/** The messages in a webhook body, or why there are none. */
function readBody(
  body: unknown,
  options: EvolutionApiOptions,
): { messages: InboundMessage[] | null; ignored?: ChannelIgnored } {
  const envelope = record(body);
  if (!envelope) return { messages: null, ignored: { reason: 'not a JSON object' } };
  const rawEvent = str(envelope.event);
  const event = rawEvent?.toLowerCase().replace(/_/g, '.');
  const named = rawEvent !== undefined ? { event: rawEvent } : {};
  if (event !== 'messages.upsert') {
    return { messages: null, ignored: { ...named, reason: 'not a messages.upsert event' } };
  }
  const from = str(envelope.instance);
  if (from !== undefined && from !== options.instance) {
    return { messages: null, ignored: { ...named, reason: 'another instance' } };
  }
  const items = (Array.isArray(envelope.data) ? envelope.data : [envelope.data])
    .map((item) => record(item))
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .map((item) => parseOne(item, options));
  const messages = items.filter((item): item is InboundMessage => !('skipped' in item));
  if (messages.length > 0) return { messages };
  const skipped = items.filter((item): item is Skipped => 'skipped' in item);
  if (skipped.length === 0) return { messages, ignored: { ...named, reason: 'no data' } };
  return {
    messages,
    ignored: {
      ...named,
      reason: [...new Set(skipped.map((item) => item.skipped))].join(', '),
      ...(skipped.some((item) => item.unexpected) ? { unexpected: true } : {}),
    },
  };
}

/** The WhatsApp reply-button limit. */
const MAX_BUTTONS = 3;
/** The longest caption WhatsApp shows under a file. */
const MAX_CAPTION = 1024;
/** The longest footer a buttons message carries. */
const MAX_FOOTER = 60;

/**
 * WhatsApp through [Evolution API](https://doc.evolution-api.com) v2 (or a server with the same
 * routes). Point the instance's webhook — event `MESSAGES_UPSERT` — at the route, with the token:
 * `https://app.example.com/webhooks/whatsapp?token=<webhookToken>`.
 *
 * Reads `messages.upsert` (text, extended text, button and list replies, images, audio, video,
 * documents and stickers); ignores the instance's own messages (an item without `fromMe` counts as
 * incoming only with `status: 'received'`), broadcasts and (unless `groups`) groups. Sends with `POST {url}/message/sendText/{instance}`. Downloads media from the webhook's
 * inline `base64` (Evolution's "webhook base64" setting), else its `mediaUrl`, else
 * `POST {url}/chat/getBase64FromMediaMessage/{instance}`.
 */
export function evolutionApi(options: EvolutionApiOptions): ChannelAdapter {
  return evolutionFormatAdapter(options, { buttons: false, instructionWithButtons: true });
}

/**
 * The adapter for any server speaking Evolution's webhook and routes — `evolutionApi()` and
 * `whatsmiau()` differ only in their defaults. Internal.
 */
export function evolutionFormatAdapter(
  options: EvolutionApiOptions,
  defaults: {
    buttons: boolean;
    /**
     * Put the reply instruction in the buttons message too — for a server whose buttons may not
     * render (Evolution). Off where they render (Whatsmiau): the card shows the buttons alone.
     */
    instructionWithButtons: boolean;
  },
): ChannelAdapter {
  const name = options.name ?? 'whatsapp';
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const base = options.url.replace(/\/+$/, '');
  const instance = encodeURIComponent(options.instance);
  const headers = { apikey: options.apiKey };
  const buttons = options.buttons ?? defaults.buttons;
  const post = (path: string, body: unknown) =>
    postJson(name, fetcher, `${base}${path}/${instance}`, headers, body, timeoutMs);

  return {
    name,
    kind: 'whatsapp',
    capabilities: {
      ...(buttons ? { buttons: MAX_BUTTONS } : {}),
      // Lists ride the same interactive messages as the buttons: only where those render.
      ...(buttons ? { lists: 10 } : {}),
      markdown: 'whatsapp',
      maxLength: options.maxLength ?? 4096,
      media: true,
      maxCaptionLength: MAX_CAPTION,
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
      return readBody(body, options).messages;
    },

    ignored(body) {
      return readBody(body, options).ignored ?? null;
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
      if (message.media !== undefined) {
        const { media } = message;
        const source = media.url ?? media.data?.toString('base64');
        if (source === undefined) throw new Error(`${name}: a file needs a url or its data`);
        await post('/message/sendMedia', {
          number,
          mediatype: media.kind,
          media: source,
          ...(media.contentType !== undefined ? { mimetype: media.contentType } : {}),
          ...(message.text !== '' ? { caption: message.text.slice(0, MAX_CAPTION) } : {}),
          ...(media.kind === 'document' ? { fileName: mediaFilename(media) } : {}),
        });
        return;
      }
      if (message.list !== undefined) {
        if (buttons) {
          try {
            await post('/message/sendList', {
              number,
              title: (message.list.title ?? '').replace(/[*_~]/g, '').trim().slice(0, 60),
              description: message.text.trim() === '' ? '…' : message.text.slice(0, 1024),
              buttonText: message.list.button.slice(0, 20),
              footerText: '',
              sections: [
                {
                  title: (message.list.title ?? message.list.button)
                    .replace(/[*_~]/g, '')
                    .slice(0, 24),
                  rows: message.list.rows.slice(0, 10).map((row) => ({
                    title: row.title.slice(0, 24),
                    description: (row.description ?? '').slice(0, 72),
                    rowId: row.id,
                  })),
                },
              ],
            });
            return;
          } catch (error) {
            if (!(error instanceof ChannelDeliveryError) || !error.definite) throw error;
          }
        }
        await post('/message/sendText', { number, text: message.fallbackText });
        return;
      }
      if (message.buttons !== undefined && buttons) {
        const [first = '', ...rest] = message.text.split('\n');
        const title = first.replace(/[*_~]/g, '').trim();
        // Where buttons may not render, the reply instruction rides along: a phone that shows the
        // text but not the buttons can still answer by text.
        const instruction = defaults.instructionWithButtons
          ? (message.instruction?.trim() ?? '')
          : '';
        const description = [rest.join('\n').trim(), instruction]
          .filter((part) => part !== '')
          .join('\n\n');
        if (title.length <= 60 && description.length <= 1024 && message.buttons.length > 0) {
          try {
            await post('/message/sendButtons', {
              number,
              title,
              description: description === '' ? title : description,
              ...(message.footer !== undefined && message.footer.trim() !== ''
                ? { footer: message.footer.replace(/[*_~]/g, '').trim().slice(0, MAX_FOOTER) }
                : {}),
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
