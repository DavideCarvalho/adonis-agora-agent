/**
 * Wire types from the Personal Agent Protocol (Poppy) 1.0.
 *
 * Every object is "open": the spec requires both sides to ignore fields they don't recognize
 * (3.3), so these interfaces only name what this client reads, and keep an index signature.
 */

export interface PoppyDocument {
  protocol_version: string;
  /** The other versions the Company serves, each mapped to its document's URL (3.4). */
  supported_versions?: Record<string, string> | undefined;
  organization: {
    name: string;
    domain: string;
    logo_uri?: string | undefined;
    [k: string]: unknown;
  };
  auth?: PoppyAuth | undefined;
  agent?: { protocols: PoppyProtocolEntry[]; [k: string]: unknown } | undefined;
  web?: PoppyWeb | undefined;
  /** Where the tasks response is fetched, once per Session (section 9). */
  tasks?: { endpoint: string; [k: string]: unknown } | undefined;
  apis?: PoppyApiEntry[] | undefined;
  /** Each extension lists an entry per major version the Company supports (3.3). */
  extensions?: Record<string, ExtensionEntry[]> | undefined;
  [k: string]: unknown;
}

/** The Company's website (3.1, section 6). */
export interface PoppyWeb {
  browser_session_endpoint?: string | undefined;
  /** The Company asks Personal Agents not to browse its website in a browser. */
  disabled?: boolean | undefined;
  /** `poppy:browser-sign-in` gives the account's full access on the website. */
  unscoped?: boolean | undefined;
  [k: string]: unknown;
}

/** One version of an extension in `poppy.json` (3.3). */
export interface ExtensionEntry {
  version: string;
  [k: string]: unknown;
}

/** Sign-in details (3.1). The sign-in types come from the issuer's `grant_types_supported`. */
export interface PoppyAuth {
  /** Required only when the protected resource metadata lists several authorization servers. */
  issuer?: string | undefined;
  /** The Company offers Personal Agents no sign-in (3.2). */
  disabled?: boolean | undefined;
  scopes?: Record<string, string> | undefined;
  scope_hints?: Record<string, ScopeHint> | undefined;
  [k: string]: unknown;
}

/** What a scope allows (4.7). A `changes` value this client doesn't know counts as `irreversible`. */
export interface ScopeHint {
  changes: string;
  personal_data: boolean;
  [k: string]: unknown;
}

/** The version 1 entry of the `mediated-sign-in` extension in `poppy.json`. */
export interface MediatedExtension extends ExtensionEntry {
  version: string;
  fields: MediatedField[];
  scopes: string[];
  [k: string]: unknown;
}

export interface MediatedField {
  name: string;
  label: string;
  secret: boolean;
  [k: string]: unknown;
}

export interface PoppyProtocolEntry {
  type: string;
  endpoint: string;
  /** What the agent at this endpoint can help with (8.1). Required of the Company. */
  description?: string | undefined;
  /** The interface needs the account from the start (3.2); unknown values are ignored. */
  access?: string | undefined;
  [k: string]: unknown;
}

export interface PoppyApiEntry {
  type: string;
  url: string;
  description?: string | undefined;
  [k: string]: unknown;
}

/** RFC 9728 metadata of a resource (3.2, 4.5). */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[] | undefined;
  /** Scopes a Personal Agent can request, as well as the issuer's (3.2, 4.7). */
  scopes_supported?: string[] | undefined;
  dpop_signing_alg_values_supported?: string[] | undefined;
  [k: string]: unknown;
}

/** RFC 8414 metadata the Personal Agent uses (3.2). */
export interface AuthServerMetadata {
  issuer: string;
  token_endpoint: string;
  revocation_endpoint: string;
  grant_types_supported: string[];
  protected_resources: string[];
  authorization_endpoint?: string | undefined;
  device_authorization_endpoint?: string | undefined;
  /** RFC 9126 (4.2): pushed authorization requests. */
  pushed_authorization_request_endpoint?: string | undefined;
  require_pushed_authorization_requests?: boolean | undefined;
  scopes_supported?: string[] | undefined;
  dpop_signing_alg_values_supported?: string[] | undefined;
  [k: string]: unknown;
}

/** Client ID Metadata Document published by the Personal Agent (4.1). */
export interface ClientMetadata {
  client_id: string;
  client_name: string;
  logo_uri?: string | undefined;
  jwks_uri: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'private_key_jwt';
  [k: string]: unknown;
}

/** Token endpoint success response (4.7, RFC 6749 section 5.1). */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number | undefined;
  /** Left out only when the Company granted exactly the scopes requested. */
  scope?: string | undefined;
  /** Sign-in always returns one; refresh may leave it out. */
  refresh_token?: string | undefined;
  [k: string]: unknown;
}

