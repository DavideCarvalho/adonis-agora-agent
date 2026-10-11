/**
 * @experimental Personal Agent Protocol ("Poppy") Draft 0.1 — this app's agent acting on OTHER
 * Poppy Companies for its users. Tracks the spec; WILL change, possibly in breaking ways.
 */
export {
  DEFAULT_POPPY_CONNECTIONS_TEXTS,
  definePoppyConnectionsConfig,
  normalizeDomain,
  type PoppyAgentKey,
  type PoppyCompanyPolicy,
  type PoppyConnectionsConfig,
  type PoppyConnectionsTexts,
  type TwoStepConvention,
} from './config.js';
export { Sealer } from './crypto.js';
export {
  createPoppyConnectionsHandler,
  defaultConnectRenderer,
  type PoppyConnectionsExchange,
  type PoppyConnectRenderer,
  type PoppyConnectView,
} from './http.js';
export { continueAfterConnect, resumeAfterConnect } from './resume.js';
export {
  normalizeKeys,
  PoppyCompanyNotAllowedError,
  type PoppyCompanyReply,
  PoppyConnections,
  type PoppyConnectionsOptions,
  type PoppyConnectionView,
  type PoppyConnectPageData,
} from './service.js';
export {
  ensurePoppyConnectionTables,
  InMemoryPoppyConnectionStore,
  LucidPoppyConnectionStore,
  POPPY_CONNECTION_TABLES,
  type PoppyConnectionRecord,
  type PoppyConnectionRedisClient,
  type PoppyConnectionStore,
  type PoppyPendingConnect,
  poppyConnectionTableStatements,
  redisPoppyConnectionStore,
} from './store.js';
export {
  type CallCompanyToolOptions,
  callCompanyTool,
  previewCompanyWrite,
  registerPoppyConnectionTools,
  talkToCompany,
} from './tools.js';

/** A fresh signing key for `identity.keys` (store the JSON in an env var). */
export async function generatePoppyAgentKey(): Promise<Record<string, unknown>> {
  const { generateEs256Key } = await import('../poppy-client/keys.js');
  return (await generateEs256Key()).privateJwk as Record<string, unknown>;
}
