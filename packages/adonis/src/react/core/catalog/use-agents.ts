import { useCallback, useMemo } from 'react';
import type { AgentCatalogEntry, PersonaCatalogEntry } from '../../../index.js';
import { type AgentBackend, requireBackendMethod } from '../backend.js';
import { useAgentBackend } from '../provider.js';
import { useResource } from './use-resource.js';

export interface UseAgentsOptions {
  /** Default: the enclosing `<AgentProvider>`'s. Must implement `listAgents`. */
  backend?: AgentBackend;
  /** `false` holds the request. Default `true`. */
  enabled?: boolean;
}

export interface AgentsState {
  /** `[]` until loaded. */
  agents: AgentCatalogEntry[];
  /** The agent a turn runs as when none is named. */
  defaultAgent: string | null;
  /**
   * An agent's personas — the data behind a persona picker. `agent` omitted → the default agent's.
   * `[]` for an agent that declares none (or before the list loads).
   */
  personasOf: (agent?: string) => PersonaCatalogEntry[];
  /** The persona `agent` (default: the default agent) runs under when a send names none, or `null`. */
  defaultPersonaOf: (agent?: string) => string | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * The registered agents (`GET <base>/agents`) — the data behind an agent picker, and each agent's
 * personas behind a persona picker. Send the pick as `useAgentChat({ agent, persona })`, or pin it on
 * a thread with `PATCH <base>/threads/:id { defaultAgent, persona }`.
 */
export function useAgents(options: UseAgentsOptions = {}): AgentsState {
  const { enabled = true } = options;
  const backend = useAgentBackend(options.backend);
  const { data, isLoading, error, refresh } = useResource<AgentCatalogEntry[]>(
    () => requireBackendMethod(backend, 'listAgents')(),
    '',
    enabled,
  );
  const find = useCallback(
    (name?: string): AgentCatalogEntry | undefined =>
      (data ?? []).find((agent) =>
        name === undefined ? agent.isDefault === true : agent.name === name,
      ),
    [data],
  );
  return useMemo(() => {
    const agents = data ?? [];
    return {
      agents,
      defaultAgent: agents.find((agent) => agent.isDefault === true)?.name ?? null,
      personasOf: (agent?: string) => find(agent)?.personas ?? [],
      defaultPersonaOf: (agent?: string) => find(agent)?.defaultPersona ?? null,
      isLoading,
      error,
      refresh,
    };
  }, [data, find, isLoading, error, refresh]);
}
