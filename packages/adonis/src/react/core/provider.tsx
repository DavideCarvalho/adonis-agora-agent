import { type Context, type ReactNode, useContext, useMemo, useRef } from 'react';
import type { UiCapabilities } from '../../genui/index.js';
import type { AgentBackend, AttachmentUploadStrategy } from './backend.js';
import { AgentClient } from './client.js';
import { sharedContext } from './components/ambient-ui.js';
import { GenuiProvider, type GenuiProviderValue } from './genui/generative-ui.js';
import type { HttpErrorListener } from './http-error.js';

// Shared by key, like the genui contexts: `/media` and `/genui` are separate bundles.
const AgentBackendContext: Context<AgentBackend | null> = sharedContext<AgentBackend>(
  '@adonis-agora/agent/react:agent-backend',
);

export interface AgentProviderProps {
  /** Advertise exact supported component versions; omission keeps legacy support, [] is text only. */
  uiCapabilities?: UiCapabilities;
  /**
   * A backend of your own — see {@link AgentBackend}. Omitted → an {@link AgentClient} over this
   * library's REST routes, built from the connection props below (which are ignored when a backend
   * is given). Must be stable across renders.
   */
  backend?: AgentBackend;
  /** The server's origin, e.g. `https://api.example.com`. Default `''` (same origin). */
  baseUrl?: string;
  /** `AgentModule`'s `path`, global prefix included (`'api/agent'`). Default `'agent'`. */
  path?: string;
  /** Static headers on every request. */
  headers?: Record<string, string>;
  /**
   * Read at every request — a short-lived bearer token, or a CSRF header read from a cookie
   * (`{ 'X-XSRF-TOKEN': readCookie('XSRF-TOKEN') }`).
   */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** `'include'` when the API is on another origin and authenticates by cookie. */
  credentials?: RequestCredentials;
  /** Injectable for tests / non-browser runtimes. */
  fetch?: typeof fetch;
  /**
   * Every error answer of the built-in client (an `AgentHttpError`, or a `MediaUploadError` from
   * `mediaAttachments()`), right before it is thrown — for app-wide reactions such as "401 → sign
   * in again". Read at call time, so it may change between renders.
   */
  onHttpError?: HttpErrorListener;
  /** Attachment uploads of the built-in client. */
  attachments?: {
    /** e.g. `mediaAttachments()` from `@adonis-agora/agent/react/media`. */
    upload?: AttachmentUploadStrategy;
  };
  /**
   * Set generative UI up here — the same settings `<GenuiProvider>` takes (registry, catalog,
   * resolver, fallback, …). Every message then draws pushed components with them.
   */
  genui?: GenuiProviderValue;
  children?: ReactNode;
}

/**
 * The agent connection, once, at the app root. Every hook below it — `useAgentChat`, `useThreads`,
 * `useModels`, `useAgents`, `useQuota`, `useToolCatalog`, `useMessageFeedback`, `useAttachments` —
 * talks to it unless handed a `backend` of its own.
 *
 * ```tsx
 * <AgentProvider baseUrl="https://api.example.com" credentials="include">
 *   <App />
 * </AgentProvider>
 * ```
 *
 * Without a provider every hook shares one same-origin client on `/agent`.
 */
export function AgentProvider({
  backend,
  uiCapabilities,
  baseUrl,
  path,
  headers,
  getHeaders,
  credentials,
  fetch,
  onHttpError,
  attachments,
  genui,
  children,
}: AgentProviderProps) {
  // Headers are read per request, so a re-render with new ones reaches the same client.
  const latestHeaders = useRef({ headers, getHeaders, onHttpError });
  latestHeaders.current = { headers, getHeaders, onHttpError };
  const upload = attachments?.upload;
  const value = useMemo(
    () =>
      backend ??
      new AgentClient({
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(path !== undefined ? { path } : {}),
        ...(credentials !== undefined ? { credentials } : {}),
        ...(fetch !== undefined ? { fetch } : {}),
        ...(upload !== undefined ? { attachments: { upload } } : {}),
        onHttpError: (error) => latestHeaders.current.onHttpError?.(error),
        getHeaders: async () => {
          const current = latestHeaders.current;
          const dynamic = (await current.getHeaders?.()) ?? {};
          return { ...current.headers, ...dynamic };
        },
      }),
    [backend, baseUrl, path, credentials, fetch, upload],
  );
  const content =
    genui !== undefined ? <GenuiProvider {...genui}>{children}</GenuiProvider> : children;
  return (
    <AgentUiCapabilitiesContext.Provider value={uiCapabilities ?? null}>
      <AgentBackendContext.Provider value={value}>{content}</AgentBackendContext.Provider>
    </AgentUiCapabilitiesContext.Provider>
  );
}

let fallback: AgentClient | undefined;

/** The client every hook uses outside an {@link AgentProvider}: same origin, `/agent`. */
function defaultBackend(): AgentClient {
  fallback ??= new AgentClient();
  return fallback;
}

/**
 * The backend a hook talks to: `own` when given, else the enclosing {@link AgentProvider}'s, else a
 * shared same-origin client on `/agent`. For your own hooks over the same connection.
 */
export function useAgentBackend<B extends AgentBackend = AgentBackend>(own?: B): B {
  const provided = useContext(AgentBackendContext);
  return (own ?? provided ?? defaultBackend()) as B;
}

const AgentUiCapabilitiesContext = sharedContext<UiCapabilities>(
  '@adonis-agora/agent/react:ui-capabilities',
);
export function useAgentUiCapabilities(): UiCapabilities | undefined {
  return useContext(AgentUiCapabilitiesContext) ?? undefined;
}
