import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Seals what a connection keeps at rest — the refresh token, the DPoP and delegated
 * private keys and the access tokens — with AES-256-GCM under a key derived from the app's secret
 * (its `APP_KEY`). A database dump alone does not hand out anybody's access to another company.
 */
export class Sealer {
  readonly #key: Buffer;

  constructor(secret: string) {
    if (typeof secret !== 'string' || secret.length < 16) {
      throw new Error(
        '[@adonis-agora/agent] poppy-connections: the sealing secret must be ≥ 16 chars',
      );
    }
    this.#key = createHash('sha256').update(`poppy-connections:v1:${secret}`).digest();
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), body]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join('.');
  }

  open<T>(sealed: string): T {
    const [version, iv, tag, body] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || body === undefined)
      throw new Error('poppy-connections: unknown sealed format');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8')) as T;
  }
}
