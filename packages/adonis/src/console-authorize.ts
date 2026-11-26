import type { HttpContext } from '@adonisjs/core/http';
import type { AuthorizeResult } from './authorize-decision.js';
import {
  type ConsoleAccess,
  type ConsoleAuthorize,
  type ConsoleAuthorizeResult,
  type ConsoleAuthorizer,
  type ConsoleAuthorizerClass,
  type AuthorizeByTokenOptions as SharedAuthorizeByTokenOptions,
  authorizeByToken as sharedAuthorizeByToken,
  normalizeConsoleAuthorizeResult as sharedNormalize,
} from './dashboard/console_authorize.js';
import type { Actor } from './types.js';

/**
 * The agent's layer over the console access contract every Agora console shares
 * (`./dashboard/console_authorize.ts`, a byte-identical copy apart from its package name): the
 * agent hands `authorize` the resolved {@link Actor} and what the request intends
 * ({@link ConsoleAuthorizeRequest}), reads a machine token as read-only by default, and normalizes
 * every answer to the {@link ConsoleAuthorizeDecision} its gates use.
 */

export type {
  ConsoleAccess,
  ConsoleAuthorize,
  ConsoleAuthorizeResult,
  ConsoleAuthorizer,
  ConsoleAuthorizerClass,
};

/** The tenants a console viewer may see: every one (`'*'`), or these ids. */
export type ConsoleTenants = '*' | string[];

/**
 * What the request asks of the console, handed to the agent console's `authorize` as its third
 * argument: `action: 'read'` for a read (a `GET`), `'write'` for a change (a price, a cross-actor
 * approval or cancellation, an action tool). A hook may decide on it, or answer
 * `{ allowed: true, access: 'read' }` and let the console refuse every change.
 */
export interface ConsoleAuthorizeRequest {
  action: ConsoleAccess;
}

/**
 * What the agent's console hooks may return: the shared {@link ConsoleAuthorizeResult}, or an
 * {@link AuthorizeResult} (`{ allowed: boolean }`, what `authorizeByRoles` from
 * `@adonis-agora/authz` returns).
 */
export type AgentConsoleAuthorizeResult = ConsoleAuthorizeResult | AuthorizeResult;

/**
 * The class form of the agent console's `authorize`. Like {@link ConsoleAuthorizer}, plus the
 * agent's resolved {@link Actor} as an optional second argument (`undefined` when the request has
 * none) — so a class written for any other console works here unchanged.
 */
export interface AgentConsoleAuthorizer {
  authorize(
    ctx: HttpContext,
    actor?: Actor,
    request?: ConsoleAuthorizeRequest,
  ): AgentConsoleAuthorizeResult | Promise<AgentConsoleAuthorizeResult>;
}

// biome-ignore lint/suspicious/noExplicitAny: a constructor of any arity — the container fills it.
export type AgentConsoleAuthorizerClass = new (...args: any[]) => AgentConsoleAuthorizer;

/**
 * The agent console's `dashboard.authorize`: the shared {@link ConsoleAuthorize} (every value of it is
 * accepted), with the resolved {@link Actor} handed over as an optional second argument.
 *
 * ```ts
 * authorize: (ctx) => ctx.auth.user?.isAdmin === true,
 * authorize: (ctx, actor) => actor?.roles?.includes('ADMIN') ?? false,
 * authorize: authorizeByRoles({ roles: ['ADMIN'] }),
 * authorize: (ctx, actor, { action }) => action === 'read' || actor?.roles?.includes('ADMIN'),
 * authorize: ConsoleAccess,
 * authorize: () => import('#policies/console_access'),
 * ```
 */
export type AgentConsoleAuthorize =
  | ((
      ctx: HttpContext,
      actor?: Actor,
      request?: ConsoleAuthorizeRequest,
    ) => AgentConsoleAuthorizeResult | Promise<AgentConsoleAuthorizeResult>)
  | AgentConsoleAuthorizerClass
  | (() => Promise<{ default: AgentConsoleAuthorizerClass }>);

/**
 * A console authorize result, normalised the agent's way: an allow with its grant (`tenants`,
 * `apps`, `capabilities`, `access`), or a denial with its HTTP status, the `redirectTo` path when
 * the hook asked for one (answered `401` to anything but a page navigation), and the thrown error
 * when the hook threw.
 */
export type ConsoleAuthorizeDecision =
  | {
      allowed: true;
      tenants?: ConsoleTenants;
      apps?: ConsoleTenants;
      access?: ConsoleAccess;
      capabilities?: string[];
    }
  | { allowed: false; status: 401 | 403; redirectTo?: string; error?: unknown };

/**
 * Normalise any value an authorize hook returned (the shared contract's rules, fail closed: a
 * malformed `capabilities` allows nothing, a malformed `apps`/`tenants` none), mapped to the agent's
 * {@link ConsoleAuthorizeDecision}. Anything unrecognised denies (`403`).
 */
