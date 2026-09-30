/**
 * `@adonis-agora/agent/react` — the React layer for an AdonisJS app (Inertia or a separate SPA).
 *
 * The hooks, the transport and the transcript model are `@dudousxd/nestjs-agent-react`, re-exported
 * here unchanged: this package's routes speak the same wire contract as `@dudousxd/nestjs-agent`, so
 * ONE React client serves both and a second copy could only drift. Install it (an optional peer)
 * together with `ai` and `@ai-sdk/react` to use this entry.
 *
 * What is Adonis's own is the connection: {@link AgentProvider} and {@link createAgentClient} talk
 * to the routes the provider mounts (`/agent` unless `config/agent.ts` says otherwise) with the
 * session cookie, and send `@adonisjs/shield`'s CSRF token on every request — so the whole setup is
 *
 * ```tsx
 * import { AgentProvider, useAgentChat } from '@adonis-agora/agent/react'
 *
 * <AgentProvider><Chat /></AgentProvider>          // once, around the page
 * const chat = useAgentChat()                      // anywhere below it
 * ```
 */
import {
  AgentClient,
  type AgentClientOptions,
  type AgentProviderProps,
  AgentProvider as BaseAgentProvider,
} from '@dudousxd/nestjs-agent-react';
import { createElement, type ReactElement, useCallback, useRef } from 'react';
import { csrfHeaders } from './csrf.js';

export * from '@dudousxd/nestjs-agent-react';
export { csrfHeaders, readCookie } from './csrf.js';

type HeaderSource = AgentClientOptions['getHeaders'];

/** The CSRF header first, then the caller's own — so an app can still override it. */
async function withCsrf(own: HeaderSource): Promise<Record<string, string>> {
  return { ...csrfHeaders(), ...((await own?.()) ?? {}) };
}

/**
 * An {@link AgentClient} on this package's routes: the session cookie rides every request
 * (`credentials: 'same-origin'`, or whatever you pass for an API on another origin) and the CSRF
 * header is read from the page per request. For code outside React, or to hand one hook a
 * connection of its own (`useAgentChat({ backend })`). Under React prefer {@link AgentProvider}.
 */
export function createAgentClient(options: AgentClientOptions = {}): AgentClient {
  const { getHeaders, ...rest } = options;
  return new AgentClient({
    credentials: 'same-origin',
    ...rest,
    getHeaders: () => withCsrf(getHeaders),
  });
}

/**
 * The agent connection, once, around whatever renders a chat. Every hook below it — `useAgentChat`,
 * `useThreads`, `useAttachments`, `useModels`, `useQuota`, `useToolCatalog`, `useMessageFeedback` —
 * talks to it.
 *
 * Takes everything `@dudousxd/nestjs-agent-react`'s provider takes, with AdonisJS defaults: routes
 * under `/agent` (pass `path` when `config/agent.ts` sets another), the session cookie, and the
 * shield CSRF token added to `getHeaders` (yours are merged over it). A hook used OUTSIDE a provider
 * falls back to a plain client that sends no CSRF token, which shield refuses on every `POST` —
 * mount the provider.
 */
export function AgentProvider(props: AgentProviderProps): ReactElement {
  const { getHeaders, credentials, children, ...rest } = props;
  const own = useRef<HeaderSource>(getHeaders);
  own.current = getHeaders;
  const headers = useCallback(() => withCsrf(own.current), []);
  return createElement(
    BaseAgentProvider,
    { credentials: credentials ?? 'same-origin', ...rest, getHeaders: headers },
    children,
  );
}
