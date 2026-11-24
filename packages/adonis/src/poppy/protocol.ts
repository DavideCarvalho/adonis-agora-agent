import { createHash, randomBytes } from 'node:crypto';

/**
 * The wire format of Personal Agent Protocol ("Poppy", version 1.0, §8) conversations: requests,
 * messages, events, the conversation state and the error codes of §8.13. Hand-rolled like the A2A
 * surface — the rules are few and exact, and unknown fields are ignored everywhere (§3.1, §3.3).
 *
 * @experimental Implements Personal Agent Protocol 1.0 (https://personalagentprotocol.org/docs/1.0/spec).
 * The surface may still change between minor releases of this package while it settles.
 */

/** The `protocol_version` this surface implements (§3.1). */
export const POPPY_PROTOCOL_VERSION = '1.0';

/** The `type` of this surface's entry in `poppy.json` `agent.protocols` (§8.1). */
export const POPPY_PROTOCOL_TYPE = 'poppy';

/** `handoff` of the conversation state (§8.7): `pending` while the Company looks for a person. */
export type PoppyHandoff = 'none' | 'pending';
/** `responder` of the conversation state (§8.7): who handles the Company side. */
export type PoppyResponder = 'agent' | 'human';
export type PoppyAuthorType = 'agent' | 'human';

/** The four state fields every read reports (§8.7), each independent of the others. */
export interface PoppyState {
  /** The Company is still replying: a request accepted but not acted on, or a reply being written. */
  working: boolean;
  handoff: PoppyHandoff;
  responder: PoppyResponder;
  /** The conversation takes no more messages (§8.12). */
  closed: boolean;
}

/** Who wrote a message (§8.4). Only Company messages have `id`, `name` and `image`. */
export interface PoppyAuthor {
  type: PoppyAuthorType;
  id?: string;
  name?: string;
  image?: string;
}

/**
 * Facts about the User's situation (§8.4). Other fields are kept as sent; a field set to `null`
 * clears it.
 */
export interface PoppyContext {
  locale?: string | null;
  time_zone?: string | null;
  user_available?: boolean | null;
  [field: string]: unknown;
}

/** A message as the Personal Agent sends it (§8.4). Its ID is its request's ID (§8.3). */
export interface PoppyInboundMessage {
  author: { type: PoppyAuthorType };
  text?: string;
  data?: Record<string, unknown>;
  context?: PoppyContext;
  /** The last cursor the Personal Agent had read when it wrote the message — a hint (§8.4). */
  as_of_cursor?: string;
  /**
   * Content defined by extensions, keyed by extension name (§8.4). Only the extensions this surface
   * supports and the request declares are kept (`operations`); the rest is ignored (§3.3).
   */
  extensions?: Record<string, unknown>;
}

/** A message as it appears in a `message` event (§8.5): `role` says which side it came from. */
export interface PoppyEventMessage {
  id: string;
  role: 'user' | 'company';
  author: PoppyAuthor;
  /** On a Company Agent message: the latest request it took into account — a hint (§8.4). */
  as_of_request?: string;
  as_of_cursor?: string;
  text?: string;
  data?: Record<string, unknown>;
  context?: PoppyContext;
  /** Content defined by extensions, keyed by extension name (§8.4). */
  extensions?: Record<string, unknown>;
}

/** The Links extension (version 1): a page a Company message refers to. */
export interface PoppyLink {
  /** The page's HTTPS URL. */
  url: string;
  /** The page's name, as the message refers to it. */
  title?: string;
}

/** The Disclosures extension (version 1): a notice that matters whatever else the message says. */
export interface PoppyDisclosure {
  text: string;
}

/**
 * What a Company message can carry besides its text and data — sent as `extensions.links` and
 * `extensions.disclosures` to a Personal Agent that declares those extensions; otherwise put in the
 * text, so a disclosure always reaches the User.
 */
export interface PoppyMessageAddons {
  links?: PoppyLink[];
  disclosures?: PoppyDisclosure[];
}

/** The versions of the message extensions this surface speaks. */
export const POPPY_LINKS_VERSION = '1';
export const POPPY_DISCLOSURES_VERSION = '1';

