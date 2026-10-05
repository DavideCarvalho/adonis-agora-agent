import { useCallback, useEffect, useRef, useState } from 'react';

export interface ResourceState<T> {
  data: T | undefined;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * One read, re-run when `key` changes, with only the newest response allowed to land. The shared
 * shape behind `useModels` / `useAgents`.
 */
export function useResource<T>(
  load: () => Promise<T>,
  key: string,
  enabled: boolean,
): ResourceState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++generation.current;
    setIsLoading(true);
    try {
      const value = await loadRef.current();
      if (mine !== generation.current) return;
      setData(value);
      setError(null);
    } catch (caught) {
      if (mine !== generation.current) return;
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      if (mine === generation.current) setIsLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names what `load` reads
  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, key, refresh]);

  return { data, isLoading, error, refresh };
}
