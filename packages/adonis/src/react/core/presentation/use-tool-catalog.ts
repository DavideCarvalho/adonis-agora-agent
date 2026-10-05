import type { ToolCatalogEntry } from '../../../index.js';
import { ALL_AGENTS } from '../../../tool-presentation.js';

export { ALL_AGENTS };

import { useCallback, useEffect, useMemo, useState } from 'react';
import { type AgentBackend, AgentBackendUnsupportedError } from '../backend.js';
import { useAgentBackend } from '../provider.js';
import { type ToolCatalog, toolCatalogFrom } from './phrasing.js';

/** What the catalog needs of a backend. */
type ToolsBackend = Pick<AgentBackend, 'listTools'>;

export interface UseToolCatalogOptions {
  /**
   * The backend to ask. Default: the enclosing `<AgentProvider>`'s. Must be STABLE across renders
   * (the shared copy is keyed by it): a backend constructed inline refetches every render.
   */
  backend?: ToolsBackend;
  /**
   * The agent whose tools to list. Omitted → the server's default agent. {@link ALL_AGENTS} (`'*'`)
   * → every tool the actor reaches through any agent, each once — for an app with several agents
   * whose conversations one surface shows.
   */
  agent?: string;
  /** `false` holds the request (e.g. until the user is signed in). Default `true`. */
  enabled?: boolean;
}

export interface ToolCatalogState {
  /** Tool name → presentation, for the tools that declared one. `{}` until loaded. */
  catalog: ToolCatalog;
  /** Everything `GET <base>/tools` returned, kinds included. */
  entries: ToolCatalogEntry[];
  isLoading: boolean;
  error: Error | null;
  /** Drop the shared copy and ask again. */
  refresh: () => void;
}

/**
 * One request per backend + agent for the whole page: the catalog is a deployment-time constant, so
 * every component that narrates a tool call can call this hook and share the answer instead of
 * putting a request between a tool starting and the sentence that describes it. A failed request
 * is not cached, so the next mount retries.
 */
const shared = new WeakMap<ToolsBackend, Map<string, Promise<ToolCatalogEntry[]>>>();

function load(client: ToolsBackend, agent: string | undefined): Promise<ToolCatalogEntry[]> {
  let byAgent = shared.get(client);
  if (byAgent === undefined) {
    byAgent = new Map();
    shared.set(client, byAgent);
  }
  const key = agent ?? '';
  const cached = byAgent.get(key);
  if (cached !== undefined) return cached;
  if (client.listTools === undefined) {
    return Promise.reject(new AgentBackendUnsupportedError('listTools'));
  }
  const request = client.listTools(agent).catch((error: unknown) => {
    byAgent.delete(key);
    throw error;
  });
  byAgent.set(key, request);
  return request;
}

/**
 * The server-declared presentation of the tools this actor can reach (`GET <base>/tools`), for
 * `phraseFor`, `describeToolCall` and `groupToolActivity` — or pass `catalog` to
 * `useChatTranscript({ toolCatalog })` and read the phrases off the transcript's calls.
 */
export function useToolCatalog(options: UseToolCatalogOptions = {}): ToolCatalogState {
  const { agent, enabled = true } = options;
  const client = useAgentBackend(options.backend as AgentBackend | undefined);
  const [entries, setEntries] = useState<ToolCatalogEntry[]>([]);
  const [isLoading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const [generation, setGeneration] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` is the refresh trigger
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    load(client, agent).then(
      (loaded) => {
        if (cancelled) return;
        setEntries(Array.isArray(loaded) ? loaded : []);
        setError(null);
        setLoading(false);
      },
      (failure: unknown) => {
        if (cancelled) return;
        setError(failure instanceof Error ? failure : new Error(String(failure)));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, agent, enabled, generation]);

  const refresh = useCallback(() => {
    shared.get(client)?.delete(agent ?? '');
    setGeneration((current) => current + 1);
  }, [client, agent]);

  const catalog = useMemo(() => toolCatalogFrom(entries), [entries]);
  return { catalog, entries, isLoading, error, refresh };
}
