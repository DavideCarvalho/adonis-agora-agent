import { type JWK, SignJWT } from 'jose';
import { type BlindSigner, signJwtBlindly } from './blind.js';
import { bareEcPublicJwk, importSigningKey, type StoredKey } from './keys.js';
import type { ClientMetadata } from './types.js';
import { nowSeconds, randomId, requireSecureUrl, type SecurityOptions } from './util.js';

export interface IdentityConfig {
  /** Where the identity documents are served, e.g. `https://agent.example`. */
  baseUrl: string;
  clientName: string;
  /** Defaults to `{baseUrl}/logo.svg`, which `serve-identity` serves. */
  logoUri?: string | undefined;
  /** Signing keys; the first one signs. Public halves go in `jwks_uri`. */
  keys: StoredKey[];
  /**
   * Sign client assertions AND delegations blindly with PS384 (10.7): the JWTs are written here, with
   * their `jti`, and the signer (the operator's key service) signs them without seeing them. Its
   * public key is published in `jwks_uri`. `keys` may then be empty.
   */
  blindSigner?: BlindSigner | undefined;
}

/** Lifetime of a client assertion: `exp` MUST be at most 5 minutes after `iat` (4.1). */
export const ASSERTION_TTL_SECONDS = 60;
export const DELEGATION_TYP = 'poppy-delegation+jwt';
/** How long a delegation lasts, within the 24 hours 5.2 allows. */
export const DELEGATION_TTL_SECONDS = 7 * 3600;

/**
 * The Personal Agent's identity (4.1): its `client_id` URL, its metadata document, and the
 * keys from `jwks_uri` that sign client assertions and the delegations of Session JWT keys.
 */
export class AgentIdentity {
  readonly baseUrl: string;
  readonly clientName: string;
  readonly logoUri: string;
  readonly keys: StoredKey[];
  readonly blindSigner: BlindSigner | undefined;

  constructor(cfg: IdentityConfig, sec: SecurityOptions = {}) {
    const base = requireSecureUrl(cfg.baseUrl, 'identity base URL', sec);
    if (base.search || base.hash) throw new TypeError('identity base URL must not have a query');
    this.baseUrl = base.toString().replace(/\/+$/, '');
    this.clientName = cfg.clientName;
    this.logoUri = cfg.logoUri ?? `${this.baseUrl}/logo.svg`;
    if (cfg.keys.length === 0 && !cfg.blindSigner)
      throw new TypeError('identity needs at least one signing key');
    this.keys = cfg.keys;
    this.blindSigner = cfg.blindSigner;
  }

  /** `client_id` is the URL the metadata document is fetched from (4.1). */
  get clientId(): string {
    return `${this.baseUrl}/agent.json`;
  }

  get jwksUri(): string {
    return `${this.baseUrl}/jwks.json`;
  }

  /** Same origin as `client_id`, as 4.1 requires for `redirect_uris`. */
  get redirectUri(): string {
    return `${this.baseUrl}/oauth/callback`;
  }

  /** Extensions aren't declared here: each request declares them in `Poppy-Extensions` (3.4). */
  metadata(): ClientMetadata {
    return {
      client_id: this.clientId,
      client_name: this.clientName,
      logo_uri: this.logoUri,
      jwks_uri: this.jwksUri,
      redirect_uris: [this.redirectUri],
      token_endpoint_auth_method: 'private_key_jwt',
    };
  }

  /** The public key set. Never contains private members. */
  jwks(): { keys: Record<string, unknown>[] } {
    const keys: Record<string, unknown>[] = this.keys.map((k) => ({ ...k.publicJwk }));
    if (this.blindSigner) {
      const { n, e } = this.blindSigner.publicJwk;
      keys.push({ kty: 'RSA', n, e, kid: this.blindSigner.kid, alg: 'PS384', use: 'sig' });
    }
    return { keys };
  }

  /**
   * Signs with the first key, or blindly with PS384 when a blind signer is set: then BOTH client
   * assertions and delegations are signed blindly, as 10.7 requires.
   */
  private async sign(payload: Record<string, unknown>, typ?: string): Promise<string> {
    if (this.blindSigner) return signJwtBlindly(this.blindSigner, typ ? { typ } : {}, payload);
    const key = this.keys[0];
    if (!key) throw new TypeError('identity has no signing key');
    const header: { alg: string; kid: string; typ?: string } = { alg: 'ES256', kid: key.kid };
    if (typ) header.typ = typ;
    return new SignJWT(payload).setProtectedHeader(header).sign(await importSigningKey(key));
  }

  /**
   * `private_key_jwt` client assertion (4.1, RFC 7523): `iss` = `sub` = `client_id`, `aud` = the
   * Company's issuer as a single string, with `iat`, `exp` at most 5 minutes later and a fresh `jti`.
   * The `jti` is generated here, never by a blind signer: it is what keeps a deterministic blind
   * signature safe (10.7).
   */
  clientAssertion(issuer: string): Promise<string> {
    const iat = nowSeconds();
    return this.sign({
      iss: this.clientId,
      sub: this.clientId,
      aud: issuer,
      iat,
      exp: iat + ASSERTION_TTL_SECONDS,
      jti: randomId(),
    });
  }

  /**
   * A delegation (5.2): vouches for one delegated public key. It names no User or Company. Its
   * times are rounded to the hour, as the guides suggest, so they say less about when it was made.
   */
  async delegate(publicJwk: JWK): Promise<{ jwt: string; exp: number }> {
    const iat = Math.floor(nowSeconds() / 3600) * 3600;
    const exp = iat + DELEGATION_TTL_SECONDS;
    const jwt = await this.sign(
      { iss: this.clientId, cnf: { jwk: bareEcPublicJwk(publicJwk) }, iat, exp, jti: randomId() },
      DELEGATION_TYP,
    );
    return { jwt, exp };
  }
}
