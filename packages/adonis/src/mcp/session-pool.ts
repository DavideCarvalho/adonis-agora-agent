import type { McpAuthInfo } from './auth.js';

/** `config/mcp.ts` → `sessions`: how many MCP sessions an endpoint keeps, and for how long. */
export interface McpSessionLimits {
  /** Live sessions per endpoint, all callers together. Past it, `initialize` answers `503`. Default 1000. */
  max?: number;
  /**
   * Live sessions per caller (one token's client and actor). Past it, that caller's least recently
   * used session is closed to make room, so a client that never closes its sessions bounds itself
   * without locking itself out. Default 16.
   */
  maxPerPrincipal?: number;
  /** A session nobody used for this long (ms) is closed. Default 30 minutes. */
  idleTimeoutMs?: number;
}

export const DEFAULT_MCP_SESSION_LIMITS: Required<McpSessionLimits> = {
  max: 1000,
  maxPerPrincipal: 16,
  idleTimeoutMs: 30 * 60_000,
};

/** Validates and fills {@link McpSessionLimits}; throws naming the bad field. */
export function resolveMcpSessionLimits(
  limits: McpSessionLimits | undefined,
): Required<McpSessionLimits> {
  const resolved = { ...DEFAULT_MCP_SESSION_LIMITS, ...(limits ?? {}) };
  for (const key of ['max', 'maxPerPrincipal', 'idleTimeoutMs'] as const) {
    const value = resolved[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(
        `[@adonis-agora/agent] config/mcp.ts: \`sessions.${key}\` must be a positive number`,
      );
    }
  }
  if (resolved.maxPerPrincipal > resolved.max) {
    throw new Error(
      '[@adonis-agora/agent] config/mcp.ts: `sessions.maxPerPrincipal` cannot exceed `sessions.max`',
    );
  }
  return resolved;
}

/**
 * Who a session belongs to: the token's client and the actor it resolved. A session id is a bearer
 * capability on its own, so every later request on it must come from the same principal.
 */
export function mcpPrincipalOf(auth: McpAuthInfo): string {
  return JSON.stringify([auth.clientId ?? '', auth.extra.actor.id]);
}

/** What the pool needs of a transport: closing it (its `onclose` then calls {@link McpSessionPool.delete}). */
export interface ClosableTransport {
  close(): Promise<void>;
}

interface Entry<T> {
  transport: T;
  principal: string;
  lastSeen: number;
}

/** Why a session lookup or a new session was refused. */
export type McpSessionRefusal = 'unknown' | 'other-principal' | 'full';

/**
 * The live sessions of one MCP endpoint: bound to the principal that opened them, capped per
 * principal and overall, and closed after `idleTimeoutMs` without use. In memory, per process.
 */
export class McpSessionPool<T extends ClosableTransport> {
  readonly limits: Required<McpSessionLimits>;
  readonly #entries = new Map<string, Entry<T>>();
  readonly #now: () => number;
  #sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(limits?: McpSessionLimits, options: { now?: () => number } = {}) {
    this.limits = resolveMcpSessionLimits(limits);
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Sessions held by `principal`. */
  countOf(principal: string): number {
    let count = 0;
    for (const entry of this.#entries.values()) if (entry.principal === principal) count += 1;
    return count;
  }

  /**
   * The session's transport, for its own principal only (and marked used). `other-principal` when
   * the id is live but was opened by someone else.
   */
  get(sessionId: string, principal: string): T | McpSessionRefusal {
    const entry = this.#entries.get(sessionId);
    if (entry === undefined) return 'unknown';
    if (this.#expired(entry)) {
      this.#evict(sessionId, entry);
      return 'unknown';
    }
    if (entry.principal !== principal) return 'other-principal';
    entry.lastSeen = this.#now();
    return entry.transport;
  }

  /**
   * Make room for a new session of `principal` and register it under `sessionId`: idle sessions go
   * first, then the principal's least recently used one when it is at its cap. `full` when every
   * slot of the endpoint is held by live sessions.
   */
  open(sessionId: string, principal: string, transport: T): true | 'full' {
    this.sweep();
    while (this.countOf(principal) >= this.limits.maxPerPrincipal) {
      const oldest = this.#oldestOf(principal);
      if (oldest === undefined) break;
      this.#evict(oldest[0], oldest[1]);
    }
    if (this.#entries.size >= this.limits.max) return 'full';
    this.#entries.set(sessionId, { transport, principal, lastSeen: this.#now() });
    return true;
  }

  /** Forget `sessionId` (when it still holds `transport`): the transport closed. */
  delete(sessionId: string, transport?: T): void {
    const entry = this.#entries.get(sessionId);
    if (entry !== undefined && (transport === undefined || entry.transport === transport)) {
      this.#entries.delete(sessionId);
    }
  }

  /** Close every session idle past `idleTimeoutMs`. */
  sweep(): void {
    for (const [id, entry] of this.#entries) if (this.#expired(entry)) this.#evict(id, entry);
  }

  /** Sweep on a timer (unref'd: it never keeps the process alive). */
  startSweeping(): void {
    if (this.#sweeper !== undefined) return;
    const every = Math.max(1_000, Math.min(this.limits.idleTimeoutMs, 60_000));
    this.#sweeper = setInterval(() => this.sweep(), every);
    this.#sweeper.unref?.();
  }

  /** Stop the timer and close every session. */
  async closeAll(): Promise<void> {
    if (this.#sweeper !== undefined) clearInterval(this.#sweeper);
    this.#sweeper = undefined;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map((entry) => entry.transport.close().catch(() => undefined)));
  }

  #expired(entry: Entry<T>): boolean {
    return this.#now() - entry.lastSeen >= this.limits.idleTimeoutMs;
  }

  #oldestOf(principal: string): [string, Entry<T>] | undefined {
    let oldest: [string, Entry<T>] | undefined;
    for (const pair of this.#entries) {
      if (pair[1].principal !== principal) continue;
      if (oldest === undefined || pair[1].lastSeen < oldest[1].lastSeen) oldest = pair;
    }
    return oldest;
  }

  #evict(id: string, entry: Entry<T>): void {
    this.#entries.delete(id);
    void entry.transport.close().catch(() => undefined);
  }
}
