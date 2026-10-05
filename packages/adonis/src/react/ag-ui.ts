import { createAgentClient } from './client.js';
import {
  type AgUiChatStreamOptions,
  agUiChatStream as baseAgUiChatStream,
} from './core/ag-ui-backend.js';
import type { AgentBackend, ChatStreamRequest, ChatStreamResponse } from './core/backend.js';
import type { AgentClientOptions } from './core/client.js';
import { csrfHeaders } from './csrf.js';

/**
 * the local React adapter's `agUiChatStream`, with `@adonisjs/shield`'s CSRF header read
 * from the page on every call (yours, in `options.headers`, win over it).
 *
 * The re-exported original sends only the headers it is handed, captured once — and shield refuses
 * a `POST` without a current token, so behind an Adonis session it would be refused on the first
 * send, or on the first send after the token rotated.
 */
export function agUiChatStream(
  request: ChatStreamRequest,
  options: AgUiChatStreamOptions,
): Promise<ChatStreamResponse> {
  return baseAgUiChatStream(request, {
    ...options,
    headers: { ...csrfHeaders(), ...options.headers },
  });
}

/** What {@link agUiBackend} takes — every field optional. */
export interface AgUiBackendOptions extends AgentClientOptions {
  /**
   * The AG-UI endpoint. Default `<baseUrl><path>/ag-ui` — where `agUiAdapter()` mounts it under the
   * agent's routes (`/agent/ag-ui` unless `config/agent.ts` sets another `path`).
   */
  url?: string;
  /**
   * The backend every other call goes to — threads, the queue, approvals, uploads. Default an
   * `AgentClient` on this package's REST routes, built from the same connection options.
   */
  client?: AgentBackend;
  /** The rest of `agUiChatStream`'s options (`forwardedProps`, `content`, `refusal`). */
  agUi?: Omit<AgUiChatStreamOptions, 'url' | 'fetch' | 'headers'>;
}

function agentPath(path: string | undefined): string {
  const trimmed = (path ?? '/agent').replace(/\/+$/, '');
  return trimmed.startsWith('/') || trimmed === '' ? trimmed : `/${trimmed}`;
}

/**
 * A backend whose chat turns run over AG-UI 1.0 (`agUiAdapter()` on the server) while everything
 * else — threads, the queue, approvals, uploads — stays on this package's REST routes:
 *
 * ```tsx
 * import { AgentProvider, agUiBackend } from '@adonis-agora/agent/react'
 *
 * <AgentProvider backend={agUiBackend()}><Chat /></AgentProvider>
 * ```
 *
 * Every AG-UI request carries the session cookie, the CSRF header (read per request) and the
 * connection's own `headers` / `getHeaders`. Point `url` at any other AG-UI 1.0 producer to drive
 * that one instead.
 */
export function agUiBackend(options: AgUiBackendOptions = {}): AgentBackend {
  const { url, client, agUi, ...connection } = options;
  const rest: AgentBackend = client ?? createAgentClient(connection);
  const endpoint =
    url ?? `${(connection.baseUrl ?? '').replace(/\/+$/, '')}${agentPath(connection.path)}/ag-ui`;
  const baseFetch = connection.fetch ?? globalThis.fetch.bind(globalThis);
  const fetchWithConnection: typeof fetch = async (input, init) =>
    baseFetch(input, {
      ...init,
      credentials: connection.credentials ?? 'same-origin',
      headers: {
        ...csrfHeaders(),
        ...connection.headers,
        ...((await connection.getHeaders?.()) ?? {}),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
  const openChatStream = (request: ChatStreamRequest): Promise<ChatStreamResponse> =>
    baseAgUiChatStream(request, { ...agUi, url: endpoint, fetch: fetchWithConnection });
  // A Proxy rather than a spread: the default backend is a class instance, whose methods live on
  // its prototype, where `{ ...client }` would not find them.
  return new Proxy(rest, {
    get(target, property) {
      if (property === 'openChatStream') return openChatStream;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
