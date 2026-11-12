import { createHash, timingSafeEqual } from 'node:crypto';
import type { HttpContext } from '@adonisjs/core/http';
import { type AuthorizeResult, resolveAuthorizeResult } from './authorize-decision.js';
import type { Actor } from './types.js';

/**
 * What a console `authorize` returns — the contract shared by every `@adonis-agora/*` console
 * (durable, telescope, media, payments, agent, authkit admin). Each lib carries its own identical
 * copy, so one authorizer class satisfies every console.
 *
 * - `true` / `{ allowed: true }` → allowed.
 * - `false` / `{ allowed: false }` / `reason: 'forbidden'` → `403`.
 * - `{ allowed: false, reason: 'unauthenticated' }` → `401`.
 * - `{ redirectTo }` → a `302` to that path for a page navigation, `401` for anything else.
 */
export type ConsoleAuthorizeResult =
  | boolean
  | { allowed: true }
  | { allowed: false; reason?: 'unauthenticated' | 'forbidden' }
  | { redirectTo: string };

/** A class form, for an authorizer in its own file (`@inject()` works). */
export interface ConsoleAuthorizer {
  authorize(ctx: HttpContext): ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>;
}

// biome-ignore lint/suspicious/noExplicitAny: a constructor of any arity — the container fills it.
export type ConsoleAuthorizerClass = new (...args: any[]) => ConsoleAuthorizer;

/**
 * A console `authorize` in one of three forms: an inline function, an authorizer class (built
 * through the container, so `@inject()` works), or a lazy import of a module whose default export
 * is that class.
 */
export type ConsoleAuthorize =
  | ((ctx: HttpContext) => ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>)
  | ConsoleAuthorizerClass
  | (() => Promise<{ default: ConsoleAuthorizerClass }>);

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
 * authorize: ConsoleAccess,
 * authorize: () => import('#policies/console_access'),
 * ```
 */
export type AgentConsoleAuthorize =
  | ((
      ctx: HttpContext,
      actor?: Actor,
    ) => AgentConsoleAuthorizeResult | Promise<AgentConsoleAuthorizeResult>)
  | AgentConsoleAuthorizerClass
  | (() => Promise<{ default: AgentConsoleAuthorizerClass }>);

/**
 * A console authorize result, normalised. A denial carries its HTTP status, the `redirectTo` path
 * when the hook asked for one, and the thrown error when the hook threw.
 */
export type ConsoleAuthorizeDecision =
  | { allowed: true }
  | { allowed: false; status: 401 | 403; redirectTo?: string; error?: unknown };

/** Normalise any value an authorize hook returned. Anything unrecognised denies (`403`). */
export function normalizeConsoleAuthorizeResult(result: unknown): ConsoleAuthorizeDecision {
  if (typeof result === 'object' && result !== null) {
    const redirectTo = (result as { redirectTo?: unknown }).redirectTo;
    if ((result as { allowed?: unknown }).allowed !== true && typeof redirectTo === 'string') {
      return { allowed: false, status: 401, redirectTo };
    }
  }
  return resolveAuthorizeResult(result);
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

  return async (ctx, actor) => {
    try {
      if (lazyClass !== undefined) {
        return normalizeConsoleAuthorizeResult(
          await (await instantiate(lazyClass, ctx)).authorize(ctx, actor),
        );
      }
      if (isAuthorizerClass(authorize)) {
        return normalizeConsoleAuthorizeResult(
          await (await instantiate(authorize, ctx)).authorize(ctx, actor),
        );
      }
      const result: unknown = await (
        authorize as (ctx: HttpContext, actor?: Actor) => unknown | Promise<unknown>
      )(ctx, actor);
      const imported = lazyAuthorizerClass(result);
      if (imported !== undefined) {
        lazyClass = imported;
        return normalizeConsoleAuthorizeResult(
          await (await instantiate(imported, ctx)).authorize(ctx, actor),
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

/** Options for {@link authorizeByToken}. */
export interface AuthorizeByTokenOptions {
  /** The shared secret callers send as `Authorization: Bearer <token>`. */
  token: string | undefined;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * An `authorize` check for machine access: allows a request whose `Authorization` header is
 * `Bearer <token>`, and answers `{ allowed: false, reason: 'unauthenticated' }` (`401`) otherwise.
 *
 * ```ts
 * dashboard: { authorize: authorizeByToken({ token: env.get('CONSOLE_TOKEN') }) },
 * ```
 *
 * Throws at config time when `token` is empty or undefined.
 */
export function authorizeByToken(options: AuthorizeByTokenOptions): ConsoleAuthorize {
  const token = options?.token;
  if (typeof token !== 'string' || token === '') {
    throw new Error('authorizeByToken: `token` must be a non-empty string');
  }
  const expected = digest(token);
  return (ctx: HttpContext): ConsoleAuthorizeResult => {
    const header = ctx.request.header('authorization');
    const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
    if (match?.[1] && timingSafeEqual(digest(match[1]), expected)) return { allowed: true };
    return { allowed: false, reason: 'unauthenticated' };
  };
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
 * `403` otherwise. A throwing authorizer counts as a `403` and the next one is still tried.
 */
export function anyAuthorize(...authorizers: AgentConsoleAuthorize[]): AgentConsoleAuthorize {
  if (authorizers.length === 0) {
    throw new Error('anyAuthorize: pass at least one authorize');
  }
  const resolved = authorizers.map((authorize) => resolveConsoleAuthorize(authorize));
  return async (ctx: HttpContext, actor?: Actor): Promise<ConsoleAuthorizeResult> => {
    let unauthenticated = false;
    let redirectTo: string | undefined;
    for (const authorize of resolved) {
      const decision = await authorize(ctx, actor);
      if (decision.allowed) return { allowed: true };
      if (decision.status !== 401) continue;
      if (decision.redirectTo !== undefined && redirectTo === undefined) {
        redirectTo = decision.redirectTo;
      }
      unauthenticated = true;
    }
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
