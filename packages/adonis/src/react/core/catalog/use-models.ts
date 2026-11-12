import { useMemo } from 'react';
import type {
  ModelCatalogEntry,
  ModelCatalogLock,
  ModelCatalogView,
} from '../../../spi/model-catalog.js';
import { type AgentBackend, requireBackendMethod } from '../backend.js';
import { useAgentBackend } from '../provider.js';
import { useResource } from './use-resource.js';

export interface UseModelsOptions {
  /** Default: the enclosing `<AgentProvider>`'s. Must implement `listModels`. */
  backend?: AgentBackend;
  /** The agent to list models for; omitted → the default agent. */
  agent?: string;
  /** The persona the chat runs under — its `model` is the default shown. Omitted → the agent's default persona. */
  persona?: string;
  /** `false` holds the request. Default `true`. */
  enabled?: boolean;
}

/** A catalog entry with the provider it sits under, for a flat list or a search. */
export interface ModelOption extends ModelCatalogEntry {
  providerId: string;
  providerLabel: string;
}

export interface ModelsState {
  /** Grouped as the server sent them. `[]` until loaded. */
  providers: ModelCatalogView['providers'];
  /** Every model, flattened in provider order. */
  models: ModelOption[];
  /**
   * The model a turn runs on when none is picked — the persona's or the agent's configured `model`,
   * else the catalog's default — or `null` when the provider decides.
   */
  defaultModel: string | null;
  /**
   * The agent always runs on one model (`{ model, reason? }`), or `null`. A picker shows it
   * read-only: the server runs every turn on it and refuses any other.
   */
  locked: ModelCatalogLock | null;
  /** The entry for `id`, or `undefined`. */
  find: (id: string | null | undefined) => ModelOption | undefined;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * The models this caller may pick (`GET <base>/models?agent=`), with badges and availability — the
 * data behind a model picker. Headless: render the options however you like, then send the pick
 * as `useAgentChat({ model })` or `sendMessage(msg, { body: { model } })` (that turn only), or
 * pin it on the thread with `chat.models.pinToThread(id)`.
 */
export function useModels(options: UseModelsOptions = {}): ModelsState {
  const { agent, persona, enabled = true } = options;
  const backend = useAgentBackend(options.backend);
  const { data, isLoading, error, refresh } = useResource<ModelCatalogView>(
    () =>
      persona === undefined
        ? requireBackendMethod(backend, 'listModels')(agent)
        : requireBackendMethod(backend, 'listModels')(agent, persona),
    `${agent ?? ''}\u0000${persona ?? ''}`,
    enabled,
  );
  return useMemo(() => {
    const providers = data?.providers ?? [];
    const models = providers.flatMap((provider) =>
      provider.models.map((model) => ({
        ...model,
        providerId: provider.id,
        providerLabel: provider.label,
      })),
    );
    const byId = new Map(models.map((model) => [model.id, model]));
    return {
      providers,
      models,
      defaultModel: data?.default ?? null,
      locked: data?.locked ?? null,
      find: (id) => (id == null ? undefined : byId.get(id)),
      isLoading,
      error,
      refresh,
    };
  }, [data, isLoading, error, refresh]);
}
