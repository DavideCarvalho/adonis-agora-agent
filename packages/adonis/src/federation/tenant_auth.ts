/**
 * What the federated console's channel needs to authenticate a console with a token (authkit's
 * service tenants, typically): where the console gets its token, how the owning app verifies it,
 * and the capability rule. The same contract every Agora control plane uses, so
 * `authkitTenantToken(...)` and `authkitTenantVerifier(...)` from `@adonis-agora/authkit-client`
 * plug in without a wrapper.
 */

/** The resource (RFC 8707) an agent app's console commands answer for: the `aud` of its tokens. */
export const AGENT_CONSOLE_RESOURCE = 'urn:agora:agent';

/**
 * What a console's token (and the viewer the console sends) must hold for each command. A granted
 * `agent:*` or `*` covers them all (see {@link capabilityAllows}).
 */
export const AGENT_CONSOLE_SCOPES = {
  /** Approve or reject a pending tool call (`decide`). */
  decide: 'agent:approvals:decide',
  /** Change a model price (`upsertPrice`). */
  pricingWrite: 'agent:pricing:write',
  /**
   * Every action of the console (the uniform Agora name): covers `decide` and `upsertPrice`, as do
   * `agent:console:*`, `agent:*` and `*`.
   */
  consoleWrite: 'agent:console:write',
  /**
   * Every console read (the uniform Agora name). A known alias that grants nothing today: the
   * agent's console has no read command (it reads the other app's tables directly).
   */
  consoleRead: 'agent:console:read',
} as const;

/** Where a console gets the token each command carries. */
export interface TenantToken {
  get(): Promise<string>;
  /** Drops a cached token (after the app refused it), so the next `get` fetches a fresh one. */
  reset?(): void;
}

/**
 * A fixed token, a function returning one (`authkitTenantToken(...)`, which also has a `reset()`),
 * or an object with `get()`.
 */
export type TenantTokenSource =
  | string
  | (() => Promise<string>)
  | { get(): Promise<string>; reset?(): void; invalidate?(): void };

/** Normalizes every accepted token source into {@link TenantToken}. */
export function resolveTenantToken(source: TenantTokenSource): TenantToken {
  if (typeof source === 'string') {
    if (source === '') throw new Error('[@adonis-agora/agent] console channel: the token is empty');
    return { get: async () => source };
  }
  if (typeof source === 'function') {
    const reset = (source as { reset?: unknown }).reset;
    return {
      get: () => source(),
      ...(typeof reset === 'function' ? { reset: () => reset.call(source) } : {}),
    };
  }
  if (source && typeof source === 'object' && typeof source.get === 'function') {
    const reset = source.reset ?? source.invalidate;
    return {
      get: () => source.get(),
      ...(typeof reset === 'function' ? { reset: () => reset.call(source) } : {}),
    };
  }
  throw new Error(
    '[@adonis-agora/agent] console channel: a token source must be a string, a function returning a token, or an object with get()',
  );
}

/** What the owning app trusts about a console: derived from its verified token, never the message. */
export interface VerifiedTenant {
  /** The app the token is for. A command runs only when it is this app. */
  partition: string;
  /** What the token may do (`agent:approvals:decide`, `agent:pricing:write`). Never defaulted. */
  capabilities: string[];
  /** The service-tenant client behind the token, when it says. */
  clientId?: string;
  /**
   * The token's audience already names this app (an authkit app-call token, `aud =
   * urn:agora:app:<this app>`): `partition` is then the CALLING app (the console's), and the rule
   * "the token's partition is this app" does not apply. Set only by a verifier, never by a message.
   */
  audienceBound?: boolean;
  environment?: string;
  label?: string;
  expiresAt?: number;
}

/** What a verifier receives. Only `token` is trusted, once verified. */
export interface TenantAuthRequest {
  token?: string | undefined;
  /** The app the command is for (this app). Advisory: the verified `partition` decides. */
  partition?: string | undefined;
  tenant?: string | undefined;
  app?: string | undefined;
  headers?: Readonly<Record<string, string | undefined>> | undefined;
}

export type TenantVerifier = (
  request: TenantAuthRequest,
) => VerifiedTenant | null | Promise<VerifiedTenant | null>;

export interface TenantVerifierObject {
  verify(request: TenantAuthRequest): VerifiedTenant | null | Promise<VerifiedTenant | null>;
}

