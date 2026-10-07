/**
 * The contract between a text channel (WhatsApp, Telegram, …) and the agent: what an adapter reads
 * off a webhook and what it is asked to deliver. Framework-free — `channels.handle()` builds the
 * {@link ChannelRequest} from Adonis's `HttpContext`, and a test builds one by hand.
 */

/** The markdown a channel renders: WhatsApp's, Telegram's MarkdownV2, or none (plain text). */
export type ChannelMarkdown = 'whatsapp' | 'telegram' | 'none';

/** What a channel can show — what the service shapes every reply to. */
export interface ChannelCapabilities {
  /**
   * The most reply buttons one message can carry. Omitted (or below 2) → the channel has none, and a
   * proposal is put to the person as a text instruction instead of Confirm/Cancel buttons.
   */
  buttons?: number;
  /** The markdown dialect replies are converted to. */
  markdown: ChannelMarkdown;
  /** The longest text one message may carry; longer replies are split into several messages. */
  maxLength: number;
}

/** One webhook request, as an adapter sees it. */
export interface ChannelRequest {
  /** Upper-case HTTP method. */
  method: string;
  /** Path and query string, e.g. `/webhooks/whatsapp?hub.mode=subscribe`. */
  url: string;
  /** A request header by (case-insensitive) name. */
  header(name: string): string | undefined;
  /** Route params (`/webhooks/whatsapp/:token` → `{ token }`). */
  params: Record<string, unknown>;
  /** The parsed body. */
  body: unknown;
  /**
   * The body exactly as it arrived — what a signature is computed over. `null` when the body parser
   * did not keep it (a request it does not parse).
   */
  rawBody: string | null;
}

/** A message a person sent on the channel. */
export interface InboundMessage {
  /** The provider's id for this message — retries of one delivery carry the same id. */
  id: string;
  /** Who sent it: a phone number, a Telegram user id… — what `actor()` maps to an account. */
  from: string;
  /** Where replies go: the chat / conversation id {@link ChannelAdapter.send} is called with. */
  conversation: string;
  /** What the person wrote — for a button press, the button's label (or its id when there is none). */
  text: string;
  /** The id of the reply button the person pressed, when the message is a button press. */
  buttonId?: string;
  /** The provider's payload, untouched. */
  raw: unknown;
}

export interface ChannelButton {
  /** What comes back as {@link InboundMessage.buttonId} when it is pressed. */
  id: string;
  label: string;
}

/** One message to deliver: text, or text with reply buttons. */
export type OutboundMessage =
  | { text: string; buttons?: undefined; fallbackText?: undefined }
  | {
      text: string;
      buttons: ChannelButton[];
      /**
       * The same message as text only — a reply instruction in place of the buttons. What an adapter
       * sends when the provider definitely refused the buttons (a 4xx), so the person still gets a
       * way to answer.
       */
      fallbackText: string;
    };

/** A reply the adapter answers the webhook with instead of acknowledging it (a verification GET). */
export interface ChannelChallengeResponse {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * One text channel. The built-in ones are `evolutionApi()`, `whatsappCloud()` and `telegram()`; any
 * object of this shape works the same way.
 */
export interface ChannelAdapter {
  /** Names the channel: the dedupe key's prefix, and `via` on a decision made with its buttons. */
  readonly name: string;
  readonly capabilities: ChannelCapabilities;
  /**
   * Answer a request that is not a message — WhatsApp Cloud's `GET ?hub.challenge=…` subscription
   * check. `null` → not one of those; the request goes on to {@link verify}.
   */
  challenge?(request: ChannelRequest): ChannelChallengeResponse | null;
  /** Is this request really from the provider (a signature, a shared token)? `false` → `401`. */
  verify(request: ChannelRequest): boolean | Promise<boolean>;
  /**
   * The person's message(s) in a verified webhook body. `null` (or `[]`) → nothing to answer: a
   * delivery receipt, the bot's own message, a group, a media message…
   */
  parse(body: unknown): InboundMessage | InboundMessage[] | null;
  /**
   * Tell the provider the message was received, where it waits for that — Telegram's
   * `answerCallbackQuery` after a button press. Runs in the background, before the turn.
   */
  acknowledge?(message: InboundMessage): Promise<void>;
  /** Deliver one message to a conversation. Throws when the provider refused it. */
  send(conversation: string, message: OutboundMessage): Promise<void>;
}
