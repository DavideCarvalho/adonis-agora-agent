import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { StoredKey } from './keys.js';

export interface TokenRecord {
  accessToken: string;
  tokenType: string;
  /** Epoch ms. */
  expiresAt: number;
  scope: string;
  /** RFC 8707 resource this token was issued for, if any. */
  resource?: string | undefined;
}

/** The refresh token of a sign-in (4.4). Stored as `accountToken`, its name before Draft 0.3. */
export interface AccountTokenRecord {
  /** A secret: never logged or shown (10.2). */
  refreshToken: string;
  scope: string;
  obtainedAt: number;
  /** Which sign-in type produced it. */
  via: 'direct' | 'device' | 'mediated';
}

/** The delegated key that signs this User ID's Session JWTs, with its delegation (5.2). */
export interface DelegationRecord {
  key: StoredKey;
  /** The `pap-delegation+jwt`, compact. */
  jwt: string;
  /** Epoch seconds: the delegation's `exp`. */
  exp: number;
}

export interface ConversationRecord {
  endpoint: string;
  /** Last event handled (a cursor / Last-Event-ID). */
  cursor?: string | undefined;
  parentConversationId?: string | undefined;
  createdAt: number;
  closed?: boolean | undefined;
}

/** Everything the agent remembers about one User at one Company, by its identifier (3.2). */
export interface CompanyState {
  /** The Company's identifier: its issuer, or `https://{domain}` without one (3.2). */
  issuer: string;
  /** Whether `issuer` is a real OAuth issuer, not the domain fallback. */
  hasIssuer?: boolean | undefined;
  /** The protocol version this state was written for; an older one drops tokens and Session. */
  protocol?: string | undefined;
  domains: string[];
  /** Opaque, random, per-Company User ID (5.1). Never derived from personal information. */
  userId: string;
  /** DPoP key for this User at this Company. Never published. */
  dpopKey: StoredKey;
  /** One User ID's delegated key: never shared with another User ID (5.2). */
  delegation?: DelegationRecord | undefined;
  accountToken?: AccountTokenRecord | undefined;
  /** Access tokens by key: `default`, or `{resource}|{scope}|{bearer}`. */
  tokens: Record<string, TokenRecord>;
  /** The current Session's `sid`: random, used for no other Session (5.2). Not a credential. */
  sessionId?: string | undefined;
  conversations: Record<string, ConversationRecord>;
}

export interface IdentityState {
  baseUrl: string;
  clientName: string;
  logoUri?: string | undefined;
  keys: StoredKey[];
}

export interface StateFile {
  version: 1;
  identity?: IdentityState | undefined;
  /** Local users ("profiles") of this agent, each with their Companies. */
  profiles: Record<string, { companies: Record<string, CompanyState> }>;
}

export function defaultStatePath(): string {
  if (process.env.POPPY_AGENT_STATE) return process.env.POPPY_AGENT_STATE;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'poppy-agent', 'state.json');
}

/**
 * The local state file. It holds private keys and refresh tokens, so it is written with mode
 * 0600 (directory 0700) and atomically (temp file + rename).
 */
export class StateStore {
  private constructor(
    readonly path: string,
    public data: StateFile,
    private readonly persist?: ((data: StateFile) => Promise<void>) | undefined,
  ) {}

  /**
   * A state kept by the caller instead of a file — a server keeping each user's Companies in its
   * own database. `persist` receives the whole state on every save (serialized, like the file).
   */
  static memory(
    data: StateFile = { version: 1, profiles: {} },
    persist?: (data: StateFile) => Promise<void>,
  ): StateStore {
    data.profiles ??= {};
    return new StateStore('', data, persist);
  }

  static async open(path = defaultStatePath()): Promise<StateStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let data: StateFile = { version: 1, profiles: {} };
    try {
      const raw = await readFile(path, 'utf8');
      data = JSON.parse(raw) as StateFile;
      const st = await stat(path);
      if ((st.mode & 0o077) !== 0) await chmod(path, 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    data.profiles ??= {};
    return new StateStore(path, data);
  }

  /** Directory next to the state file, used for the Direct Sign-In callback relay. */
  get dir(): string {
    return dirname(this.path);
  }

  profile(name: string) {
    this.data.profiles[name] ??= { companies: {} };
    return this.data.profiles[name];
  }

  #saving: Promise<void> = Promise.resolve();

  /**
   * Writes the state atomically (tmp file + rename). Saves are serialized: a conversation stream
   * and the prompt can save at the same time, and two writes sharing one tmp file made the second
   * `rename` fail with ENOENT.
   */
  save(): Promise<void> {
    const run = this.#saving.then(() => this.#write());
    this.#saving = run.catch(() => {});
    return run;
  }

  async #write(): Promise<void> {
    if (this.path === '') {
      await this.persist?.(this.data);
      return;
    }
    const tmp = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }
}