/** RFC 8628 device authorization response (4.3). */
export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string | undefined;
  expires_in: number;
  interval?: number | undefined;
  [k: string]: unknown;
}

/* ---------------------------------------------------------------- Conversations (section 8) */

/** Facts about the User's situation (8.4). `null` clears a fact shared before. */
export interface MessageContext {
  locale?: string | null | undefined;
  time_zone?: string | null | undefined;
  user_available?: boolean | null | undefined;
  [k: string]: unknown;
}

/**
 * Who wrote a message (8.4). Only Company messages have `id`, `name`, `image`. An `author.type` this
 * client doesn't know is read as `agent` (see `authorTypeOf`).
 */
export interface MessageAuthor {
  type: 'agent' | 'human' | (string & {});
  id?: string | undefined;
  name?: string | undefined;
  image?: string | undefined;
  [k: string]: unknown;
}

/**
 * A message the Personal Agent sends (8.4). It has no `id`: its ID is its request's (8.3). It needs
 * at least one of `text`, `data`, `context`, `extensions`.
 */
export interface OutgoingMessage {
  author: { type: 'agent' | 'human' };
  text?: string | undefined;
  data?: Record<string, unknown> | undefined;
  context?: MessageContext | undefined;
  /** Content of extensions the Company lists in the chosen version (8.4). */
  extensions?: Record<string, Record<string, unknown>> | undefined;
  /** On a message the Personal Agent wrote: the last cursor it had read (8.4). A hint. */
  as_of_cursor?: string | undefined;
}

/** A message as it appears in a `message` event (8.5). A `role` this client doesn't know counts as `company`. */
export interface EventMessage {
  id: string;
  role?: 'user' | 'company' | (string & {}) | undefined;
  author: MessageAuthor;
  text?: string | undefined;
  data?: Record<string, unknown> | undefined;
  extensions?: Record<string, unknown> | undefined;
  /** On a Company Agent message: the latest request it took into account (8.4). A hint. */
  as_of_request?: string | undefined;
  as_of_cursor?: string | undefined;
  [k: string]: unknown;
}

/** Later versions may add values: an unknown `handoff` reads as `pending`, an unknown responder as `human` (8.7). */
export type Handoff = 'none' | 'pending' | (string & {});
export type Responder = 'agent' | 'human' | (string & {});

export interface ConversationEvent {
  id: string;
  type: string;
  created_at: string;
  message?: EventMessage | undefined;
  /** `state` events: handoff, responder, closed (8.7). */
  handoff?: Handoff | undefined;
  responder?: Responder | undefined;
  closed?: boolean | undefined;
  /** `authorization` events (8.11). An unknown `error` means: sign in again for `scope`. */
  error?: string | undefined;
  scope?: string | undefined;
  reason?: string | undefined;
  conversation_id?: string | undefined;
  [k: string]: unknown;
}

/** The conversation's state, in four independent fields (8.7). */
export interface ConversationState {
  /** The Company is still replying. Read again until it's false. */
  working: boolean;
  handoff: Handoff;
  responder: Responder;
  closed: boolean;
}

/**
 * A successful POST (8.3): only `conversation_id`, unless the request carried `wait`, when it is a
 * read of the events with the state.
 */
export interface StartConversationResponse extends Partial<ConversationState> {
  conversation_id: string;
  events?: ConversationEvent[] | undefined;
  cursor?: string | undefined;
  has_more?: boolean | undefined;
  [k: string]: unknown;
}

export interface EventsPage extends ConversationState {
  conversation_id: string;
  events: ConversationEvent[];
  cursor?: string | undefined;
  has_more: boolean;
  [k: string]: unknown;
}

/** Another way to do a task (9.2). */
export interface TaskAlternative {
  instructions?: string | undefined;
  references?: TaskReference[] | undefined;
  [k: string]: unknown;
}

export interface TaskReference {
  type: string;
  url?: string | undefined;
  operation_id?: string | undefined;
  tool?: string | undefined;
  [k: string]: unknown;
}

/** A task the Company chose not to offer through this protocol (9.1). */
export interface ExcludedTask {
  task: string;
  alternative?: TaskAlternative | undefined;
  [k: string]: unknown;
}

export interface TextDelta {
  message_id: string;
  text: string;
}

/** One skill of the tasks response's `skill_index` (9.4), its `url` resolved against `tasks.endpoint`. */
export interface SkillEntry {
  name: string;
  description: string;
  type: 'skill-md' | 'archive';
  url: string;
  digest: string;
  [k: string]: unknown;
}

/** The tasks response (section 9), for one Session. */
export interface TaskCoverage {
  excludedTasks: ExcludedTask[];
  /** Skills of a known index schema and type. Empty when the index is absent or unknown. */
  skills: SkillEntry[];
  /** Where to report a task that can't be done (9.3), when the Company takes feedback. */
  feedbackEndpoint?: string | undefined;
}