export interface TenantVerifierModule {
  default?: TenantVerifier | TenantVerifierObject | (new () => TenantVerifierObject);
  verify?: TenantVerifier | TenantVerifierObject;
  tenantVerifier?: TenantVerifier | TenantVerifierObject;
}

/** A function, a class instance, a class, or a lazy `() => import(...)` of one. */
export type TenantVerifierInput =
  | TenantVerifier
  | TenantVerifierObject
  | (new () => TenantVerifierObject)
  | (() => Promise<TenantVerifierModule> | TenantVerifierModule);

function hasVerify(value: unknown): value is TenantVerifierObject {
  return (
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { verify?: unknown }).verify === 'function'
  );
}

function isVerifierClass(value: unknown): value is new () => TenantVerifierObject {
  return (
    typeof value === 'function' &&
    typeof (value as { prototype?: { verify?: unknown } }).prototype?.verify === 'function'
  );
}

/**
 * `null` refuses; `{ partition, capabilities }` accepts; anything else throws, so a malformed
 * answer is never taken for an accepted console. Capabilities are not defaulted.
 */
export function checkVerifiedTenant(result: unknown): VerifiedTenant | null {
  if (result === null || result === undefined) return null;
  const value = result as Partial<VerifiedTenant>;
  if (
    typeof value === 'object' &&
    typeof value.partition === 'string' &&
    value.partition.length > 0 &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((capability) => typeof capability === 'string') &&
    (value.clientId === undefined || typeof value.clientId === 'string')
  ) {
    return value as VerifiedTenant;
  }
  throw new TypeError(
    '[@adonis-agora/agent] verifyTenant must return { partition: string, capabilities: string[] } or null',
  );
}

/** Turns any `verifyTenant` form into the function the channel calls. */
export function resolveTenantVerifier(
  input: TenantVerifierInput,
): (request: TenantAuthRequest) => Promise<VerifiedTenant | null> {
  if (isVerifierClass(input)) {
    let instance: TenantVerifierObject | undefined;
    return async (request) => {
      instance ??= new input();
      return checkVerifiedTenant(await instance.verify(request));
    };
  }
  if (hasVerify(input)) {
    return async (request) => checkVerifiedTenant(await input.verify(request));
  }
  if (typeof input !== 'function') {
    throw new TypeError(
      '[@adonis-agora/agent] `verifyTenant` must be a function, an object with verify() (a class instance), or a lazy import of one',
    );
  }
  const fn = input as (request: TenantAuthRequest) => unknown;
  let lazy: Promise<(request: TenantAuthRequest) => Promise<VerifiedTenant | null>> | undefined;
  return async (request) => {
    if (lazy) return (await lazy)(request);
    const result = await fn(request);
    const exported =
      result && typeof result === 'object' && 'default' in (result as Record<string, unknown>)
        ? (result as TenantVerifierModule).default
        : undefined;
    const named =
      exported ??
      (result && typeof result === 'object'
        ? ((result as TenantVerifierModule).tenantVerifier ??
          (result as TenantVerifierModule).verify)
        : undefined);
    if (named !== undefined) {
      lazy = Promise.resolve(resolveTenantVerifier(named as TenantVerifierInput));
      return (await lazy)(request);
    }
    return checkVerifiedTenant(result);
  };
}

/**
 * Whether `granted` covers `required`: the Agora-wide rule. Both sides split on `:`; a granted `*`
 * segment matches exactly one segment, and a trailing `*` also matches any further ones. So `*`
 * and `agent:*` cover `agent:approvals:decide`; nothing else is implied.
 */
export function capabilityAllows(granted: readonly string[], required: string): boolean {
  const want = required.split(':');
  for (const capability of granted) {
    if (typeof capability !== 'string' || capability === '') continue;
    const have = capability.split(':');
    let matched = true;
    for (let index = 0; index < have.length; index += 1) {
      const segment = have[index];
      if (segment === '*') {
        if (index >= want.length && index !== have.length - 1) {
          matched = false;
          break;
        }
        continue;
      }
      if (index >= want.length || segment !== want[index]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    if (have.length === want.length || have[have.length - 1] === '*') return true;
  }
  return false;
}

/** JSON with sorted object keys: the same value always has the same text (and MAC). */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error(`[@adonis-agora/agent] cannot canonicalize ${typeof value}`);
}
