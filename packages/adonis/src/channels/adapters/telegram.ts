import {
  ChannelDeliveryError,
  type ChannelFetch,
  postJson,
  record,
  safeEqual,
  str,
} from '../http.js';
import { unescapeTelegramMarkdown } from '../markdown.js';
import type { ChannelAdapter, ChannelRequest, InboundMessage, OutboundMessage } from '../types.js';

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
 * Reads text messages and inline-keyboard presses (`callback_query`, answered with
 * `answerCallbackQuery` and the keyboard removed so it cannot be pressed twice); ignores bots and
 * (unless `groups`) group chats. Sends `sendMessage` in MarkdownV2 — when Telegram refuses the
 * formatting, the same text goes again as plain text.
 */
export function telegram(options: TelegramOptions): ChannelAdapter {
  const name = options.name ?? 'telegram';
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const markdown = options.markdown !== false;
  const api = `${(options.apiUrl ?? 'https://api.telegram.org').replace(/\/+$/, '')}/bot${options.botToken}`;
  const call = (method: string, body: unknown) =>
    postJson(name, fetcher, `${api}/${method}`, {}, body, timeoutMs);
  const privateOnly = (chat: Record<string, unknown> | undefined) =>
    options.groups === true || chat?.type === 'private';

  return {
    name,
    capabilities: {
      buttons: MAX_BUTTONS,
      markdown: markdown ? 'telegram' : 'none',
      maxLength: MAX_TEXT,
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
        const text = str(message.text)?.trim();
        if (!chat || !from || from.is_bot === true || !privateOnly(chat) || !text) return null;
        return { id, from: String(from.id), conversation: String(chat.id), text, raw: update };
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

    async send(conversation: string, message: OutboundMessage) {
      const body = {
        chat_id: conversation,
        text: message.text,
        link_preview_options: { is_disabled: true },
        ...(message.buttons !== undefined && message.buttons.length > 0
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
        await call('sendMessage', { ...body, text: unescapeTelegramMarkdown(message.text) });
      }
    },
  };
}