export function normalizeConsoleAuthorizeResult(result: unknown): ConsoleAuthorizeDecision {
  // `{ allowed: false, redirectTo }` (a denial that names the sign-in page) is a sign-in, as
  // `{ redirectTo }` alone is: a page navigation is redirected, an API call answered `401`.
  if (typeof result === 'object' && result !== null) {
    const { allowed, redirectTo } = result as { allowed?: unknown; redirectTo?: unknown };
    if (allowed !== true && typeof redirectTo === 'string' && redirectTo !== '') {
      return { allowed: false, status: 401, redirectTo };
    }
  }
  const decision = sharedNormalize(result);
  if (decision.allowed) return decision;
  if (decision.status === 302)
    return { allowed: false, status: 401, redirectTo: decision.redirectTo };
  if (decision.status === 401) return { allowed: false, status: 401 };
  return { allowed: false, status: 403 };
}

function isAuthorizerClass(value: unknown): value is AgentConsoleAuthorizerClass {
  return (
    typeof value === 'function' &&
    typeof (value as { prototype?: { authorize?: unknown } }).prototype?.authorize === 'function'
  );
}

function lazyAuthorizerClass(value: unknown): AgentConsoleAuthorizerClass | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as { default?: unknown }).default;
  return isAuthorizerClass(candidate) ? candidate : undefined;
}

async function instantiate(
  Authorizer: AgentConsoleAuthorizerClass,
  ctx: HttpContext,
): Promise<AgentConsoleAuthorizer> {
  const resolver = (ctx as { containerResolver?: HttpContext['containerResolver'] })
    .containerResolver;
  if (resolver !== undefined && typeof resolver.make === 'function') {
    return (await resolver.make(Authorizer)) as AgentConsoleAuthorizer;
  }
  return new Authorizer();
}

/** A resolved console authorize: run it for a request, get a normalised decision. */
export type ResolvedConsoleAuthorize = (
  ctx: HttpContext,
  actor?: Actor,
  request?: ConsoleAuthorizeRequest,
) => Promise<ConsoleAuthorizeDecision>;

/**
 * Turn a console `authorize` (any of the three forms) into one function returning a normalised
 * decision. A class is built through `ctx.containerResolver` on each request; a lazy import is
 * imported once and its class remembered. A thrown error is a `403` denial, never an allow.
 */
export function resolveConsoleAuthorize(
  authorize: AgentConsoleAuthorize,
): ResolvedConsoleAuthorize {
  let lazyClass: AgentConsoleAuthorizerClass | undefined;

  return async (ctx, actor, request) => {
    // Every hook is told what the request intends; a caller that does not say is reading.
    const intent: ConsoleAuthorizeRequest = request ?? { action: 'read' };
    try {
      if (lazyClass !== undefined) {
        return normalizeConsoleAuthorizeResult(
          await (await instantiate(lazyClass, ctx)).authorize(ctx, actor, intent),
        );
      }
      if (isAuthorizerClass(authorize)) {
        return normalizeConsoleAuthorizeResult(
          await (await instantiate(authorize, ctx)).authorize(ctx, actor, intent),
        );
      }
      const result: unknown = await (
        authorize as (
          ctx: HttpContext,
          actor?: Actor,
          request?: ConsoleAuthorizeRequest,
        ) => unknown | Promise<unknown>
      )(ctx, actor, intent);
      const imported = lazyAuthorizerClass(result);
      if (imported !== undefined) {
        lazyClass = imported;
        return normalizeConsoleAuthorizeResult(
          await (await instantiate(imported, ctx)).authorize(ctx, actor, intent),
        );
      }
      return normalizeConsoleAuthorizeResult(result);
    } catch (error) {
      return { allowed: false, status: 403, error };
    }
  };
}

const resolvedByConfig = new WeakMap<AgentConsoleAuthorize, ResolvedConsoleAuthorize>();

/**
 * {@link resolveConsoleAuthorize}, memoised per configured value — so a lazy import configured once
 * in `config/agent.ts` is imported once, however many routes and requests run it.
 */
export function consoleAuthorizeFor(authorize: AgentConsoleAuthorize): ResolvedConsoleAuthorize {
  let resolved = resolvedByConfig.get(authorize);
  if (resolved === undefined) {
    resolved = resolveConsoleAuthorize(authorize);
    resolvedByConfig.set(authorize, resolved);
  }
  return resolved;
}

/**
 * Whether the request is a browser page navigation (it accepts HTML) — the only kind of request a
 * `{ redirectTo }` decision is answered with a redirect; everything else gets a `401`.
 */
export function isPageNavigation(ctx: HttpContext): boolean {
  const header = (ctx.request as { header?: (name: string) => string | undefined } | undefined)
    ?.header;
  if (typeof header !== 'function') return false;
  const accept = header.call(ctx.request, 'accept') ?? '';
  return accept.includes('text/html');
}

