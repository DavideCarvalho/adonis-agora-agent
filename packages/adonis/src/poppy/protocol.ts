import { createHash, randomBytes } from 'node:crypto';

/**
 * The wire format of Personal Agent Protocol ("Poppy", Draft 0.1, §7) conversations: messages,
 * events, statuses and the error codes of §7.13. Hand-rolled like the A2A surface — the rules are
 * few and exact, and unknown fields are ignored everywhere (§3.1, §3.3).
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */

/** The `protocol_version` this surface implements. */
export const POPPY_PROTOCOL_VERSION = '0.1';

/** The `type` of this surface's entry in `poppy.json` `agent.protocols` (§7.1). */
export const POPPY_PROTOCOL_TYPE = 'poppy';

/** The account scopes the protocol defines (§4.4). Companies may add their own. */
export const POPPY_READ_SCOPE = 'poppy:read';
export const POPPY_WRITE_SCOPE = 'poppy:write';

export type PoppyStatus = 'working' | 'idle' | 'queued' | 'closed';
export type PoppyResponder = 'agent' | 'human';
export type PoppySender = 'agent' | 'human';

/** Facts about the User's situation (§7.4). Other fields are kept as sent. */
export interface PoppyContext {
  locale?: string;
  time_zone?: string;
  user_available?: boolean;
  [field: string]: unknown;
}

/** A message as the Personal Agent sends it (§7.4). */
export interface PoppyInboundMessage {
  id: string;
  sender: PoppySender;
  text?: string;
  data?: Record<string, unknown>;
  context?: PoppyContext;
}

/** A message as it appears in a `message` event (§7.5): `role` says which side it came from. */
export interface PoppyEventMessage {
  id: string;
  role: 'user' | 'company';
  sender: PoppySender;
  text?: string;
  data?: Record<string, unknown>;
  context?: PoppyContext;
}

export type PoppyEventType =
  | 'message'
  | 'state'
  | 'authorization'
  | 'user_requested'
  | 'direct_opened'
  | 'direct_closed';

/** One event of a conversation (§7.5): `id`, `type`, `created_at`, and the type's own fields. */
export interface PoppyEvent {
  id: string;
  type: PoppyEventType | (string & {});
  created_at: string;
  [field: string]: unknown;
}

/** The type-specific fields of a new event — what the store appends. */
export type PoppyEventBody =
  | { type: 'message'; message: PoppyEventMessage }
  | { type: 'state'; status: PoppyStatus; responder: PoppyResponder }
  | { type: 'authorization'; error: 'sign_in_required' | 'insufficient_scope'; scope?: string }
  | { type: 'user_requested'; reason: string }
  | { type: 'direct_opened' | 'direct_closed'; conversation_id: string };

/** The conversation errors of §7.13, plus the request errors this surface answers. */
const ERRORS = {
  conversation_not_found: 404,
  conversation_closed: 409,
  direct_conversation_open: 409,
  message_id_conflict: 409,
  invalid_cursor: 400,
  cursor_expired: 410,
  invalid_request: 400,
  /** §3.3 — a request handled only with an extension the Personal Agent does not list. */
  extension_required: 403,
  sign_in_required: 403,
  not_found: 404,
  method_not_allowed: 405,
  request_too_large: 413,
  not_implemented: 501,
  server_error: 500,
} as const;

export type PoppyErrorCode = keyof typeof ERRORS;

/**
 * A Poppy error, answered as `{ "error": code, … }` like an OAuth error response (§7.13). `extra`
 * carries what a code adds — `conversation_id` for `direct_conversation_open`, `extension` for
 * `extension_required`. An app hook may throw one to refuse a request.
 */
export class PoppyError extends Error {
  constructor(
    readonly code: PoppyErrorCode,
    description?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(description ?? code);
    this.name = 'PoppyError';
  }

  get status(): number {
    return ERRORS[this.code];
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      ...(this.message !== this.code ? { error_description: this.message } : {}),
      ...this.extra,
    };
  }
}

/** IDs are 1–256 characters of the URL-safe base64 alphabet (§7.2). */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export function isPoppyId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/** A new id of `kind` — `cnv_…`, `msg_…`, `evt_…`. */
export function newPoppyId(prefix: 'cnv' | 'msg'): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

