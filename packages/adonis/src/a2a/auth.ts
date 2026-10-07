import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';

/**
 * Who is calling an A2A endpoint: a personal agent (identified by its `issuer`) speaking for one of
 * ITS users (`sub`, opaque) — and, when the user delegated, the account here it may act on.
 */
export interface A2aCaller {
  /** The personal agent's issuer — stable, and its OAuth `client_id`. */
  issuer: string;
  /** The personal agent's user. NOT an account here. */
  sub: string;
  /** Display name of the personal agent. */
  name: string;
  /** Present when the request carried a valid delegation token. */
  delegation: { accountId: string; scopes: string[]; grantId: string } | null;
}

/** What a receipt records about a turn served under delegation. */
export interface A2aReceiptInput {
  scopesUsed: string[];
  actions: { tool: string; argsHash?: string }[];
}

/**
 * How the A2A surface authenticates callers and speaks the delegation half of the protocol. The
 * built-in driver is {@link authKitPersonalAgents} (`@adonis-agora/authkit-server`); anything
 * implementing this works.
 */
export interface A2aAuth {
  /**
   * Verify the request. On failure, write the response (a bare `401` with the challenge) and return
   * `null`. Called BEFORE the body is read.
   */
  authenticate(ctx: HttpContext): Promise<A2aCaller | null>;
  /** The `securitySchemes` + `securityRequirements` of the Agent Card served at `interfaceUrl`. */
  cardSecurity(ctx: HttpContext, interfaceUrl: string): Promise<Record<string, unknown>>;
  /**
   * The metadata of a step-up task asking the user for `missingScopes` (PACT §5.5), or `null` when
   * this deployment has no delegation to step up into.
   */
  stepUp(ctx: HttpContext, missingScopes: string[]): Promise<Record<string, unknown> | null>;
  /** The metadata carrying a signed receipt for a reply served under delegation (PACT §5.6). */
  receipt(ctx: HttpContext, input: A2aReceiptInput): Promise<Record<string, unknown>>;
  /** Scopes a user can delegate, `id → description` — what the agent may ask for. Empty = none. */
  delegableScopes(): Promise<Record<string, string>>;
}

/** Runtime context an {@link A2aAuthFactory} gets at boot. */
export interface A2aAuthContext {
  app: ApplicationService;
}

export type A2aAuthFactory = (ctx: A2aAuthContext) => A2aAuth | Promise<A2aAuth>;

export async function resolveA2aAuth(
  auth: A2aAuth | A2aAuthFactory,
  ctx: A2aAuthContext,
): Promise<A2aAuth> {
  return typeof auth === 'function' ? auth(ctx) : auth;
}

// ── authKitPersonalAgents ──────────────────────────────────────────────────────

/** The slice of `@adonis-agora/authkit-server` this driver calls. Duck-typed: it is an optional peer. */
interface AuthKitPersonalAgentsModule {
  personalAgentAuth(): (ctx: HttpContext, next: () => Promise<void>) => Promise<unknown>;
  personalAgentOf(ctx: HttpContext): {
    issuer: string;
    sub: string;
    name: string;
    delegation: { accountId: string; scopes: string[]; grantId: string } | null;
  } | null;
  personalAgentSecurity(
    ctx: HttpContext,
    options?: { interfaceUrl?: string },
  ): Promise<Record<string, unknown>>;
  personalAgentStepUp(ctx: HttpContext, missingScopes: string[]): Promise<Record<string, unknown>>;
  personalAgentReceipt(ctx: HttpContext, input: A2aReceiptInput): Promise<Record<string, unknown>>;
}

interface AuthKitServiceLike {
  config: { personalAgents?: { delegation?: { scopes: Record<string, string> } } };
}

/**
 * Requires `@adonis-agora/authkit-server` 0.76 or later (its personal agents). Loaded lazily, like
 * the MCP `authKitAuth` driver, so it is not a declared peer.
 *
 * Authenticate A2A callers with AuthKit's personal agents (`personalAgents` in `config/authkit.ts`):
 * the agent's signed JWT, the delegation token beside it, the Agent Card security block, step-up
 * links and signed receipts — all from `@adonis-agora/authkit-server`, loaded lazily.
 */
export function authKitPersonalAgents(): A2aAuthFactory {
  return async ({ app }) => {
    const authkit = (await import(
      '@adonis-agora/authkit-server' as string
    )) as AuthKitPersonalAgentsModule;
    const middleware = authkit.personalAgentAuth();
    const delegableScopes = async (): Promise<Record<string, string>> => {
      const service = (await app.container.make('authkit.server' as never)) as AuthKitServiceLike;
      return { ...(service.config.personalAgents?.delegation?.scopes ?? {}) };
    };

    return {
      async authenticate(ctx) {
        let passed = false;
        await middleware(ctx, async () => {
          passed = true;
        });
        const caller = passed ? authkit.personalAgentOf(ctx) : null;
        return caller
          ? {
              issuer: caller.issuer,
              sub: caller.sub,
              name: caller.name,
              delegation: caller.delegation,
            }
          : null;
      },
      cardSecurity: (ctx, interfaceUrl) => authkit.personalAgentSecurity(ctx, { interfaceUrl }),
      async stepUp(ctx, missingScopes) {
        if (Object.keys(await delegableScopes()).length === 0) return null;
        return authkit.personalAgentStepUp(ctx, missingScopes);
      },
      receipt: (ctx, input) => authkit.personalAgentReceipt(ctx, input),
      delegableScopes,
    };
  };
}
