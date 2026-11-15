import { createDecipheriv, createHash } from 'node:crypto';
import {
  createKeyring,
  type EncrypterLike,
  type Keyring,
  type KmsAdapter,
  type LegacyReader,
  open,
  type SealedStatus,
  type SecretLike,
  seal,
  sealedStatus,
} from '../crypto-kit/index.js';

/** Bound into every sealed value: the app's keys never open these values for another use. */
export const POPPY_CONNECTIONS_PURPOSE = 'agent:poppy-connections';

/** How the connections are sealed at rest (`crypto` in `config/poppy_connections.ts`). */
export interface PoppyCryptoConfig {
  /**
   * Keys, newest first: the first seals, every one opens (AES-256-GCM through Adonis' encryption).
   * With `keys`, `agent:crypto:reseal` moves values off the older ones.
   */
  keys?: SecretLike[];
  /**
   * An Adonis encryption instance to seal with. Default: the app's `encryption` service
   * (`config/encryption.ts`), or `secret` when that is set.
   */
  encryption?: EncrypterLike;
  /** Envelope encryption through a KMS: a fresh data key per value, wrapped by the KMS. */
  kms?: KmsAdapter;
}

/** What a value is bound to: copying it to another row makes it unreadable. */
export const connectionStateAad = (owner: string, issuer: string) =>
  `agent_poppy_connection.state:${owner}\n${issuer}`;
export const pendingFlowAad = (id: string) => `agent_poppy_connect.flow:${id}`;

/**
 * Opens what agent sealed before the crypto kit (`v1.<iv>.<tag>.<body>`, AES-256-GCM under
 * sha256("poppy-connections:v1:" + secret)). Read-only: new values use the crypto kit's format.
 */
export function legacySealerReader(secret: SecretLike): LegacyReader {
  const raw = typeof secret === 'string' ? secret : secret.release();
  const key = createHash('sha256').update(`poppy-connections:v1:${raw}`).digest();
  return (sealed) => {
    const [version, iv, tag, body, extra] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || body === undefined || extra !== undefined) {
      return undefined;
    }
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  };
}

/**
 * Seals what a connection keeps at rest — the refresh token, the DPoP and delegated private keys,
 * the access tokens, and the sign-in flows — with the Agora crypto kit over Adonis' encryption,
 * each value bound to its row. Values sealed by older versions still open; `agent:crypto:reseal`
 * rewrites them.
 */
export class Sealer {
  readonly keyring: Keyring;

  /**
   * `secret`: the app key (or `secret` of the config). It opens the values older versions sealed,
   * and seals new ones unless `crypto` names `keys` or an `encryption`.
   */
  constructor(secret: SecretLike, crypto: PoppyCryptoConfig = {}) {
    const raw = typeof secret === 'string' ? secret : secret?.release?.();
    if (typeof raw !== 'string' || raw.length < 16) {
      throw new Error(
        '[@adonis-agora/agent] poppy-connections: the sealing secret must be ≥ 16 chars',
      );
    }
    // Old values were sealed with the sealing secret of the time: any secret still configured.
    const secrets = new Set<string>([raw]);
    for (const key of crypto.keys ?? []) secrets.add(typeof key === 'string' ? key : key.release());
    const source =
      crypto.keys?.length || !crypto.encryption
        ? { keys: crypto.keys?.length ? crypto.keys : [raw] }
        : { encryption: crypto.encryption };
    this.keyring = createKeyring({
      purpose: POPPY_CONNECTIONS_PURPOSE,
      ...source,
      ...(crypto.kms ? { kms: crypto.kms } : {}),
      legacy: [...secrets].map(legacySealerReader),
    });
  }

  seal(value: unknown, aad: string): Promise<string> {
    return seal(this.keyring, JSON.stringify(value), { aad });
  }

  async open<T>(sealed: string, aad: string): Promise<T> {
    return JSON.parse(await open(this.keyring, sealed, { aad })) as T;
  }

  status(sealed: string, aad: string): Promise<SealedStatus> {
    return sealedStatus(this.keyring, sealed, { aad });
  }
}