/** A stable id derived from `seed` — what lets a re-read turn produce the same company message. */
export function derivedPoppyId(prefix: 'msg', seed: string): string {
  return `${prefix}_${createHash('sha256').update(seed).digest('base64url').slice(0, 22)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A validated `POST {endpoint}` / `POST {endpoint}/{id}/messages` body. */
export interface PoppySendBody {
  message: PoppyInboundMessage;
  /** Only on `POST {endpoint}`: start a Direct Conversation under this one (§7.10). */
  parentConversationId?: string;
}

/**
 * Parse a message request (§7.3, §7.4). Unknown fields — on the body, the message or its context —
 * are ignored, never refused (§3.3). Only the fields the protocol defines are kept.
 */
export function parseSendBody(raw: string, opts: { allowParent: boolean }): PoppySendBody {
  let body: unknown;
  try {
    body = raw.trim() === '' ? undefined : JSON.parse(raw);
  } catch {
    throw new PoppyError('invalid_request', 'The request body is not valid JSON');
  }
  if (!isRecord(body) || !isRecord(body.message)) {
    throw new PoppyError('invalid_request', 'message is required');
  }
  const message = body.message;
  if (!isPoppyId(message.id)) {
    throw new PoppyError('invalid_request', 'message.id must be 1-256 URL-safe base64 characters');
  }
  if (message.sender !== 'agent' && message.sender !== 'human') {
    throw new PoppyError('invalid_request', 'message.sender must be "agent" or "human"');
  }
  if (message.text !== undefined && typeof message.text !== 'string') {
    throw new PoppyError('invalid_request', 'message.text must be a string');
  }
  if (message.data !== undefined && !isRecord(message.data)) {
    throw new PoppyError('invalid_request', 'message.data must be a JSON object');
  }
  if (message.context !== undefined && !isRecord(message.context)) {
    throw new PoppyError('invalid_request', 'message.context must be a JSON object');
  }
  if (message.text === undefined && message.data === undefined && message.context === undefined) {
    throw new PoppyError('invalid_request', 'A message needs text, data or context');
  }
  const context = message.context as PoppyContext | undefined;
  if (context !== undefined) {
    if (context.locale !== undefined && typeof context.locale !== 'string') {
      throw new PoppyError('invalid_request', 'context.locale must be a string');
    }
    if (context.time_zone !== undefined && typeof context.time_zone !== 'string') {
      throw new PoppyError('invalid_request', 'context.time_zone must be a string');
    }
    if (context.user_available !== undefined && typeof context.user_available !== 'boolean') {
      throw new PoppyError('invalid_request', 'context.user_available must be a boolean');
    }
  }

  let parentConversationId: string | undefined;
  if (opts.allowParent && body.parent_conversation_id !== undefined) {
    if (!isPoppyId(body.parent_conversation_id)) {
      throw new PoppyError('conversation_not_found', 'Unknown parent_conversation_id');
    }
    parentConversationId = body.parent_conversation_id;
  }

  return {
    message: {
      id: message.id,
      sender: message.sender,
      ...(message.text !== undefined ? { text: message.text as string } : {}),
      ...(message.data !== undefined ? { data: message.data as Record<string, unknown> } : {}),
      ...(context !== undefined ? { context: { ...context } } : {}),
    },
    ...(parentConversationId !== undefined ? { parentConversationId } : {}),
  };
}

/** Stable JSON: object keys sorted, so equal content hashes equally whatever its key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The fingerprint a retry is compared by (§7.3): the message's content and, for a first message,
 * the conversation it was addressed to. Unknown fields were dropped by the parser, so a retry that
 * adds one is still the same message.
 */
export function messageFingerprint(target: string, body: PoppySendBody): string {
  return createHash('sha256')
    .update(canonical({ target, parent: body.parentConversationId ?? null, ...body.message }))
    .digest('base64url');
}

/**
 * A request body that must be an empty JSON object (handoff, close) — anything else is tolerated:
 * extensions may add fields (§3.3). Only malformed JSON is refused.
 */
export function parseEmptyBody(raw: string): void {
  if (raw.trim() === '') return;
  try {
    JSON.parse(raw);
  } catch {
    throw new PoppyError('invalid_request', 'The request body is not valid JSON');
  }
}
