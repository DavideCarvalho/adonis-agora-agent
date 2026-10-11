/** Base error for everything this client raises on a protocol-level failure. */
export class PoppyError extends Error {
  readonly code: string;
  readonly status?: number | undefined;
  readonly description?: string | undefined;
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message?: string | undefined,
    opts: {
      status?: number | undefined;
      description?: string | undefined;
      details?: Record<string, unknown> | undefined;
    } = {},
  ) {
    super(message ?? (opts.description ? `${code}: ${opts.description}` : code));
    this.name = 'PoppyError';
    this.code = code;
    this.status = opts.status;
    this.description = opts.description;
    this.details = opts.details;
  }
}

/** Discovery failed or a document didn't pass the checks of section 3. */
export class DiscoveryError extends PoppyError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'DiscoveryError';
  }
}

/** OAuth error response from the token, device, or revocation endpoint (4.2). */
export class OAuthError extends PoppyError {
  readonly retryAfter?: number | undefined;
  constructor(
    code: string,
    opts: {
      status?: number | undefined;
      description?: string | undefined;
      retryAfter?: number | undefined;
      details?: Record<string, unknown> | undefined;
    } = {},
  ) {
    super(code, undefined, opts);
    this.name = 'OAuthError';
    this.retryAfter = opts.retryAfter;
  }
}

/**
 * A resource (API, conversation, mediated sign-in) rejected the token, via `WWW-Authenticate`
 * (section 6): `invalid_token`, `sign_in_required`, `insufficient_scope`, DPoP errors.
 */
export class ResourceAuthError extends PoppyError {
  /** Scopes the Company says are needed, for `insufficient_scope`. */
  readonly scope?: string | undefined;
  constructor(
    code: string,
    opts: {
      status?: number | undefined;
      description?: string | undefined;
      scope?: string | undefined;
    } = {},
  ) {
    super(code, undefined, opts);
    this.name = 'ResourceAuthError';
    this.scope = opts.scope;
  }
}

/** A conversation error with a JSON `error` body (7.13). */
export class ConversationError extends PoppyError {
  /** For `direct_conversation_open`: the open Direct Conversation. */
  readonly conversationId?: string | undefined;
  constructor(
    code: string,
    opts: {
      status?: number | undefined;
      description?: string | undefined;
      conversationId?: string | undefined;
    } = {},
  ) {
    super(code, undefined, opts);
    this.name = 'ConversationError';
    this.conversationId = opts.conversationId;
  }
}
