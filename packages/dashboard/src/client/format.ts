/** Compact number / currency / model-label formatting for the console. All pure; unit-tested. */

/** Format a USD amount. Small amounts keep precision; large ones read as `$1.20k` / `$3.40M`. */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return '$0.00';
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(amount / 1_000).toFixed(2)}k`;
  if (abs > 0 && abs < 0.01) return '<$0.01';
  return `$${amount.toFixed(2)}`;
}

/** Format a token/count with compact suffixes (`1.2k`, `3.4M`, `1.1B`). */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value)}`;
}

/** Format a 0..1 ratio as an integer percent (`0.1234` -> `12%`). */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '0%';
  return `${Math.round(ratio * 100)}%`;
}

/**
 * Format a millisecond duration compactly (`820ms`, `3.4s`, `2.1m`, `1.3h`). `null`/`undefined`/
 * non-finite → `—` (used for still-running runs and tools that never recorded a latency).
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

/**
 * Shorten a raw model id for display. Bedrock inference-profile ARNs
 * (`arn:aws:bedrock:…:inference-profile/<region>.<provider>.<model>`) overflow cards, so we keep the
 * distinguishing `<model>` and drop the ARN prefix plus the region/provider qualifiers. Non-ARN ids
 * (e.g. `gpt-4o`) pass through unchanged; the full id is surfaced via a `title` tooltip at call sites.
 */
export function formatModelLabel(modelId: string): string {
  if (!modelId.includes('/')) return modelId;
  const profile = modelId.slice(modelId.lastIndexOf('/') + 1);
  return profile.replace(/^[a-z]{2}[a-z-]*\.[a-z0-9]+\./, '');
}

/**
 * A record's created/updated time for a list cell or detail field: a short date (`Mar 7, 2026`) and
 * the full local timestamp for its `title`. `null`/`undefined`/invalid → `{ short: '—', full: '' }`.
 */
export function formatRecordDate(iso: string | null | undefined): { short: string; full: string } {
  if (iso === null || iso === undefined || iso === '') return { short: '—', full: '' };
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { short: '—', full: '' };
  return {
    short: date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
    full: date.toLocaleString(),
  };
}

/** Format an ISO timestamp as a short, locale-stable `MMM D, HH:MM` label; `''`/invalid → `—`. */
export function formatTimestamp(iso: string): string {
  if (iso === '') return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = date.getUTCDate();
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${month} ${day}, ${hh}:${mm}`;
}
