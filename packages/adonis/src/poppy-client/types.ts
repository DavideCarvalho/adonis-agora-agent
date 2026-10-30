/**
 * Wire types from the Personal Agent Protocol (Poppy) Draft 0.3.
 *
 * Every object is "open": the spec requires both sides to ignore fields they don't recognize
 * (3.3), so these interfaces only name what this client reads, and keep an index signature.
 */

export interface PoppyDocument {
  protocol_version: string;
  organization: { name: string; domain: string; [k: string]: unknown };
  auth?: PoppyAuth | undefined;
  agent?: { protocols: PoppyProtocolEntry[]; [k: string]: unknown } | undefined;
  web?: { browser_session_endpoint?: string | undefined; [k: string]: unknown };
  feedback?: { endpoint: string; [k: string]: unknown } | undefined;
  excluded_tasks?: { url: string; [k: string]: unknown } | undefined;
  apis?: PoppyApiEntry[] | undefined;
  extensions?: Record<string, { version: string; [k: string]: unknown }> | undefined;
  [k: string]: unknown;
}

/** Sign-in details (3.1). The sign-in types come from the issuer's `grant_types_supported`. */
export interface PoppyAuth {
  /** Required only when the protected resource metadata lists several authorization servers. */
  issuer?: string | undefined;
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

/** The `mediated-sign-in` extension entry of `poppy.json`. */
export interface MediatedExtension {
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
  extensions?: Record<string, { version: string }> | undefined;
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

export interface MessageContext {
  locale?: string | undefined;
  time_zone?: string | undefined;
  user_available?: boolean | undefined;
  [k: string]: unknown;
}

/** Who wrote a message (8.4). Only Company messages have `id`, `name`, `image`. */
export interface MessageAuthor {
  type: 'agent' | 'human';
  id?: string | undefined;
  name?: string | undefined;
  image?: string | undefined;
  [k: string]: unknown;
}

/** A message the Personal Agent sends (8.4). */
export interface OutgoingMessage {
  id: string;
  author: { type: 'agent' | 'human' };
  text?: string | undefined;
  data?: Record<string, unknown> | undefined;
  context?: MessageContext | undefined;
}

/** A message as it appears in a `message` event (7.5). */
export interface EventMessage {
  id: string;
  role?: 'user' | 'company' | undefined;
  author: MessageAuthor;
  text?: string | undefined;
  data?: Record<string, unknown> | undefined;
  [k: string]: unknown;
}

/** Later versions may add values: an unknown status reads as `working`, an unknown responder as `human` (8.7). */
export type ConversationStatus = 'working' | 'idle' | 'queued' | 'closed' | (string & {});
export type Responder = 'agent' | 'human' | (string & {});

export interface ConversationEvent {
  id: string;
  type: string;
  created_at: string;
  message?: EventMessage | undefined;
  status?: ConversationStatus | undefined;
  responder?: Responder | undefined;
  error?: string | undefined;
  scope?: string | undefined;
  reason?: string | undefined;
  conversation_id?: string | undefined;
  [k: string]: unknown;
}

export interface ConversationState {
  status: ConversationStatus;
  responder: Responder;
}

export interface StartConversationResponse extends ConversationState {
  conversation_id: string;
  /** Present when the request carried `wait` (7.3). */
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

/** The public document of tasks the Company chose not to offer (9.1). */
export interface ExcludedTask {
  task: string;
  alternative?: TaskAlternative | undefined;
  [k: string]: unknown;
}

export interface TextDelta {
  message_id: string;
  text: string;
}
