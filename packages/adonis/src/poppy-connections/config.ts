import type { Actor } from '../types.js';
import type { PoppyConnectionStore } from './store.js';

/** What this app's agent may do at one Company. */
export interface PoppyCompanyPolicy {
  /** A name for the model and the pages. Default: the Company's own `organization.name`. */
  label?: string;
  /** Scopes the connect step asks for. Default: every scope the sign-in offers. */
  scopes?: string[];
  /**
   * Scopes that only READ — what `ask` narrows its token to, so a plain question can never make the
   * Company act (an action takes `request`, which the person confirms). Default: the scopes the Company hints change nothing (`auth.scope_hints`, `changes: none`).
   */
  readScopes?: string[];
}

/** A signing key of this app's agent identity: a private EC P-256 JWK (`kid` optional). */
export type PoppyAgentKey = Record<string, unknown>;

export interface PoppyConnectionsTexts {
  pageTitle: string;
  connectTitle: string;
  connectBody: string;
  direct: string;
  device: string;
  deviceBody: string;
  deviceCheck: string;
  mediatedTitle: string;
  mediatedSubmit: string;
  codeTitle: string;
  codeLabel: string;
  codeSubmit: string;
  connectedTitle: string;
  connectedBody: string;
  failedTitle: string;
  failedBody: string;
  expiredTitle: string;
  expiredBody: string;
  pendingBody: string;
  confirmConnectTitle: string;
  confirmConnectVerb: string;
  confirmConnectDetail: string;
  /**
   * What the conversation is continued with once the person connected (independent approvals:
   * a new turn on the thread, in the person's voice). `{company}`.
   */
  continueAfterConnect: string;
  confirmWriteTitle: string;
  confirmRequestTitle: string;
  confirmDisconnectTitle: string;
  confirmVerb: string;
}

/** `{name}` placeholders: `{company}`, `{link}`, `{code}`, `{tool}`. */
export const DEFAULT_POPPY_CONNECTIONS_TEXTS: PoppyConnectionsTexts = {
  pageTitle: 'Connect your account',
  connectTitle: 'Connect your {company} account',
  connectBody: 'Your assistant asked to act on your {company} account. Sign in there to allow it.',
  direct: 'Sign in to {company}',
  device: 'Approve with a code instead',
  deviceBody: 'Open {link} and enter the code {code}. Then come back here.',
  deviceCheck: 'I approved it',
  mediatedTitle: 'Or sign in here',
  mediatedSubmit: 'Continue',
  codeTitle: 'Enter the code',
  codeLabel: 'Code sent to {sentTo}',
  codeSubmit: 'Confirm',
  connectedTitle: 'Connected to {company}',
  connectedBody: 'You can go back to the conversation.',
  failedTitle: 'Could not connect',
  failedBody: 'The sign-in did not go through. Go back to the conversation and try again.',
  expiredTitle: 'This link expired',
  expiredBody: 'Ask your assistant for a new one.',
  pendingBody: 'Not approved yet. Approve it and try again.',
  confirmConnectTitle: 'Connect your {company} account',
  confirmConnectVerb: 'I connected',
  confirmConnectDetail: 'Open this link and sign in to {company}: {link}',
  continueAfterConnect: 'I connected my account at {company}. Please go on with what I asked.',
  confirmWriteTitle: '{company}: {tool}',
  confirmRequestTitle: 'Ask {company} to act',
  confirmDisconnectTitle: 'Disconnect your {company} account',
  confirmVerb: 'Confirm',
};

/**
 * `config/poppy_connections.ts` — this app's agent acting on OTHER Poppy Companies for its users.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.3 (https://personalagentprotocol.org/docs/spec):
 * this API WILL change as the spec evolves — possibly in breaking ways, outside semver majors.
 */
export interface PoppyConnectionsConfig {
  /** This app's public origin (HTTPS). The identity lives at `{baseUrl}/{path}/agent.json`. */
  baseUrl: string;
  /** Where the identity, the connect pages and the callback are served. Default `'poppy-agent'`. */
  path?: string;
  identity: {
    /** `client_name` — what the Company shows its users on its consent screen. */
    name: string;
    logoUri?: string;
    /** Private EC P-256 JWKs (a JSON string works: an env var). The first signs; all are published. */
    keys: PoppyAgentKey[] | string;
  };
  /**
   * The Companies this agent may talk to (`domain` or `domain:port`, as discovered). **Default:
   * none.** A list, a map to per-Company policy, or a predicate.
   */
  companies?: string[] | Record<string, PoppyCompanyPolicy> | ((domain: string) => boolean);
  /** Whose connection a turn uses. Default: `actor.tenantRef ?? actor.id`. */
  owner?: (actor: Actor) => string;
  /** `'lucid'` (default), `'memory'`, or a store. */
  store?: 'lucid' | 'memory' | PoppyConnectionStore;
  connection?: string;
  autoCreateTables?: boolean;
  /** Seals tokens and keys at rest. Default: the app key. */
  secret?: string;
  /**
   * DEVELOPMENT ONLY, not spec-compliant: accept `http://` Companies and serve the identity over
   * http (a local app). Refused when `NODE_ENV=production`.
   */
  insecureDev?: boolean;
  /**
   * Tool names' prefix (default `'poppy_'`), the roles they require, how `connect` works
   * (`'action'` card that resumes, or `'link'`), and whether the write tools are registered.
   * `register: false` registers none (an app with its own per-turn registry calls
   * `registerPoppyConnectionTools` itself).
   */
  tools?: {
    prefix?: string;
    roles?: string[];
    ability?: string;
    connect?: 'action' | 'link';
    writes?: boolean;
    register?: boolean;
    /**
     * Company tools that confirm in two steps (called first without `confirm` they only answer a
     * preview and a `confirmToken`): the write tool shows that preview on its card and, once the
     * person confirms, commits with the token. Detected by the tool's input schema having both
     * fields. `false` turns it off. Default `{ confirm: 'confirm', token: 'confirmToken' }`.
     */
    twoStep?: TwoStepConvention | false;
  };
  /** How long a connect link works, in seconds. Default 900. */
  connectTtlSeconds?: number;
  /** How long `ask`/`request` wait for the Company's reply. Default 90 000 ms. */
  replyTimeoutMs?: number;
  texts?: Partial<PoppyConnectionsTexts>;
  /**
   * Routes for the app's own UI: `GET {path}/api/connections`, `DELETE {path}/api/connections/:domain`,
   * behind the app's session. `actor` says who is asking (null → 401).
   */
  api?: {
    actor: (ctx: import('@adonisjs/core/http').HttpContext) => Actor | null | Promise<Actor | null>;
  };
  /** `fetch` for every request to Companies (tests). */
  fetch?: typeof fetch;
}

/** Field names of a Company's two-step confirmation convention (see `tools.twoStep`). */
export interface TwoStepConvention {
  confirm: string;
  token: string;
  /** Preview fields read for the card, first found wins. Default `['summary', 'resumo', 'message']`. */
  summary?: string[];
}

export function definePoppyConnectionsConfig(
  config: PoppyConnectionsConfig,
): PoppyConnectionsConfig {
  return config;
}

/** `https://Acme.com/` → `acme.com`; `localhost:3333` stays. */
export function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\/+$/, '');
  try {
    if (/^[a-z]+:\/\//.test(trimmed)) return new URL(trimmed).host;
  } catch {}
  return trimmed;
}