export type PoppyEventType =
  | 'message'
  | 'state'
  | 'authorization'
  | 'user_requested'
  | 'direct_opened'
  | 'direct_closed';

/** One event of a conversation (§8.5): `id`, `type`, `created_at`, and the type's own fields. */
export interface PoppyEvent {
  id: string;
  type: PoppyEventType | (string & {});
  created_at: string;
  [field: string]: unknown;
}

/** The type-specific fields of a new event — what the store appends. */
export type PoppyEventBody =
  | { type: 'message'; message: PoppyEventMessage }
  | { type: 'state'; handoff: PoppyHandoff; responder: PoppyResponder; closed: boolean }
  | { type: 'authorization'; error: 'insufficient_scope'; scope: string }
  | { type: 'user_requested'; reason: string }
  | { type: 'direct_opened' | 'direct_closed'; conversation_id: string };

/** The conversation errors of §8.13, plus the request errors this surface answers. */
const ERRORS = {
  conversation_not_found: 404,
  conversation_closed: 409,
  direct_conversation_open: 409,
  request_id_conflict: 409,
  invalid_cursor: 400,
  cursor_expired: 410,
  invalid_request: 400,
  /** §3.3 — a request handled only with an extension the Personal Agent does not declare. */
  extension_required: 403,
  /** §3.4 — `Poppy-Version` missing, or not compatible with a version this Company serves. */
  version_unsupported: 400,
  /** §8.2 — the conversation started in other versions and is not continued in these. */
  version_mismatch: 409,
  /** Answered as a challenge without an error code (§7): the request needs the account. */
  account_required: 401,
  not_found: 404,
  method_not_allowed: 405,
  request_too_large: 413,
  not_implemented: 501,
  server_error: 500,
} as const;

export type PoppyErrorCode = keyof typeof ERRORS;

/**
 * A Poppy error, answered as `{ "error": code, … }` like an OAuth error response (§8.13). `extra`
 * carries what a code adds — `conversation_id` for `direct_conversation_open`, `extension` for
 * `extension_required`, `protocol_version` for `version_mismatch`. An app hook may throw one to
 * refuse a request.
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

/** IDs are 1–256 characters of the URL-safe base64 alphabet (§8.2). */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export function isPoppyId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/** A new id of `kind` — `cnv_…`, `msg_…`. */
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

/** A protocol version as `major.minor` (§3.1). */
const VERSION_PATTERN = /^(\d{1,4})\.(\d{1,4})$/;

/**
 * Whether `version` (a `Poppy-Version` value) is compatible with the version this surface serves
 * (§3.4): from 1.0, the same major version.
 */
export function isCompatiblePoppyVersion(
  version: string | null | undefined,
  served: string = POPPY_PROTOCOL_VERSION,
): boolean {
  const asked = VERSION_PATTERN.exec(version?.trim() ?? '');
  const ours = VERSION_PATTERN.exec(served);
  if (!asked || !ours) return false;
  if (Number(asked[1]) !== Number(ours[1])) return false;
  // Before 1.0, the minor version too.
  return Number(ours[1]) >= 1 || Number(asked[2]) === Number(ours[2]);
}

/**
 * The extensions a `Poppy-Extensions` header declares (§3.4): an RFC 9651 List of Strings, each
 * with its version in the `v` parameter — `{ name: version }`. A header that fails to parse
 * declares none.
 */
export function parsePoppyExtensions(header: string | undefined): Record<string, string> {
  if (header === undefined || header.trim() === '') return {};
  const out: Record<string, string> = {};
  const member =
    /^\s*"((?:[^"\\]|\\.)*)"((?:\s*;\s*[a-z*][a-z0-9_.*-]*(?:=(?:"(?:[^"\\]|\\.)*"|[^,;\s]+))?)*)\s*$/;
  for (const item of splitList(header)) {
    const match = member.exec(item);
    if (!match) return {};
    const name = (match[1] ?? '').replace(/\\(.)/g, '$1');
    let version: string | undefined;
    for (const param of (match[2] ?? '').split(';').slice(1)) {
      const [key = '', raw = ''] = param.trim().split(/=(.*)/s);
      if (key === 'v') {
        version = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw;
      }
    }
    if (name !== '' && version !== undefined) out[name] = version;
  }
  return out;
}

