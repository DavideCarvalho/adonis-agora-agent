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
  type AgentProviderProps,
  AgentProvider as BaseAgentProvider,
} from '@dudousxd/nestjs-agent-react';
import { createElement, type ReactElement, useCallback, useRef } from 'react';
import { type HeaderSource, withCsrf } from './client.js';

export * from '@dudousxd/nestjs-agent-react';
export { type AgUiBackendOptions, agUiBackend, agUiChatStream } from './ag-ui.js';
export { createAgentClient } from './client.js';
export { csrfHeaders, readCookie } from './csrf.js';

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
