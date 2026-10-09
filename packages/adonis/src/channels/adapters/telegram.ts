import {
  ChannelDeliveryError,
  type ChannelFetch,
  ChannelMediaTooLargeError,
  fetchBytes,
  mediaFilename,
  postForm,
  postJson,
  record,
  safeEqual,
  sizeOf,
  str,
} from '../http.js';
import { unescapeTelegramMarkdown } from '../markdown.js';
import type {
  ChannelAdapter,
  ChannelRequest,
  InboundMedia,
  InboundMessage,
  OutboundMedia,
  OutboundMessage,
} from '../types.js';

const FILE_METHODS: Record<OutboundMedia['kind'], [string, string]> = {
  image: ['sendPhoto', 'photo'],
  document: ['sendDocument', 'document'],
  audio: ['sendAudio', 'audio'],
  video: ['sendVideo', 'video'],
};
/** The longest caption Telegram takes. */
const MAX_CAPTION = 1024;

export interface TelegramOptions {
  /** The bot's token from @BotFather. */
  botToken: string;
  /**
   * The `secret_token` given to `setWebhook`: Telegram sends it back as
   * `X-Telegram-Bot-Api-Secret-Token` on every update, and a request without it is refused.
   */
  secretToken: string;
  /** Format replies as MarkdownV2 (`true`, default) or send plain text (`false`). */
  markdown?: boolean;
  /** Answer in groups and supergroups too. Default `false`: private chats only. */
  groups?: boolean;
  /** The adapter's name — the dedupe prefix and the decision's `via`. Default `'telegram'`. */
  name?: string;
  /** Per-request timeout. Default 20 s. */
  timeoutMs?: number;
  /** Bot API origin. Default `https://api.telegram.org` (a self-hosted Bot API server goes here). */
  apiUrl?: string;
  fetch?: ChannelFetch;
}

/** Telegram's limits: message text, buttons we put in one keyboard. */
const MAX_TEXT = 4096;
const MAX_BUTTONS = 8;
/** Entries of a list, as an inline keyboard of one button per row. */
const MAX_LIST_ROWS = 30;

/** The file a message carries: the largest photo size, a document, a voice note, audio, video, a sticker. */
function mediaOf(message: Record<string, unknown>): InboundMedia | undefined {
  const photo = Array.isArray(message.photo) ? record(message.photo.at(-1)) : undefined;
  const candidates: [
    InboundMedia['kind'],
    Record<string, unknown> | undefined,
    string | undefined,
  ][] = [
    ['image', photo, 'image/jpeg'],
    ['document', record(message.document), undefined],
    ['audio', record(message.voice), 'audio/ogg'],
    ['audio', record(message.audio), undefined],
    ['video', record(message.video), 'video/mp4'],
    ['video', record(message.video_note), 'video/mp4'],
    [
      'sticker',
      record(message.sticker),
      record(message.sticker)?.is_animated === true
        ? 'application/x-tgsticker'
        : record(message.sticker)?.is_video === true
          ? 'video/webm'
          : 'image/webp',
    ],
  ];
  for (const [kind, body, implied] of candidates) {
    const fileId = str(body?.file_id);
    if (!body || fileId === undefined) continue;
    const contentType = str(body.mime_type) ?? implied;
    const filename = str(body.file_name);
    const sizeBytes = sizeOf(body.file_size);
    return {
      kind,
      ref: fileId,
      ...(contentType !== undefined ? { contentType } : {}),
      ...(filename !== undefined ? { filename } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    };
  }
  return undefined;
}

/** The label of the inline button with `data` on the message it was pressed on. */
function pressedLabel(message: Record<string, unknown> | undefined, data: string) {
  const rows = record(message?.reply_markup)?.inline_keyboard;
  if (!Array.isArray(rows)) return undefined;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const button of row) {
      if (record(button)?.callback_data === data) return str(record(button)?.text);
    }
  }
  return undefined;
}

/**
 * A Telegram bot over the [Bot API](https://core.telegram.org/bots/api) webhook. Register it with
 * `setWebhook({ url, secret_token, allowed_updates: ['message', 'callback_query'] })`.
 *
 * Reads text messages, media (photos, documents, voice notes, audio, video, stickers — downloaded
 * with `getFile`, which serves up to 20 MB) and inline-keyboard presses (`callback_query`, answered with
 * `answerCallbackQuery` and the keyboard removed so it cannot be pressed twice); ignores bots and
 * (unless `groups`) group chats. Sends `sendMessage` in MarkdownV2 — when Telegram refuses the
 * formatting, the same text goes again as plain text. Files go with `sendPhoto` / `sendDocument` /
 * `sendAudio` / `sendVideo` (by URL, or uploaded as `multipart/form-data` when given as bytes).
 */
