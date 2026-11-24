/**
 * RSA blind signatures (RFC 9474), variant RSABSSA-SHA384-PSS-Deterministic: the signature that
 * comes out is an ordinary PS384 signature (RSASSA-PSS, SHA-384, MGF1-SHA-384, 48-byte salt), so a
 * Company verifies a blindly signed client assertion or delegation like any other (4.1, 5.2, 10.7).
 *
 * The device writes the JWT (with a `jti` it generates itself, the value the signer can't guess),
 * blinds it, has the key in `jwks_uri` sign the blinded message without seeing it, and unblinds the
 * result. The signer never learns which Company a client assertion names, and can't recognize a
 * delegation it signed when a Company shows it.
 */
import {
  createHash,
  createPublicKey,
  constants as cryptoConstants,
  generateKeyPairSync,
  randomBytes,
  verify,
} from 'node:crypto';
import { calculateJwkThumbprint, type JWK } from 'jose';

const HASH = 'sha384';
const H_LEN = 48;
/** PS384 in JWS uses a salt as long as the hash (RFC 7518 section 3.5). */
const S_LEN = 48;

/** A key that signs blinded messages without seeing them: the operator's side of blind signing. */
export interface BlindSigner {
  /** The key's `kid` in `jwks_uri`. */
  readonly kid: string;
  /** The RSA public key, published in `jwks_uri` with `alg: PS384`. */
  readonly publicJwk: JWK;
  /** RSABSSA BlindSign: the blinded message's RSA signature, as many bytes as the modulus. */
  blindSign(blinded: Uint8Array): Promise<Uint8Array>;
}

function b64urlToBigInt(value: string): bigint {
  const hex = Buffer.from(value, 'base64url').toString('hex');
  return hex === '' ? 0n : BigInt(`0x${hex}`);
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  const hex = Buffer.from(bytes).toString('hex');
  return hex === '' ? 0n : BigInt(`0x${hex}`);
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const raw = Buffer.from(hex, 'hex');
  if (raw.length > length) throw new RangeError('integer too large');
  const out = new Uint8Array(length);
  out.set(raw, length - raw.length);
  return out;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y) [x, y] = [y, x % y];
  return x;
}

function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [a % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new RangeError('no inverse');
  return ((oldS % m) + m) % m;
}

function bitLength(n: bigint): number {
  return n.toString(2).length;
}

/** A uniformly random integer in [1, n). */
function randomBelow(n: bigint): bigint {
  const bytes = Math.ceil(bitLength(n) / 8);
  const excess = BigInt(bytes * 8 - bitLength(n));
  for (;;) {
    const r = bytesToBigInt(randomBytes(bytes)) >> excess;
    if (r > 0n && r < n) return r;
  }
}

function mgf1(seed: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let filled = 0;
  for (let counter = 0; filled < length; counter++) {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    const block = createHash(HASH).update(seed).update(c).digest();
    out.set(block.subarray(0, Math.min(block.length, length - filled)), filled);
    filled += block.length;
  }
  return out;
}

/** EMSA-PSS-ENCODE (RFC 8017 section 9.1.1) with SHA-384 and a random 48-byte salt. */
function emsaPssEncode(message: Uint8Array, emBits: number): Uint8Array {
  const emLen = Math.ceil(emBits / 8);
  if (emLen < H_LEN + S_LEN + 2) throw new RangeError('RSA key too small for PS384');
  const mHash = createHash(HASH).update(message).digest();
  const salt = randomBytes(S_LEN);
  const h = createHash(HASH).update(Buffer.alloc(8)).update(mHash).update(salt).digest();
  const db = new Uint8Array(emLen - H_LEN - 1);
  db[emLen - S_LEN - H_LEN - 2] = 0x01;
  db.set(salt, emLen - S_LEN - H_LEN - 1);
  const mask = mgf1(h, db.length);
  for (let i = 0; i < db.length; i++) db[i] = (db[i] ?? 0) ^ (mask[i] ?? 0);
  db[0] = (db[0] ?? 0) & (0xff >> (8 * emLen - emBits));
  const em = new Uint8Array(emLen);
  em.set(db, 0);
  em.set(h, db.length);
  em[emLen - 1] = 0xbc;
  return em;
}

function rsaPublic(jwk: JWK): { n: bigint; e: bigint; length: number } {
  if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
    throw new TypeError('a blind signing key is an RSA key');
  }
  const n = b64urlToBigInt(jwk.n);
  return { n, e: b64urlToBigInt(jwk.e), length: Math.ceil(bitLength(n) / 8) };
}