/** Split an RFC 9651 list on its top-level commas (outside quoted strings). */
function splitList(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quoted && char === '\\') {
      current += char + (value[i + 1] ?? '');
      i++;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === ',' && !quoted) {
      items.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  items.push(current);
  return items;
}

/**
 * Links and disclosures checked for a Company message: a link needs an HTTPS `url`, a disclosure
 * its `text` (Links §3, Disclosures §3). Throws on anything else — it is the app's own input.
 */
export function checkPoppyAddons(addons: PoppyMessageAddons): PoppyMessageAddons {
  const links = (addons.links ?? []).map((link) => {
    let url: URL;
    try {
      url = new URL(link.url);
    } catch {
      throw new TypeError(`poppy: a link needs an absolute URL, got ${JSON.stringify(link.url)}`);
    }
    if (url.protocol !== 'https:') {
      throw new TypeError(`poppy: a link must be an HTTPS URL, got ${JSON.stringify(link.url)}`);
    }
    return {
      url: link.url,
      ...(typeof link.title === 'string' && link.title !== '' ? { title: link.title } : {}),
    };
  });
  const disclosures = (addons.disclosures ?? []).map((disclosure) => {
    if (typeof disclosure?.text !== 'string' || disclosure.text.trim() === '') {
      throw new TypeError('poppy: a disclosure needs its text');
    }
    return { text: disclosure.text };
  });
  return {
    ...(links.length > 0 ? { links } : {}),
    ...(disclosures.length > 0 ? { disclosures } : {}),
  };
}

/** A validated `POST {endpoint}` / `POST {endpoint}/{id}/messages` body (§8.3). */
export interface PoppySendBody {
  /** The request ID, chosen by the Personal Agent — also its message's ID. */
  id: string;
  /** Absent only when accepting a `user_requested` event (§8.10). */
  message?: PoppyInboundMessage;
  /** Only on `POST {endpoint}`: start a Direct Conversation under this one (§8.10). */
  parentConversationId?: string;
  /** Only with `parentConversationId`: the `user_requested` event this accepts (§8.10). */
  userRequestedEventId?: string;
}

/** A validated handoff, handoff-cancel or close body: only its request ID (§8.9, §8.12). */
export interface PoppyRequestBody {
  id: string;
}

function parseJson(raw: string): Record<string, unknown> {
  let body: unknown;
  try {
    body = raw.trim() === '' ? undefined : JSON.parse(raw);
  } catch {
    throw new PoppyError('invalid_request', 'The request body is not valid JSON');
  }
  if (!isRecord(body)) throw new PoppyError('invalid_request', 'The body must be a JSON object');
  return body;
}

function requestId(body: Record<string, unknown>): string {
  if (!isPoppyId(body.id)) {
    throw new PoppyError('invalid_request', 'id must be 1-256 URL-safe base64 characters');
  }
  return body.id;
}

