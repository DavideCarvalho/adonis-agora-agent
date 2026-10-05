import { useEffect, useRef, useState } from 'react';

/**
 * Where a reasoning part carries how long the model thought, in ms. Both producers write it here —
 * the transport on the live `reasoning-end` chunk, `storedMessageToUiMessage` on a replayed part —
 * so a reader has one place to look whichever way the message arrived.
 */
export const REASONING_METADATA_KEY = 'agent';

/** The `providerMetadata` a reasoning part is stamped with. */
export function reasoningDurationMetadata(reasoningMs: number): {
  [REASONING_METADATA_KEY]: { reasoningMs: number };
} {
  return { [REASONING_METADATA_KEY]: { reasoningMs } };
}

/** The thinking time stamped on a reasoning part, or `null` when it carries none. */
export function readReasoningMs(part: { providerMetadata?: unknown }): number | null {
  const metadata = part.providerMetadata;
  if (typeof metadata !== 'object' || metadata === null) return null;
  const scoped = (metadata as Record<string, unknown>)[REASONING_METADATA_KEY];
  if (typeof scoped !== 'object' || scoped === null) return null;
  const value = (scoped as Record<string, unknown>).reasoningMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export interface UseElapsedOptions {
  /** How often the value re-renders while running. Default 1000 — a seconds label needs no more. */
  intervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Milliseconds since `running` last turned true — ticking while it stays true, frozen at the final
 * value once it turns false, `0` before it has ever run. Headless: pair it with
 * {@link formatElapsed} or any label of your own.
 *
 * For a reasoning block, prefer the duration the block already carries (`block.durationMs`, the
 * server's own measurement) and fall back to this only while the block streams:
 * `block.durationMs ?? elapsed`.
 */
export function useElapsed(running: boolean, options: UseElapsedOptions = {}): number {
  const { intervalMs = 1000 } = options;
  const nowRef = useRef(options.now ?? Date.now);
  nowRef.current = options.now ?? Date.now;
  const startedAt = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) {
      if (startedAt.current !== null) {
        setElapsed(nowRef.current() - startedAt.current);
        startedAt.current = null;
      }
      return;
    }
    startedAt.current = nowRef.current();
    setElapsed(0);
    const timer = setInterval(() => {
      if (startedAt.current !== null) setElapsed(nowRef.current() - startedAt.current);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [running, intervalMs]);

  return elapsed;
}

/**
 * `"<1s"`, `"4s"`, `"1m 5s"`, `"1h 2m"` — whole units, the shape a "Thought for …" label wants.
 * Negative or non-finite input reads as `"<1s"` rather than a nonsense figure.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return '<1s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}
