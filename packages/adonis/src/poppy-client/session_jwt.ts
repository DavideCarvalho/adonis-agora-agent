import { SignJWT } from 'jose';
import { htuOf } from './dpop.js';
import { importSigningKey, type StoredKey } from './keys.js';
import { nowSeconds, randomId, sha256b64url } from './util.js';

export const SESSION_JWT_TYP = 'poppy-session+jwt';

/**
 * The `Poppy-Session` JWT for one request (5.2), signed with the delegated key and carrying its
 * delegation in `pap_dlg`. `kid` is the delegated key's thumbprint, which `StoredKey.kid` holds.
 */
export function signSessionJwt(input: {
  key: StoredKey;
  delegation: string;
  clientId: string;
  /** The Company's identifier (3.2). */
  audience: string;
  sid: string;
  userId: string;
  agentId?: string | undefined;
  method: string;
  url: string | URL;
  accessToken?: string | undefined;
}): Promise<string> {
  return signWith(input);
}

async function signWith(input: Parameters<typeof signSessionJwt>[0]): Promise<string> {
  const claims: Record<string, unknown> = {
    iss: input.clientId,
    aud: input.audience,
    sid: input.sid,
    sub: input.userId,
    htm: input.method.toUpperCase(),
    htu: htuOf(input.url),
    iat: nowSeconds(),
    jti: randomId(),
  };
  if (input.agentId) claims.agent_id = input.agentId;
  if (input.accessToken) claims.ath = sha256b64url(input.accessToken);
  return new SignJWT(claims)
    .setProtectedHeader({
      typ: SESSION_JWT_TYP,
      alg: 'ES256',
      kid: input.key.kid,
      pap_dlg: input.delegation,
    })
    .sign(await importSigningKey(input.key));
}
