import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { pickApi } from './api.js';
import type { CompanyClient } from './company.js';
import { ResourceAuthError } from './errors.js';
import type { PoppyApiEntry } from './types.js';
import { wwwAuthError } from './util.js';

export interface McpConnection {
  client: Client;
  api: PoppyApiEntry;
  close(): Promise<void>;
}

/**
 * Connects to a listed MCP server over Streamable HTTP (section 7): the Session header on every
 * request and, when signed in, a Bearer access token requested with `resource` set to the server's
 * `url`. A challenge rejects the call with a {@link ResourceAuthError} naming the needed `scope`.
 */
export async function connectMcp(
  company: CompanyClient,
  apiIndex?: number | undefined,
): Promise<McpConnection> {
  const api = pickApi(company, 'mcp', apiIndex);
  const authedFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const res = await company.fetch(String(input), {
      method: init?.method ?? 'GET',
      headers,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      ...(init?.signal ? { signal: init.signal } : {}),
      // `resource` MUST be the MCP server's `url` from poppy.json, and Bearer is MCP's baseline (7).
      resource: api.url,
      bearer: true,
    });
    const challenge = res.headers.get('www-authenticate');
    if ((res.status === 401 || res.status === 403) && challenge) {
      const err = wwwAuthError(challenge);
      await res.body?.cancel().catch(() => {});
      throw new ResourceAuthError(err.error ?? 'insufficient_scope', {
        status: res.status,
        description: err.description,
        scope: err.scope,
      });
    }
    return res;
  };
  const transport = new StreamableHTTPClientTransport(new URL(api.url), { fetch: authedFetch });
  const client = new Client({ name: 'poppy-agent', version: '0.0.0' });
  // The SDK's own types disagree under `exactOptionalPropertyTypes`; the transport is the SDK's.
  await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
  return { client, api, close: () => client.close() };
}
