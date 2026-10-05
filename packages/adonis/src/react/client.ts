import { AgentClient, type AgentClientOptions } from './core/client.js';
import { csrfHeaders } from './csrf.js';

export type HeaderSource = AgentClientOptions['getHeaders'];

/** The CSRF header first, then the caller's own — so an app can still override it. */
export async function withCsrf(own: HeaderSource): Promise<Record<string, string>> {
  return { ...csrfHeaders(), ...((await own?.()) ?? {}) };
}

/**
 * An {@link AgentClient} on this package's routes: the session cookie rides every request
 * (`credentials: 'same-origin'`, or whatever you pass for an API on another origin) and the CSRF
 * header is read from the page per request. For code outside React, or to hand one hook a
 * connection of its own (`useAgentChat({ backend })`). Under React prefer `AgentProvider`.
 */
export function createAgentClient(options: AgentClientOptions = {}): AgentClient {
  const { getHeaders, ...rest } = options;
  return new AgentClient({
    credentials: 'same-origin',
    ...rest,
    getHeaders: () => withCsrf(getHeaders),
  });
}
