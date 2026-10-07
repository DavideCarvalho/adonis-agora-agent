import { OpenCode } from '@opencode/client';
import type { OpenCodeClient } from '../../../src/opencode/client.js';

/**
 * Compile-time check (`tsconfig.tests.json`): the real OpenCode 2 client (`@opencode/client` 2.0.18)
 * satisfies the engine's structural `OpenCodeClient`, so a drift in the client's types fails the
 * typecheck. Also what the live specs connect with.
 */
export function realClient(baseUrl: string, password: string): OpenCodeClient {
  return OpenCode.make({
    baseUrl,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
  });
}
