import { useEffect, useRef, useState } from 'react';

export interface ApprovalCountdown {
  /** Milliseconds until the request lapses, floored at 0; `null` when it never does. */
  remainingMs: number | null;
  /** The instant has passed. Always `false` for a request with no expiry. */
  isExpired: boolean;
}

export interface UseApprovalCountdownOptions {
  /** How often the value re-renders while counting. Default 1000 — a seconds label needs no more. */
  intervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** What {@link useApprovalCountdown} reads for `expiresAt` at `now`, without the ticking. */
export function approvalCountdown(
  expiresAt: string | null | undefined,
  now: number = Date.now(),
): ApprovalCountdown {
  const deadline = expiresAt == null ? Number.NaN : Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) {
    return { remainingMs: null, isExpired: false };
  }
  const remainingMs = Math.max(0, deadline - now);
  return { remainingMs, isExpired: remainingMs === 0 };
}

/**
 * Time left on an approval request (`call.approval.expiresAt`), ticking until it lapses and then
 * holding at zero. Headless: pair `remainingMs` with `formatElapsed` or any label of your own, and
 * use `isExpired` to stop offering buttons the server would refuse (`410 Gone`). The server stays
 * the authority — a lapse is final only once the call settles `expired`.
 */
export function useApprovalCountdown(
  expiresAt: string | null | undefined,
  options: UseApprovalCountdownOptions = {},
): ApprovalCountdown {
  const { intervalMs = 1000 } = options;
  const nowRef = useRef(options.now ?? Date.now);
  nowRef.current = options.now ?? Date.now;
  const [state, setState] = useState(() => approvalCountdown(expiresAt, nowRef.current()));

  useEffect(() => {
    const read = () => approvalCountdown(expiresAt, nowRef.current());
    const first = read();
    setState(first);
    if (first.remainingMs === null || first.isExpired) {
      return;
    }
    const timer = setInterval(() => {
      const next = read();
      setState(next);
      if (next.isExpired) clearInterval(timer);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [expiresAt, intervalMs]);

  return state;
}