/** Options for {@link authorizeByToken}: the shared ones, read-only unless `access: 'write'`. */
export interface AuthorizeByTokenOptions extends SharedAuthorizeByTokenOptions {
  /**
   * What the token's holder may do. Default `'read'`: the console's reads (what an MCP client or a
   * dashboard scraper needs), and every change (a price, a cross-actor approval, an action tool)
   * answers `403`. `'write'` lets the holder change things too.
   */
  access?: ConsoleAccess;
}

/**
 * An `authorize` check for machine access: allows a request whose `Authorization` header is
 * `Bearer <token>`, and answers `{ allowed: false, reason: 'unauthenticated' }` (`401`) otherwise.
 * The shared check, with the agent's default: the token reads (`access: 'read'`); pass
 * `access: 'write'` for one that may also change prices or settle other actors' approvals.
 *
 * ```ts
 * dashboard: { authorize: authorizeByToken({ token: env.get('CONSOLE_TOKEN') }) },
 * ```
 *
 * Throws at config time when `token` is empty or undefined, or `access` is not `'read'`/`'write'`.
 */
export function authorizeByToken(options: AuthorizeByTokenOptions): ConsoleAuthorize {
  const access = options?.access ?? 'read';
  if (access !== 'read' && access !== 'write') {
    throw new Error("[@adonis-agora/agent] authorizeByToken: `access` must be 'read' or 'write'");
  }
  return sharedAuthorizeByToken({ ...options, access });
}

/**
 * An `authorize` that allows a request when ANY of `authorizers` allows it, tried in order — e.g. a
 * machine token for MCP clients OR a signed-in admin for the browser:
 *
 * ```ts
 * dashboard: {
 *   authorize: anyAuthorize(
 *     authorizeByToken({ token: env.get('CONSOLE_TOKEN') }),
 *     (ctx) => ctx.auth.user?.isAdmin === true,
 *   ),
 * },
 * ```
 *
 * When none allows: `401` if any of them said "unauthenticated" (redirecting when one asked to),
 * `403` otherwise. A throwing authorizer counts as a `403` and the next one is still tried. For a
 * change (`action: 'write'`), an allow limited to reading does not stop the search: a later one
 * that grants writing wins, and only when none does is the read-only allow returned (so the change
 * answers `403`).
 */
export function anyAuthorize(...authorizers: AgentConsoleAuthorize[]): AgentConsoleAuthorize {
  if (authorizers.length === 0) {
    throw new Error('[@adonis-agora/agent] anyAuthorize: pass at least one authorize');
  }
  const resolved = authorizers.map((authorize) => resolveConsoleAuthorize(authorize));
  return async (
    ctx: HttpContext,
    actor?: Actor,
    request?: ConsoleAuthorizeRequest,
  ): Promise<ConsoleAuthorizeResult> => {
    let unauthenticated = false;
    let redirectTo: string | undefined;
    let readOnly: ConsoleAuthorizeResult | undefined;
    for (const authorize of resolved) {
      const decision = await authorize(ctx, actor, request);
      if (decision.allowed) {
        const { allowed: _allowed, ...grant } = decision;
        if (decision.access === 'read' && request?.action === 'write') {
          readOnly ??= { allowed: true, ...grant };
          continue;
        }
        return { allowed: true, ...grant };
      }
      if (decision.status !== 401) continue;
      if (decision.redirectTo !== undefined && redirectTo === undefined) {
        redirectTo = decision.redirectTo;
      }
      unauthenticated = true;
    }
    if (readOnly !== undefined) return readOnly;
    if (redirectTo !== undefined) return { redirectTo };
    return unauthenticated
      ? { allowed: false, reason: 'unauthenticated' }
      : { allowed: false, reason: 'forbidden' };
  };
}

/** The boot warning logged once when the console has no `authorize`. Same wording in every console. */
export const NO_CONSOLE_AUTHORIZE_WARNING =
  '[@adonis-agora/agent] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/agent.ts.';

const warnedApps = new WeakSet<object>();

/**
 * Log {@link NO_CONSOLE_AUTHORIZE_WARNING} once per application, however many providers (the agent's
 * governance routes, the console shell) find `authorize` missing.
 */
export function warnNoConsoleAuthorizeOnce(app: object, warn: (message: string) => void): void {
  if (warnedApps.has(app)) return;
  warnedApps.add(app);
  warn(NO_CONSOLE_AUTHORIZE_WARNING);
}

/**
 * Whether the console refuses the request before anything else runs: `authorize` is omitted and the
 * app is in production. (Omitted outside production, the console is open.)
 */
export function consoleClosedByDefault(
  authorize: AgentConsoleAuthorize | undefined,
  inProduction: boolean,
): boolean {
  return authorize === undefined && inProduction;
}