export function telegram(options: TelegramOptions): ChannelAdapter {
  const name = options.name ?? 'telegram';
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const markdown = options.markdown !== false;
  const origin = (options.apiUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
  const api = `${origin}/bot${options.botToken}`;
  const call = (method: string, body: unknown) =>
    postJson(name, fetcher, `${api}/${method}`, {}, body, timeoutMs);
  /** `sendPhoto` / `sendDocument` / `sendAudio` / `sendVideo`, by URL or uploaded. */
  const sendFile = async (chatId: string, media: OutboundMedia, caption: string) => {
    const [method, field] = FILE_METHODS[media.kind];
    const formatted = caption !== '' && markdown ? { parse_mode: 'MarkdownV2' } : {};
    const send = (text: string, format: Record<string, string>) => {
      if (media.url !== undefined)
        return call(method, {
          chat_id: chatId,
          [field]: media.url,
          ...(text !== '' ? { caption: text, ...format } : {}),
        });
      if (media.data === undefined) throw new Error(`${name}: a file needs a url or its data`);
      return postForm(
        name,
        fetcher,
        `${api}/${method}`,
        {},
        {
          chat_id: chatId,
          ...(text !== '' ? { caption: text, ...format } : {}),
          [field]: {
            data: media.data,
            contentType: media.contentType ?? 'application/octet-stream',
            filename: mediaFilename(media),
          },
        },
        timeoutMs,
      );
    };
    try {
      await send(caption, formatted);
    } catch (error) {
      if (!('parse_mode' in formatted)) throw error;
      if (!(error instanceof ChannelDeliveryError) || error.status !== 400) throw error;
      await send(unescapeTelegramMarkdown(caption), {});
    }
  };
  const privateOnly = (chat: Record<string, unknown> | undefined) =>
    options.groups === true || chat?.type === 'private';

  return {
    name,
    kind: 'telegram',
    capabilities: {
      buttons: MAX_BUTTONS,
      lists: MAX_LIST_ROWS,
      markdown: markdown ? 'telegram' : 'none',
      maxLength: MAX_TEXT,
      media: true,
      maxCaptionLength: MAX_CAPTION,
    },

    verify(request: ChannelRequest) {
      return safeEqual(request.header('x-telegram-bot-api-secret-token'), options.secretToken);
    },

    parse(body) {
      const update = record(body);
      const updateId = update?.update_id;
      if (typeof updateId !== 'number' && typeof updateId !== 'string') return null;
      const id = String(updateId);
      const message = record(update?.message);
      if (message) {
        const chat = record(message.chat);
        const from = record(message.from);
        const media = mediaOf(message);
        const text = (str(message.text) ?? str(message.caption) ?? '').trim();
        if (!chat || !from || from.is_bot === true || !privateOnly(chat)) return null;
        if (text === '' && !media) return null;
        return {
          id,
          from: String(from.id),
          conversation: String(chat.id),
          text,
          ...(media ? { media: [media] } : {}),
          raw: update,
        };
      }
      const query = record(update?.callback_query);
      if (query) {
        const from = record(query.from);
        const pressedOn = record(query.message);
        const chat = record(pressedOn?.chat);
        const data = str(query.data);
        if (!from || !chat || !data || from.is_bot === true || !privateOnly(chat)) return null;
        return {
          id,
          from: String(from.id),
          conversation: String(chat.id),
          text: pressedLabel(pressedOn, data) ?? data,
          buttonId: data,
          raw: update,
        };
      }
      return null;
    },

    async acknowledge(message: InboundMessage) {
      const query = record(record(message.raw)?.callback_query);
      const queryId = str(query?.id);
      if (queryId === undefined) return;
      await call('answerCallbackQuery', { callback_query_id: queryId }).catch(() => {});
      const pressedOn = record(query?.message);
      if (pressedOn?.message_id !== undefined) {
        await call('editMessageReplyMarkup', {
          chat_id: message.conversation,
          message_id: pressedOn.message_id,
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
      }
    },

    async download(media: InboundMedia, { maxBytes }) {
      if (media.sizeBytes !== undefined && media.sizeBytes > maxBytes) {
        throw new ChannelMediaTooLargeError(maxBytes);
      }
      const answer = record(await call('getFile', { file_id: media.ref }));
      const path = str(record(answer?.result)?.file_path);
      if (path === undefined) {
        // The Bot API serves files up to 20 MB; a larger one has no path.
        throw new ChannelDeliveryError(name, null, `${name}: the file could not be downloaded`);
      }
      const file = await fetchBytes(
        name,
        fetcher,
        `${origin}/file/bot${options.botToken}/${path}`,
        {},
        timeoutMs,
        maxBytes,
      );
      return {
        data: file.data,
        contentType: media.contentType ?? file.contentType ?? 'application/octet-stream',
        ...(media.filename !== undefined ? { filename: media.filename } : {}),
      };
    },

    async send(conversation: string, message: OutboundMessage) {
      if (message.media !== undefined) {
        await sendFile(conversation, message.media, message.text.slice(0, MAX_CAPTION));
        return;
      }
      // Telegram has no footer: it goes under the text.
      const text =
        message.footer !== undefined && message.footer.trim() !== ''
          ? `${message.text}\n\n${message.footer}`
          : message.text;
      const body = {
        chat_id: conversation,
        text,
        link_preview_options: { is_disabled: true },
        ...(message.list !== undefined
          ? {
              // A list is a keyboard of one button per entry (Telegram has no list message).
              reply_markup: {
                inline_keyboard: message.list.rows.slice(0, MAX_LIST_ROWS).map((row) => [
                  {
                    text:
                      row.description !== undefined && row.description !== ''
                        ? `${row.title} — ${row.description}`.slice(0, 64)
                        : row.title.slice(0, 64),
                    callback_data: row.id,
                  },
                ]),
              },
            }
          : message.buttons !== undefined && message.buttons.length > 0
            ? {
                reply_markup: {
                  inline_keyboard: [
                    message.buttons
                      .slice(0, MAX_BUTTONS)
                      .map((button) => ({ text: button.label, callback_data: button.id })),
                  ],
                },
              }
            : {}),
      };
      if (!markdown) {
        await call('sendMessage', body);
        return;
      }
      try {
        await call('sendMessage', { ...body, parse_mode: 'MarkdownV2' });
      } catch (error) {
        // "can't parse entities": the same words, unformatted, beat no answer.
        if (!(error instanceof ChannelDeliveryError) || error.status !== 400) throw error;
        await call('sendMessage', { ...body, text: unescapeTelegramMarkdown(text) });
      }
    },
  };
}
