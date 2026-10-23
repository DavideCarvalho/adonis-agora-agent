import type { Actor, ModelMessage, StoredMessage } from './types.js';

/**
 * When the person SENT each message, shown to the model — `messageTimestamps` in `config/agent.ts`.
 *
 * Without it the model only knows "now" (whatever the prompt says), so a "the feeding started just
 * now" read minutes later — a queued turn, a channel burst, a confirmation that came back late, or the
 * same fact reused three turns on — is taken as happening at the moment the model reads it. With it,
 * every user message in the history the model sees (old ones included) starts with a short label:
 * `[sent 2026-10-23T11:17-03:00] the feeding started just now`.
 *
 * Only the MODEL's view changes. The label is added while the turn reads its thread (inside the
 * `load:thread` checkpoint, so a durable replay reads back the same prompt); the stored content, what
 * `getThread` returns and what a UI shows are untouched. A `historyWindow` receives the messages
 * already labelled.
 */
export interface MessageTimestampsConfig {
  /**
   * The IANA time zone the label is written in (`'America/Sao_Paulo'`), or a function of the turn's
   * actor that picks one (the person's own zone). Default `'UTC'`. A zone `Intl` does not know falls
   * back to `'UTC'`.
   */
  timeZone?: string | ((actor: Actor) => string | undefined);
  /**
   * The label for one message, from its send time — put in front of its text, followed by a space.
   * Default {@link defaultMessageTimestampFormat}: `[sent 2026-10-23T11:17-03:00]`. Return `''` to
   * leave a message unlabelled. Must be a pure function of its arguments (it runs again for every turn
   * over the same stored data).
   */
  format?: (sentAt: Date, ctx: MessageTimestampContext) => string;
}

/** What {@link MessageTimestampsConfig.format} knows besides the instant. */
export interface MessageTimestampContext {
  actor: Actor;
  threadId: string;
  /** The zone resolved from {@link MessageTimestampsConfig.timeZone} (`'UTC'` when none). */
  timeZone: string;
  /** The message being labelled, as stored (its text unlabelled). */
  message: Pick<StoredMessage, 'role' | 'content'>;
}

function validTimeZone(zone: string | undefined): string {
  if (zone === undefined || zone.trim() === '') return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

/**
 * `[sent 2026-10-23T11:17-03:00]` — ISO 8601 to the minute, with the zone's offset (`Z` in UTC):
 * locale-neutral, and unambiguous to the model whatever language the conversation is in.
 */
export function defaultMessageTimestampFormat(
  sentAt: Date,
  ctx: Pick<MessageTimestampContext, 'timeZone'>,
): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: validTimeZone(ctx.timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(sentAt);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  // `GMT-03:00` → `-03:00`; a zero offset (`GMT`, `GMT+00:00`) → `Z`.
  const shift = part('timeZoneName').replace(/^GMT/, '');
  const offset = shift === '' || /^[+-]00:00$/.test(shift) ? 'Z' : shift;
  return `[sent ${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}${offset}]`;
}

/**
 * A message's send time: the one recorded with it (`sentAt` — a channel's provider timestamp, a
 * send that named one, the moment a queued send was queued), else when it was stored.
 */
export function messageSentAt(message: Pick<StoredMessage, 'sentAt' | 'createdAt'>): Date | null {
  for (const value of [message.sentAt, message.createdAt]) {
    if (value === undefined) continue;
    const at = new Date(value);
    if (!Number.isNaN(at.getTime())) return at;
  }
  return null;
}

/** Builds the per-turn labeller: resolves the zone once, then labels each user message. */
export function messageTimestampLabeller(
  config: MessageTimestampsConfig,
  turn: { actor: Actor; threadId: string },
): (stored: ModelMessage | StoredMessage, model: ModelMessage) => ModelMessage {
  const zone = validTimeZone(
    typeof config.timeZone === 'function' ? config.timeZone(turn.actor) : config.timeZone,
  );
  const format = config.format ?? defaultMessageTimestampFormat;
  return (stored, model) => {
    // A person's message, not the tool-results half of an exchange.
    if (model.role !== 'user' || (model.toolResults?.length ?? 0) > 0) return model;
    const sentAt = messageSentAt(stored as Partial<StoredMessage> as StoredMessage);
    if (sentAt === null) return model;
    const label = format(sentAt, {
      actor: turn.actor,
      threadId: turn.threadId,
      timeZone: zone,
      message: { role: model.role, content: model.content },
    });
    if (label === '') return model;
    return { ...model, content: model.content === '' ? label : `${label} ${model.content}` };
  };
}

/**
 * A send time as the store keeps it (ISO 8601), from what a caller handed over: a `Date`, an ISO
 * string or epoch milliseconds. `undefined` for anything unreadable; a time in the future (a client
 * clock ahead of ours) is taken as `now`.
 */
export function normalizeSentAt(
  value: Date | string | number | undefined | null,
  now: number = Date.now(),
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const at = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(at) || at <= 0) return undefined;
  return new Date(Math.min(at, now)).toISOString();
}