/** RSABSSA Blind (RFC 9474 section 4.2): the blinded message, and the inverse to unblind with. */
export function blind(publicJwk: JWK, message: Uint8Array): { blinded: Uint8Array; inv: bigint } {
  const { n, e, length } = rsaPublic(publicJwk);
  const encoded = emsaPssEncode(message, bitLength(n) - 1);
  const m = bytesToBigInt(encoded);
  if (gcd(m, n) !== 1n) throw new RangeError('message not coprime with the modulus');
  for (;;) {
    const r = randomBelow(n);
    let inv: bigint;
    try {
      inv = modInverse(r, n);
    } catch {
      continue;
    }
    const z = (m * modPow(r, e, n)) % n;
    return { blinded: bigIntToBytes(z, length), inv };
  }
}

/**
 * RSABSSA BlindSign (RFC 9474 section 4.3), for the operator's key service: signs a blinded message
 * with the private key, checking the result before returning it.
 */
export function blindSignWith(privateJwk: JWK, blinded: Uint8Array): Uint8Array {
  const { n, e, length } = rsaPublic(privateJwk);
  if (typeof privateJwk.d !== 'string') throw new TypeError('blind signing needs the private key');
  const m = bytesToBigInt(blinded);
  if (m >= n) throw new RangeError('blinded message out of range');
  const s = modPow(m, b64urlToBigInt(privateJwk.d), n);
  if (modPow(s, e, n) !== m) throw new Error('blind signature failed its own check');
  return bigIntToBytes(s, length);
}

/**
 * RSABSSA Finalize (RFC 9474 section 4.4): unblinds the signature and verifies it as RSASSA-PSS over
 * `message`. The result is a PS384 signature.
 */
export function finalize(
  publicJwk: JWK,
  message: Uint8Array,
  blindSignature: Uint8Array,
  inv: bigint,
): Uint8Array {
  const { n, length } = rsaPublic(publicJwk);
  if (blindSignature.length !== length) throw new RangeError('bad blind signature length');
  const s = (bytesToBigInt(blindSignature) * inv) % n;
  const signature = bigIntToBytes(s, length);
  const ok = verify(
    HASH,
    message,
    {
      key: createPublicKey({
        key: { kty: 'RSA', n: String(publicJwk.n), e: String(publicJwk.e) },
        format: 'jwk',
      }),
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: S_LEN,
    },
    signature,
  );
  if (!ok) throw new Error('the blind signature does not verify');
  return signature;
}

/** A compact JWS signed blindly with PS384: the header and payload never reach the signer. */
export async function signJwtBlindly(
  signer: BlindSigner,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<string> {
  const protectedHeader = { ...header, alg: 'PS384', kid: signer.kid };
  const input = `${Buffer.from(JSON.stringify(protectedHeader)).toString('base64url')}.${Buffer.from(
    JSON.stringify(payload),
  ).toString('base64url')}`;
  const message = new TextEncoder().encode(input);
  const { blinded, inv } = blind(signer.publicJwk, message);
  const signature = finalize(signer.publicJwk, message, await signer.blindSign(blinded), inv);
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

/** A fresh RSA key for blind signing (3072 bits), with its public JWK as `jwks_uri` publishes it. */
export async function generateBlindSigningKey(
  modulusLength = 3072,
): Promise<{ kid: string; privateJwk: JWK; publicJwk: JWK }> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength });
  const pub = publicKey.export({ format: 'jwk' }) as JWK;
  const priv = privateKey.export({ format: 'jwk' }) as JWK;
  const bare = { kty: 'RSA', n: pub.n, e: pub.e } as JWK;
  const kid = await calculateJwkThumbprint(bare, 'sha256');
  return {
    kid,
    privateJwk: { ...priv, kid, alg: 'PS384', use: 'sig' },
    publicJwk: { ...bare, kid, alg: 'PS384', use: 'sig' },
  };
}

/**
 * A signer that holds the private key in this process. The privacy of blind signing comes from the
 * key living elsewhere (the operator's key service); use this for tests or for that service itself.
 */
export function localBlindSigner(key: {
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
}): BlindSigner {
  return {
    kid: key.kid,
    publicJwk: key.publicJwk,
    blindSign: async (blinded) => blindSignWith(key.privateJwk, blinded),
  };
}