function parseMessage(raw: unknown): PoppyInboundMessage {
  if (!isRecord(raw)) throw new PoppyError('invalid_request', 'message must be a JSON object');
  const message = raw;
  // `id`, `role` and the author's `id`, `name` and `image` are ignored if sent (§8.4).
  const author = isRecord(message.author) ? message.author : undefined;
  if (typeof author?.type !== 'string' || author.type === '') {
    throw new PoppyError('invalid_request', 'message.author.type is required');
  }
  // An author type this version does not define is an agent's (§8.4).
  const authorType: PoppyAuthorType = author.type === 'human' ? 'human' : 'agent';
  if (message.text !== undefined && typeof message.text !== 'string') {
    throw new PoppyError('invalid_request', 'message.text must be a string');
  }
  if (message.data !== undefined && !isRecord(message.data)) {
    throw new PoppyError('invalid_request', 'message.data must be a JSON object');
  }
  if (message.context !== undefined && !isRecord(message.context)) {
    throw new PoppyError('invalid_request', 'message.context must be a JSON object');
  }
  if (message.extensions !== undefined && !isRecord(message.extensions)) {
    throw new PoppyError('invalid_request', 'message.extensions must be a JSON object');
  }
  if (
    message.text === undefined &&
    message.data === undefined &&
    message.context === undefined &&
    message.extensions === undefined
  ) {
    throw new PoppyError('invalid_request', 'A message needs text, data, context or extensions');
  }
  const context = message.context as PoppyContext | undefined;
  if (context !== undefined) {
    const check = (field: string, type: 'string' | 'boolean') => {
      const value = context[field];
      if (value !== undefined && value !== null && typeof value !== type) {
        throw new PoppyError('invalid_request', `context.${field} must be a ${type} or null`);
      }
    };
    check('locale', 'string');
    check('time_zone', 'string');
    check('user_available', 'boolean');
  }
  // Only a message the Personal Agent wrote carries `as_of_cursor` (§8.4); it is a hint only.
  const asOfCursor =
    authorType === 'agent' &&
    typeof message.as_of_cursor === 'string' &&
    message.as_of_cursor !== ''
      ? message.as_of_cursor
      : undefined;
  // Extension content is kept for now: which of it is used depends on what the request declares,
  // checked by the conversation (§3.3, §8.4).
  return {
    author: { type: authorType },
    ...(asOfCursor !== undefined ? { as_of_cursor: asOfCursor } : {}),
    ...(message.text !== undefined ? { text: message.text as string } : {}),
    ...(message.data !== undefined ? { data: message.data as Record<string, unknown> } : {}),
    ...(context !== undefined ? { context: { ...context } } : {}),
    ...(message.extensions !== undefined
      ? { extensions: { ...(message.extensions as Record<string, unknown>) } }
      : {}),
  };
}

/**
 * Parse a message request (§8.3, §8.4, §8.10). Unknown fields — on the body, the message or its
 * context — are ignored, never refused (§3.3). Only the fields the protocol defines are kept.
 */
export function parseSendBody(raw: string, opts: { allowParent: boolean }): PoppySendBody {
  const body = parseJson(raw);
  const id = requestId(body);

  let parentConversationId: string | undefined;
  let userRequestedEventId: string | undefined;
  if (opts.allowParent && body.parent_conversation_id !== undefined) {
    if (!isPoppyId(body.parent_conversation_id)) {
      throw new PoppyError('conversation_not_found', 'Unknown parent_conversation_id');
    }
    parentConversationId = body.parent_conversation_id;
    if (body.user_requested_event_id !== undefined) {
      if (!isPoppyId(body.user_requested_event_id)) {
        throw new PoppyError('invalid_request', 'user_requested_event_id is not an event ID');
      }
      userRequestedEventId = body.user_requested_event_id;
    }
  }

  // Without a message only when accepting a `user_requested` event (§8.10).
  if (body.message === undefined && userRequestedEventId === undefined) {
    throw new PoppyError('invalid_request', 'message is required');
  }

  return {
    id,
    ...(body.message !== undefined ? { message: parseMessage(body.message) } : {}),
    ...(parentConversationId !== undefined ? { parentConversationId } : {}),
    ...(userRequestedEventId !== undefined ? { userRequestedEventId } : {}),
  };
}

/**
 * Parse a handoff, handoff-cancel or close request: its request ID (§8.9, §8.12). Other fields
 * are tolerated — extensions may add them (§3.3).
 */
export function parseRequestBody(raw: string): PoppyRequestBody {
  return { id: requestId(parseJson(raw)) };
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
 * The fingerprint a retry is compared by (§8.3): the request's path (`new`, `<id>/messages`,
 * `<id>/handoff`, …) and its body. Unknown fields were dropped by the parser, so a retry that adds
 * one is still the same request; query parameters (`cursor`, `wait`) are not part of it.
 */
export function requestFingerprint(path: string, body: object): string {
  return createHash('sha256').update(canonical({ path, body })).digest('base64url');
}
