import { useEffect, useMemo } from 'react';
import {
  type QuotaBlock,
  type QuotaReport,
  type QuotaWarning,
  type QuotaWindow,
  quotaWarning,
} from '../../../spi/quota-provider.js';
import { type AgentBackend, requireBackendMethod } from '../backend.js';
import { useResource } from '../catalog/use-resource.js';
import { useAgentBackend } from '../provider.js';
import { onThreadsEvent } from '../threads/threads-events.js';

export interface UseQuotaOptions {
  /** Default: the enclosing `<AgentProvider>`'s. Must implement `getQuota`. */
  backend?: AgentBackend;
  /** `false` holds the request. Default `true`. */
  enabled?: boolean;
  /** Re-read every `pollMs` ms as well. Default: only on mount, after runs, and on `refresh`. */
  pollMs?: number;
}

export interface QuotaState {
  /** The full report, once loaded. */
  report: QuotaReport | undefined;
  windows: QuotaWindow[];
  /** The `day` / `month` windows, when the server reports them. */
  day: QuotaWindow | undefined;
  month: QuotaWindow | undefined;
  /** The window that blocks sends, or `null` — pass it to `useAgentChat({ blocked })`. */
  blocked: QuotaBlock | null;
  /**
   * The soft limit: the fullest window past its `warnAt` (`{ period, ratio, reason? }`), or `null`.
   * The server's `warning`, else derived from the windows; never set while `blocked`.
   */
  warning: QuotaWarning | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * The caller's budget (`GET <base>/quota`): every window's usage against its ceilings, and which
 * one — if any — blocks sends. Re-read after every run a chat on the same backend settles, so a
 * meter moves with the conversation. Headless: draw the meter yourself.
 */
export function useQuota(options: UseQuotaOptions = {}): QuotaState {
  const { enabled = true, pollMs } = options;
  const backend = useAgentBackend(options.backend);
  const { data, isLoading, error, refresh } = useResource<QuotaReport>(
    () => requireBackendMethod(backend, 'getQuota')(),
    '',
    enabled,
  );

  useEffect(() => {
    if (!enabled) return;
    return onThreadsEvent(backend, (event) => {
      if (event.type === 'changed') void refresh();
    });
  }, [backend, enabled, refresh]);

  useEffect(() => {
    if (!enabled || pollMs === undefined || pollMs <= 0) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [enabled, pollMs, refresh]);

  return useMemo(() => {
    const windows = data?.windows ?? [];
    return {
      report: data,
      windows,
      day: windows.find((window) => window.period === 'day'),
      month: windows.find((window) => window.period === 'month'),
      blocked: data?.blocked ?? null,
      warning:
        data === undefined || data.blocked !== undefined
          ? null
          : (data.warning ?? quotaWarning(windows) ?? null),
      isLoading,
      error,
      refresh,
    };
  }, [data, isLoading, error, refresh]);
}
