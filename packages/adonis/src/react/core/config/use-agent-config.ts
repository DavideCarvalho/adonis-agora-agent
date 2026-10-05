import { useEffect, useState } from 'react';
import type { AgentClientConfig } from '../../../index.js';
import type { AgentBackend } from '../backend.js';
import { useAgentBackend } from '../provider.js';

export interface UseAgentConfigOptions {
  /** Default: the enclosing `<AgentProvider>`'s. Without `getConfig` the config stays `undefined`. */
  backend?: AgentBackend;
  /** `false` holds the request. Default `true`. */
  enabled?: boolean;
}

export interface AgentConfigState {
  /** `GET <base>/config`, once loaded — `undefined` before, on a failure, or on a backend without it. */
  config: AgentClientConfig | undefined;
  isLoading: boolean;
  error: Error | null;
}

// One request per backend for the whole page: the config is a deployment constant. A failure is
// forgotten so the next mount retries.
const shared = new WeakMap<AgentBackend, Promise<AgentClientConfig>>();

function load(backend: AgentBackend): Promise<AgentClientConfig> | undefined {
  const getConfig = backend.getConfig;
  if (typeof getConfig !== 'function') return undefined;
  let pending = shared.get(backend);
  if (pending === undefined) {
    pending = getConfig.call(backend).catch((error: unknown) => {
      shared.delete(backend);
      throw error;
    });
    shared.set(backend, pending);
  }
  return pending;
}

/**
 * The server's client config (`GET <base>/config`): attachment limits and upload mode, and whether a
 * model picker, a quota and anonymous identities are in play. Fetched once per backend and shared;
 * `useAttachments` takes its defaults from it.
 */
export function useAgentConfig(options: UseAgentConfigOptions = {}): AgentConfigState {
  const backend = useAgentBackend(options.backend);
  const enabled = options.enabled !== false;
  const [config, setConfig] = useState<AgentClientConfig | undefined>(undefined);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const pending = load(backend);
    if (pending === undefined) return;
    let cancelled = false;
    setLoading(true);
    pending.then(
      (loaded) => {
        if (cancelled) return;
        setConfig(loaded !== null && typeof loaded === 'object' ? loaded : undefined);
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
  }, [backend, enabled]);

  return { config, isLoading, error };
}
