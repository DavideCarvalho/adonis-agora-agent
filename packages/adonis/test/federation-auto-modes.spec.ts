// @vitest-environment node
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defineConfig as defineEncryptionConfig, drivers } from '@adonisjs/core/encryption';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import { defineConfig as defineHttpConfig } from '@adonisjs/core/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthkitClientLike, CryptoRuntimeLike } from '../src/federation/auto_crypto.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { InMemoryGovernanceQueries } from '../src/testing/in-memory-governance-queries.js';
import { InMemoryPricingStore } from '../src/testing/in-memory-pricing.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';
import { RedisBus } from './support/redis_bus.js';

/**
 * The automatic modes through the real provider: `@adonis-agora/crypto` (a fake `'agora.crypto'`)
 * and authkit's calls between apps (a fake `'authkit.client'`) booted next to the agent make the
 * federated console authenticate with no auth line in `config/agent.ts`; and a side that cannot
 * authenticate fails the web boot, naming what to add.
 */

type Principal = { partition: string; capabilities: string[]; actor: string };

/** Crypto's rule: exact, `*`, or a prefix wildcard (`crypto:decrypt:console-*`). */
const holds = (granted: string[], wanted: string) =>
  granted.some(
    (capability) =>
      capability === wanted ||
      capability === '*' ||
      (capability.endsWith('*') && wanted.startsWith(capability.slice(0, -1))),
  );

class CryptoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** One crypto server's keys, per partition, checking each caller's capabilities. */
class FakeCryptoService {
  readonly keys = new Map<string, Buffer>();
  readonly created: string[] = [];
  readonly store = {
    getKey: async (partition: string, name: string) =>
      this.keys.has(`${partition}/${name}`) ? { type: 'aes256-gcm' } : null,
  };

  #need(principal: Principal, capability: string) {
    if (!holds(principal.capabilities, capability)) {
      throw new CryptoError('forbidden', `crypto: missing ${capability}`);
    }
  }

  async createKey(principal: Principal, input: { name: string; type: string }) {
    this.#need(principal, `crypto:keys:manage:${input.name}`);
    const id = `${principal.partition}/${input.name}`;
    if (this.keys.has(id)) throw new CryptoError('conflict', 'exists');
    this.keys.set(id, randomBytes(32));
    this.created.push(id);
    return {};
  }

  async encrypt(principal: Principal, input: { key: string; plaintext: string; aad?: string }) {
    this.#need(principal, `crypto:encrypt:${input.key}`);
    return { ciphertext: this.seal(principal.partition, input) };
  }

  seal(partition: string, input: { key: string; plaintext: string; aad?: string }): string {
    const key = this.keys.get(`${partition}/${input.key}`);
    if (!key) throw new CryptoError('not_found', `crypto: no key named "${input.key}"`);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(input.aad ?? ''));
    const body = Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()]);
    return `agora:ct1:${input.key}:1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
  }

  async decrypt(principal: Principal, input: { key: string; ciphertext: string; aad?: string }) {
    this.#need(principal, `crypto:decrypt:${input.key}`);
    const key = this.keys.get(`${principal.partition}/${input.key}`);
    if (!key) throw new CryptoError('not_found', `crypto: no key named "${input.key}"`);
    const raw = Buffer.from(input.ciphertext.split(':').pop()!, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(input.aad ?? ''));
    decipher.setAuthTag(raw.subarray(12, 28));
    return {
      plaintext: Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(),
    };
  }
}

/** The Hub: crypto embedded (a control plane). */
function embedded(service: FakeCryptoService, partition: string): CryptoRuntimeLike {
  const principal = { partition, capabilities: ['crypto:*'], actor: 'app' };
  return {
    topology: 'control-plane',
    partition,
    service: service as never,
    operations: {
      encrypt: (input) => service.encrypt(principal, input),
      decrypt: (input) => service.decrypt(principal, input),
    },
  };
}

/** An app that is a crypto tenant of `service`'s server, holding `capabilities` there. */
function tenant(
  service: FakeCryptoService,
  partition: string,
  capabilities: string[],
): CryptoRuntimeLike & { sealed: string[] } {
  const principal = { partition, capabilities, actor: 'svc' };
  const sealed: string[] = [];
  return {
    topology: 'tenant',
    partition,
    sealed,
    operations: {
      encrypt: async (input) => {
        if (input.partition !== undefined && input.partition !== partition) {
          // The new seal-only path: encrypt with another partition's key, never decrypt there.
          if (!holds(capabilities, `crypto:seal:${input.key}`)) {
            throw new CryptoError('forbidden', `crypto: missing crypto:seal:${input.key}`);
          }
          sealed.push(input.partition);
          return { ciphertext: service.seal(input.partition, input) };
        }
        return service.encrypt(principal, input);
      },
      decrypt: (input) => service.decrypt(principal, input),
      getKey: async (name: string) => {
        if (!(await service.store.getKey(partition, name))) {
          throw new CryptoError('not_found', `crypto: no key named "${name}"`);
        }
        return {};
      },
      createKey: (input: { name: string; type: string }) => service.createKey(principal, input),
    },
  };
}

/** authkit's calls between apps: the console app `hub` gets `capabilities` on every app. */
function authkit(capabilities: string[]): AuthkitClientLike & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    appCallTokens: () => ({
      token: async (app: string) => {
        asked.push(app);
        return `app-call:hub->${app}`;
      },
    }),
    appCallerVerifier: () => ({
      verifyToken: async (token: string) =>
        token.startsWith('app-call:hub->')
          ? { app: 'hub', capabilities, clientId: 'hub-client', expiresAt: Date.now() + 60_000 }
          : null,
    }),
  };
}

interface Started {
  url: string;
  pricing: InMemoryPricingStore;
  close(): Promise<void>;
}

const opened: Started[] = [];
afterEach(async () => {
  for (const app of opened.splice(0)) await app.close();
  vi.restoreAllMocks();
});

async function startApp(options: {
  bus: RedisBus;
  agent: Record<string, unknown>;
  crypto?: CryptoRuntimeLike | undefined;
  authkit?: AuthkitClientLike | undefined;
  environment?: 'web' | 'console';
  appKey?: string;
  noAppKey?: boolean;
}): Promise<Started> {
  const store = new InMemoryAgentStore();
  const pricing = new InMemoryPricingStore();
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: { providers: [() => import('../providers/agent_provider.js')] },
      config: {
        ...(options.appKey !== undefined
          ? { app: { appKey: options.appKey, http: defineHttpConfig({}) } }
          : {}),
        // No APP_KEY anywhere (§13c also reads config/encryption.ts, which the core test config fills).
        ...(options.noAppKey === true
          ? {
              encryption: defineEncryptionConfig({
                list: { none: drivers.aes256gcm({ id: 'none', keys: [''] }) },
              }),
            }
          : {}),
        redis: { connection: 'main', connections: { main: {} } },
        agent: {
          model: new FakeModelProvider(() => ({ text: 'hi' })),
          store,
          pricingStore: pricing,
          actorResolver: { resolve: () => ({ id: 'ana', roles: ['ADMIN'] }) },
          governanceQueries: new InMemoryGovernanceQueries(store),
          ...options.agent,
        },
      },
    })
    .create(new URL('../', import.meta.url));
  const app = ignitor.createApp(options.environment ?? 'web');
  await app.init();
  app.container.bindValue(
    'redis' as never,
    { connection: () => options.bus.connection() } as never,
  );
  if (options.crypto) app.container.bindValue('agora.crypto' as never, options.crypto as never);
  if (options.authkit) app.container.bindValue('authkit.client' as never, options.authkit as never);
  // The provider logs through the app's logger: here, one that writes to the console the tests spy on.
  app.container.bindValue(
    'logger' as never,
    {
      info: (m: unknown) => console.info(m),
      warn: (m: unknown) => console.warn(m),
      error: (m: unknown) => console.error(m),
      debug: () => {},
      trace: () => {},
      fatal: (m: unknown) => console.error(m),
      child() {
        return this;
      },
    } as never,
  );
  try {
    await app.boot();
    await app.start(async () => {});
  } catch (error) {
    await app.terminate().catch(() => undefined);
    throw error;
  }
  let node: Server | undefined;
  let url = '';
  if ((options.environment ?? 'web') === 'web') {
    const server = await app.container.make('server');
    server.use([() => import('@adonisjs/core/bodyparser_middleware')]);
    await server.boot();
    node = createServer(server.handle.bind(server));
    await new Promise<void>((resolve) => node!.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
  }
  const started: Started = {
    url,
    pricing,
    async close() {
      if (node) await new Promise<void>((resolve) => node!.close(() => resolve()));
      await app.terminate();
    },
  };
  opened.push(started);
  return started;
}

/** The Hub's entry for the app `et` (its key is its crypto partition and authkit name). */
const etEntry = (over: Record<string, unknown> = {}) => ({
  dashboard: {
    appLabel: 'Hub',
    apps: {
      et: {
        label: 'Entre Textos',
        governance: new InMemoryGovernanceQueries(new InMemoryAgentStore()),
        controlPlane: { prefix: 'et' },
        timeoutMs: 2_000,
        ...over,
      },
    },
  },
});

const setPrice = (hub: Started) =>
  fetch(`${hub.url}/agent/governance/pricing?app=et`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: 'gpt-x', inputPricePer1m: 1, outputPricePer1m: 2 }),
  });

describe('automatic crypto mode (nothing configured)', () => {
  it('Hub with crypto embedded, app a crypto tenant: the key is created, commands sealed', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const bus = new RedisBus();
    const service = new FakeCryptoService();
    const hub = await startApp({ bus, agent: etEntry(), crypto: embedded(service, 'hub') });
    expect(service.created).toEqual(['et/console-agent']);
    expect(info.mock.calls.flat().join('\n')).toContain(
      '[@adonis-agora/agent] console commands: created the crypto key "console-agent" in partition et',
    );
    const et = await startApp({
      bus,
      agent: { consoleCommands: { prefix: 'et', actions: true } },
      crypto: tenant(service, 'et', ['crypto:decrypt:console-*']),
    });

    const saved = await setPrice(hub);
    expect(saved.status).toBe(200);
    expect(await et.pricing.listCurrentPrices()).toMatchObject([{ modelId: 'gpt-x' }]);
    expect(bus.wire).toContain('agora:ct1:console-agent:');
    expect(bus.wire).not.toContain('gpt-x');
    const lines = info.mock.calls.flat().join('\n');
    expect(lines).toContain(
      '[@adonis-agora/agent] console commands to "et": crypto (auto, key console-agent, partition et)',
    );
    expect(lines).toContain(
      '[@adonis-agora/agent] console commands: crypto (auto, key console-agent); actions on',
    );
  });

  it('a Hub that is itself a crypto tenant seals through its crypto channel (crypto:seal)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const bus = new RedisBus();
    const service = new FakeCryptoService();
    await service.createKey(
      { partition: 'et', capabilities: ['crypto:*'], actor: 'cli' },
      { name: 'console-agent', type: 'aes256-gcm' },
    );
    const hubCrypto = tenant(service, 'hub', ['crypto:seal:console-*']);
    const hub = await startApp({ bus, agent: etEntry(), crypto: hubCrypto });
    const et = await startApp({
      bus,
      agent: { consoleCommands: { prefix: 'et', actions: true } },
      crypto: tenant(service, 'et', ['crypto:decrypt:console-*']),
    });
    expect((await setPrice(hub)).status).toBe(200);
    expect(hubCrypto.sealed).toEqual(['et']);
    expect(await et.pricing.listCurrentPrices()).toHaveLength(1);
  });

  it('a crypto tenant app with no key yet logs one info line, no warning', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await startApp({
      bus: new RedisBus(),
      agent: { consoleCommands: { prefix: 'et' } },
      crypto: tenant(new FakeCryptoService(), 'et', ['crypto:decrypt:console-*']),
    });
    const lines = info.mock.calls.flat().map(String);
    expect(lines.filter((l) => l.includes('does not exist in partition et yet'))).toHaveLength(1);
    expect(lines.join('\n')).toContain(
      "the crypto server creates it on the console's first command (if it has sealProvisioning off: node ace crypto:keys:create console-agent --type aes256-gcm --application et)",
    );
    expect(warn.mock.calls.flat().join('\n')).not.toContain('console-agent');
  });

  it('a crypto tenant app that cannot check the key still logs the line (never silent)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No grant at all: the decrypt probe is refused, so the check cannot tell.
    await startApp({
      bus: new RedisBus(),
      agent: { consoleCommands: { prefix: 'et' } },
      crypto: tenant(new FakeCryptoService(), 'et', []),
    });
    expect(warn.mock.calls.flat().join('\n')).toContain(
      'the crypto server refused this app on the crypto key "console-agent" in partition et (crypto: missing crypto:decrypt:console-agent); no grant is needed for an app\'s own console keys (crypto:decrypt:console-* is harmless if present): check this app\'s crypto token is valid and the crypto server is up to date',
    );
  });

  it('a decrypt-only grant is enough to check the key: an existing one logs nothing', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new FakeCryptoService();
    await service.createKey(
      { partition: 'et', capabilities: ['crypto:*'], actor: 'cli' },
      { name: 'console-agent', type: 'aes256-gcm' },
    );
    await startApp({
      bus: new RedisBus(),
      agent: { consoleCommands: { prefix: 'et' } },
      crypto: tenant(service, 'et', ['crypto:decrypt:console-*']),
    });
    expect(warn.mock.calls.flat().join('\n')).not.toContain('console-agent');
  });

  it('a crypto tenant app allowed to manage the key creates it at boot', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const service = new FakeCryptoService();
    await startApp({
      bus: new RedisBus(),
      agent: { consoleCommands: { prefix: 'et' } },
      crypto: tenant(service, 'et', ['crypto:decrypt:console-*', 'crypto:keys:manage:console-*']),
    });
    expect(service.created).toEqual(['et/console-agent']);
  });

  it('an explicit secret wins: no automatic crypto on top', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const service = new FakeCryptoService();
    await startApp({
      bus: new RedisBus(),
      agent: { consoleCommands: { prefix: 'et', secret: 'a-secret-of-16-chars-or-more' } },
      crypto: embedded(service, 'et'),
    });
    expect(info.mock.calls.flat().join('\n')).toContain(
      'console commands: secret; actions off (set consoleCommands.actions to let the console act)',
    );
    expect(service.created).toEqual([]);
  });
});

describe('automatic authkit app-call token', () => {
  it('combines with crypto: sealed, and the app checks the token (audience-bound)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const bus = new RedisBus();
    const service = new FakeCryptoService();
    const hubAuthkit = authkit([]);
    const hub = await startApp({
      bus,
      agent: etEntry(),
      crypto: embedded(service, 'hub'),
      authkit: hubAuthkit,
    });
    const et = await startApp({
      bus,
      agent: { consoleCommands: { prefix: 'et', actions: true } },
      crypto: tenant(service, 'et', ['crypto:decrypt:console-*']),
      authkit: authkit(['agent:console:*']),
    });
    expect((await setPrice(hub)).status).toBe(200);
    expect(hubAuthkit.asked).toEqual(['et']);
    expect(await et.pricing.listCurrentPrices()).toHaveLength(1);
    const lines = info.mock.calls.flat().join('\n');
    expect(lines).toContain(
      'console commands to "et": crypto (auto, key console-agent, partition et) + token (authkit app-call, auto)',
    );
    expect(lines).toContain(
      'console commands: crypto (auto, key console-agent) + token checked when sent (authkit app-call, auto)',
    );
    expect(lines).toContain('upsertPrice gpt-x by ana via Hub');
  });

  it("the token's capabilities cap the command", async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const bus = new RedisBus();
    const service = new FakeCryptoService();
    const hub = await startApp({
      bus,
      agent: etEntry(),
      crypto: embedded(service, 'hub'),
      authkit: authkit([]),
    });
    const et = await startApp({
      bus,
      agent: { consoleCommands: { prefix: 'et', actions: true } },
      crypto: tenant(service, 'et', ['crypto:decrypt:console-*']),
      authkit: authkit(['agent:approvals:decide']),
    });
    const refused = await setPrice(hub);
    expect(refused.status).toBe(403);
    expect((await refused.json()).message).toContain('agent:pricing:write');
    expect(await et.pricing.listCurrentPrices()).toEqual([]);
  });

  it('a fallback verifier accepts a crypto command without a token (Hub without authkit)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const bus = new RedisBus();
    const service = new FakeCryptoService();
    const hub = await startApp({ bus, agent: etEntry(), crypto: embedded(service, 'hub') });
    const et = await startApp({
      bus,
      agent: { consoleCommands: { prefix: 'et', actions: true } },
      crypto: tenant(service, 'et', ['crypto:decrypt:console-*']),
      authkit: authkit(['agent:console:*']),
    });
    expect((await setPrice(hub)).status).toBe(200);
    expect(await et.pricing.listCurrentPrices()).toHaveLength(1);
  });

  it('a token that is sent must still pass, even with a fallback verifier', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const bus = new RedisBus();
    const service = new FakeCryptoService();
    const forged: AuthkitClientLike = {
      appCallTokens: () => ({ token: async () => 'not-an-app-call-token' }),
    };
    const hub = await startApp({
      bus,
      agent: etEntry(),
      crypto: embedded(service, 'hub'),
      authkit: forged,
    });
    const et = await startApp({
      bus,
      agent: { consoleCommands: { prefix: 'et', actions: true } },
      crypto: tenant(service, 'et', ['crypto:decrypt:console-*']),
      authkit: authkit(['agent:console:*']),
    });
    expect((await setPrice(hub)).status).toBe(401);
    expect(await et.pricing.listCurrentPrices()).toEqual([]);
  });

  it('explicit crypto + explicit verifyTenant: the token is mandatory', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const bus = new RedisBus();
    const service = new FakeCryptoService();
    const hub = await startApp({ bus, agent: etEntry(), crypto: embedded(service, 'hub') });
    const etCrypto = tenant(service, 'et', ['crypto:decrypt:console-*']);
    const et = await startApp({
      bus,
      agent: {
        consoleCommands: {
          prefix: 'et',
          actions: true,
          crypto: { cipher: etCrypto.operations },
          verifyTenant: () => ({ partition: 'et', capabilities: ['agent:*'] }),
        },
      },
    });
    expect((await setPrice(hub)).status).toBe(401);
    expect(await et.pricing.listCurrentPrices()).toEqual([]);
  });

  it('explicit crypto keeps the fallback verifier: a sent token is checked and caps the command', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const bus = new RedisBus();
    const service = new FakeCryptoService();
    const hub = await startApp({
      bus,
      agent: etEntry(),
      crypto: embedded(service, 'hub'),
      authkit: authkit([]),
    });
    const etCrypto = tenant(service, 'et', ['crypto:decrypt:console-*']);
    const et = await startApp({
      bus,
      agent: {
        consoleCommands: { prefix: 'et', actions: true, crypto: { cipher: etCrypto.operations } },
      },
      authkit: authkit(['agent:approvals:decide']),
    });
    const refused = await setPrice(hub);
    expect(refused.status).toBe(403);
    expect((await refused.json()).message).toContain(
      "the console's token lacks agent:pricing:write",
    );
    expect(await et.pricing.listCurrentPrices()).toEqual([]);
  });

  it('console side: the automatic token joins an explicit crypto', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const bus = new RedisBus();
    const service = new FakeCryptoService();
    await service.createKey(
      { partition: 'et', capabilities: ['crypto:*'], actor: 'cli' },
      { name: 'console-agent', type: 'aes256-gcm' },
    );
    const hubAuthkit = authkit([]);
    const hubCrypto = tenant(service, 'hub', ['crypto:seal:console-*']);
    const { consoleSealCipher } = await import('../src/federation/auto_crypto.js');
    const hub = await startApp({
      bus,
      agent: etEntry({
        controlPlane: {
          prefix: 'et',
          crypto: { cipher: consoleSealCipher(hubCrypto.operations as never, 'et') },
        },
      }),
      authkit: hubAuthkit,
    });
    const et = await startApp({
      bus,
      agent: { consoleCommands: { prefix: 'et', actions: true } },
      crypto: tenant(service, 'et', ['crypto:decrypt:console-*']),
      authkit: authkit(['agent:approvals:decide']),
    });
    // The token was sent, so it caps the command: this console may not change prices there.
    const refused = await setPrice(hub);
    expect(refused.status).toBe(403);
    expect((await refused.json()).message).toContain(
      "the console's token lacks agent:pricing:write",
    );
    expect(hubAuthkit.asked).toEqual(['et']);
    expect(await et.pricing.listCurrentPrices()).toEqual([]);
    expect(info.mock.calls.flat().join('\n')).toContain(
      'console commands to "et": crypto (key console-agent) + token (authkit app-call, auto)',
    );
  });

  it('explicit secret keeps token mode beside it when a verifier and an APP_KEY exist', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await startApp({
      bus: new RedisBus(),
      appKey: 'an-app-key-of-32-characters-long!!',
      agent: { consoleCommands: { prefix: 'et', secret: 'a-secret-of-16-chars-or-more' } },
      authkit: authkit([]),
    });
    expect(info.mock.calls.flat().join('\n')).toContain(
      '[@adonis-agora/agent] console commands: token (authkit app-call, auto; sealed to key ',
    );
    const line = info.mock.calls
      .flat()
      .map(String)
      .find((l) => l.includes('sealed to key '))!;
    // A short key id, then the secret and the actions note; never the key material.
    expect(line).toMatch(/sealed to key [\w-]{1,8}\) \+ secret; actions off \(/);
    expect(line).not.toContain('"x"');
    expect(line).not.toContain('kty');
  });

  it('`verifyTenant: false` turns the automatic token check off', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await startApp({
      bus: new RedisBus(),
      agent: { consoleCommands: { prefix: 'et', verifyTenant: false } },
      crypto: embedded(new FakeCryptoService(), 'et'),
      authkit: authkit([]),
    });
    const lines = info.mock.calls.flat().join('\n');
    expect(lines).toContain('console commands: crypto (auto, key console-agent)');
    expect(lines).not.toContain('app-call token');
  });
});

describe("viewer capabilities from the console's authorize", () => {
  const withAuthorize = (authorize: unknown) => {
    const entry = etEntry();
    return { dashboard: { ...entry.dashboard, authorize } };
  };

  it('sends what authorize returns, narrowed to the agent console set', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const bus = new RedisBus();
    const service = new FakeCryptoService();
    // This viewer may settle approvals but not change prices.
    const hub = await startApp({
      bus,
      agent: withAuthorize(() => ({
        allowed: true,
        capabilities: ['agent:approvals:decide', 'flags:console:write'],
      })),
      crypto: embedded(service, 'hub'),
    });
    const et = await startApp({
      bus,
      agent: { consoleCommands: { prefix: 'et', actions: true } },
      crypto: tenant(service, 'et', ['crypto:decrypt:console-*']),
    });
    const refused = await setPrice(hub);
    expect(refused.status).toBe(403);
    expect((await refused.json()).message).toContain('the viewer lacks agent:pricing:write');
    expect(await et.pricing.listCurrentPrices()).toEqual([]);
  });

  it('a wildcard grants every action; no capabilities means the full set', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { agentConsoleCapabilities } = await import('../src/federation/console.js');
    expect(agentConsoleCapabilities(undefined)).toEqual([
      'agent:approvals:decide',
      'agent:pricing:write',
    ]);
    expect(agentConsoleCapabilities(['agent:console:*'])).toHaveLength(2);
    expect(agentConsoleCapabilities(['agent:console:write'])).toHaveLength(2);
    expect(agentConsoleCapabilities(['agent:console:read', 'other:*'])).toEqual([]);
    expect(agentConsoleCapabilities(['agent:approvals:*'])).toEqual(['agent:approvals:decide']);
    expect(agentConsoleCapabilities(['agent:*:decide', '*:approvals:decide'])).toEqual([]);
    const bus = new RedisBus();
    const service = new FakeCryptoService();
    const hub = await startApp({
      bus,
      agent: withAuthorize(() => ({ allowed: true, capabilities: ['agent:console:*'] })),
      crypto: embedded(service, 'hub'),
    });
    await startApp({
      bus,
      agent: { consoleCommands: { prefix: 'et', actions: true } },
      crypto: tenant(service, 'et', ['crypto:decrypt:console-*']),
    });
    expect((await setPrice(hub)).status).toBe(200);
  });
});

describe('misconfiguration fails the web boot', () => {
  it('app side: consoleCommands with no way to authenticate', async () => {
    await expect(
      startApp({ bus: new RedisBus(), agent: { consoleCommands: { prefix: 'et' } } }),
    ).rejects.toThrow(
      expect.objectContaining({
        name: 'ConsoleAuthConfigError',
        message: expect.stringContaining(
          "[@adonis-agora/agent] consoleCommands needs authentication: install and boot @adonis-agora/crypto in this app (automatic, key console-agent), or configure authkit-client's `service` (automatic: the console uses an authkit app-call token; grant it agent:console:* on this app), or set consoleCommands.secret (shared with the console), or consoleCommands.verifyTenant (your own verifier; needs an APP_KEY). Run `node ace agora:doctor` to see every Agora lib's console auth at once. Docs: ",
        ),
      }),
    );
  });

  it('app side: `crypto: false` with crypto booted and nothing else', async () => {
    await expect(
      startApp({
        bus: new RedisBus(),
        agent: { consoleCommands: { prefix: 'et', crypto: false } },
        crypto: embedded(new FakeCryptoService(), 'et'),
      }),
    ).rejects.toThrow(/Docs: \S+ Note: `crypto: false` turned the automatic crypto mode off\.$/);
  });

  it('app side: a verifier without an APP_KEY says so', async () => {
    await expect(
      startApp({
        noAppKey: true,
        bus: new RedisBus(),
        agent: { consoleCommands: { prefix: 'et' } },
        authkit: authkit([]),
      }),
    ).rejects.toThrow(
      / Note: a token verifier is available \(authkit app-call, auto\), but token mode needs an APP_KEY/,
    );
  });

  it('app side: never an ace command', async () => {
    await expect(
      startApp({
        bus: new RedisBus(),
        agent: { consoleCommands: { prefix: 'et' } },
        environment: 'console',
      }),
    ).resolves.toBeDefined();
  });

  it('console side: an app that may take actions but cannot authenticate', async () => {
    await expect(startApp({ bus: new RedisBus(), agent: etEntry() })).rejects.toThrow(
      expect.objectContaining({
        name: 'ConsoleAuthConfigError',
        message:
          '[@adonis-agora/agent] dashboard.apps["et"]: commands to this app need authentication: boot @adonis-agora/crypto in this app (automatic), or set dashboard.apps["et"].controlPlane.secret, or dashboard.apps["et"].controlPlane.token — or actions: false to only browse it. Run `node ace agora:doctor` to see every Agora lib\'s console auth at once.',
      }),
    );
  });

  it('console side: an authkit token alone, with no way to seal it, still fails', async () => {
    await expect(
      startApp({ bus: new RedisBus(), agent: etEntry(), authkit: authkit([]) }),
    ).rejects.toThrow(
      / Note: an authkit app-call token is available, but without crypto .*controlPlane.publicKey/,
    );
  });

  it('console side: browse-only boots without a controlPlane, and actions answer 403', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const hub = await startApp({
      bus: new RedisBus(),
      agent: etEntry({ actions: false, controlPlane: undefined }),
    });
    const refused = await setPrice(hub);
    expect(refused.status).toBe(403);
    expect((await refused.json()).message).toContain('browse-only');
    const apps = await (await fetch(`${hub.url}/agent/governance/apps`)).json();
    expect(apps.apps).toEqual([expect.objectContaining({ id: 'et', actions: 'none' })]);
  });

  it('console side: `crypto: false` turns the automatic mode off', async () => {
    await expect(
      startApp({
        bus: new RedisBus(),
        agent: etEntry({ controlPlane: { prefix: 'et', crypto: false } }),
        crypto: embedded(new FakeCryptoService(), 'hub'),
      }),
    ).rejects.toThrow(/ Note: `crypto: false` turned the automatic crypto mode off\.$/);
  });
});

describe('bring your own cipher', () => {
  it('`crypto.owns` recognizes a ciphertext of another format (a KMS)', async () => {
    const { cryptoConsoleSealer } = await import('../src/federation/redis_channel.js');
    const kms = {
      encrypt: async ({ plaintext }: { plaintext: string }) => ({
        ciphertext: `kms:v1:${Buffer.from(plaintext).toString('base64')}`,
      }),
      decrypt: async ({ ciphertext }: { ciphertext: string }) => ({
        plaintext: Buffer.from(ciphertext.slice(7), 'base64').toString(),
      }),
    };
    const sealer = cryptoConsoleSealer({ cipher: kms, owns: (c) => c.startsWith('kms:v1:') });
    const sealed = await sealer.seal('hello', 'aad');
    expect(sealer.owns(sealed)).toBe(true);
    expect(await sealer.open(sealed, 'aad')).toBe('hello');
    expect(cryptoConsoleSealer({ cipher: kms }).owns(sealed)).toBe(false);
  });
});

describe('doctor: agent.console-commands', () => {
  it('reports each side, errors when unauthenticated, and probes the key when deep', async () => {
    const { checkConsoleCommands } = await import('../src/doctor/console_commands.js');
    const service = new FakeCryptoService();
    const apps = {
      et: {
        governance: new InMemoryGovernanceQueries(new InMemoryAgentStore()),
        controlPlane: { prefix: 'et' },
      },
      shop: {
        governance: new InMemoryGovernanceQueries(new InMemoryAgentStore()),
        controlPlane: { prefix: 'shop' },
        actions: false,
      },
    };
    const env = { crypto: embedded(service, 'hub') };
    const cheap = await checkConsoleCommands({
      consoleCommands: { prefix: 'hub' },
      apps,
      env,
      hasAppKey: false,
      deep: false,
    });
    expect(cheap.map((r) => [r.status, r.message])).toEqual([
      [
        'ok',
        'console commands: crypto (auto, key console-agent); actions off (set consoleCommands.actions to let the console act).',
      ],
      ['ok', 'console commands to "et": crypto (auto, key console-agent, partition et).'],
      ['ok', 'console commands to "shop": browse-only (actions: false).'],
    ]);

    // Deep: the key does not exist until the web process starts.
    const before = await checkConsoleCommands({ apps, env, hasAppKey: false, deep: true });
    expect(before).toEqual([
      expect.objectContaining({
        status: 'warn',
        message: expect.stringContaining('does not exist yet'),
      }),
    ]);
    await service.createKey(
      { partition: 'et', capabilities: ['crypto:*'], actor: 'cli' },
      { name: 'console-agent', type: 'aes256-gcm' },
    );
    const after = await checkConsoleCommands({ apps, env, hasAppKey: false, deep: true });
    expect(after).toEqual([
      expect.objectContaining({
        status: 'ok',
        message: expect.stringContaining('encrypts and decrypts'),
      }),
    ]);

    const broken = await checkConsoleCommands({
      consoleCommands: { prefix: 'hub' },
      apps: { et: apps.et },
      env: {},
      hasAppKey: false,
      deep: false,
    });
    expect(broken.map((r) => r.status)).toEqual(['error', 'error']);
    expect(broken[0]?.fix).toContain('consoleCommands.secret');
    expect(broken[1]?.fix).toContain('actions: false');
  });
});

describe("doctor: a crypto tenant app, with the boot check's classifier", () => {
  it('a usable key is ok; a missing one is ok with a note; a refusal warns', async () => {
    const { checkConsoleCommands } = await import('../src/doctor/console_commands.js');
    const service = new FakeCryptoService();
    const run = (capabilities: string[]) =>
      checkConsoleCommands({
        consoleCommands: { prefix: 'et' },
        apps: {},
        env: { crypto: tenant(service, 'et', capabilities) },
        hasAppKey: false,
        deep: true,
      });
    // Missing on a tenant: fine, with a note (the server provisions it on the first seal).
    const missing = await run(['crypto:decrypt:console-*']);
    expect(missing[0]).toMatchObject({
      status: 'ok',
      message: expect.stringContaining("creates it on the console's first command"),
    });
    await service.createKey(
      { partition: 'et', capabilities: ['crypto:*'], actor: 'cli' },
      { name: 'console-agent', type: 'aes256-gcm' },
    );
    expect((await run(['crypto:decrypt:console-*']))[0]).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('is usable here'),
    });
    expect((await run([]))[0]).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('refused this app'),
    });
  });
});

describe('never crash on a bad message', () => {
  it('drops garbage on the command channel, logs each reason once, and keeps serving', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new RedisBus();
    const secret = 'a-secret-of-16-chars-or-more';
    const hub = await startApp({
      bus,
      agent: etEntry({ controlPlane: { prefix: 'et', secret } }),
    });
    const et = await startApp({
      bus,
      agent: { consoleCommands: { prefix: 'et', actions: true, secret } },
    });
    const raw = bus.connection();
    for (const garbage of [
      'not json',
      'not json',
      'null',
      '{"no":"id"}',
      JSON.stringify({ id: 'x', sealed: 'agora:ct1:console-agent:1:AAAA' }),
      JSON.stringify({ id: 'y', verb: 'upsertPrice', args: [], mac: 'forged' }),
      '\u0000\uffff',
    ]) {
      await raw.publish('et-agent-console', garbage);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Still serving.
    expect((await setPrice(hub)).status).toBe(200);
    expect(await et.pricing.listCurrentPrices()).toHaveLength(1);
    const lines = warn.mock.calls.flat().map(String);
    const refused = (reason: string) =>
      lines.filter(
        (line) => line === `[@adonis-agora/agent] console commands: refused a command (${reason})`,
      );
    expect(refused('not JSON')).toHaveLength(1);
    expect(refused('no command id')).toHaveLength(1);
    expect(refused('bad signature')).toHaveLength(1);
    expect(
      refused('mode not accepted here (this app accepts: secret; the command came as crypto)'),
    ).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('unsigned?');
  });
});

describe("authkit's key directory (token mode without crypto)", () => {
  /** An authkit-client manager with app-call tokens, verifier and the key directory. */
  function directoryAuthkit(directory: Map<string, unknown>, capabilities: string[]) {
    const published: Array<{ purpose: string; jwk: Record<string, unknown> }> = [];
    const asked: Array<{ app: string; purpose: string }> = [];
    return {
      published,
      asked,
      client: {
        ...authkit(capabilities),
        publishAppKey: async (input: { purpose: string; jwk: Record<string, unknown> }) => {
          published.push(input);
          directory.set(`et/${input.purpose}`, input.jwk);
        },
        appKey: async (input: { app: string; purpose: string }) => {
          asked.push(input);
          return (directory.get(`${input.app}/${input.purpose}`) as never) ?? null;
        },
      } as AuthkitClientLike,
    };
  }

  it('the app publishes its public key; the console seals to it, with no publicKey to copy', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const bus = new RedisBus();
    const directory = new Map<string, unknown>();
    const app = directoryAuthkit(directory, ['agent:console:*']);
    const et = await startApp({
      bus,
      appKey: 'an-app-key-of-32-characters-long!!',
      agent: { consoleCommands: { prefix: 'et', actions: true } },
      authkit: app.client,
    });
    expect(app.published).toHaveLength(1);
    const published = app.published[0]!;
    expect(published.purpose).toBe('console:agent');
    expect(published.jwk).toMatchObject({ kty: 'OKP', crv: 'X25519' });
    expect(published.jwk).not.toHaveProperty('d');

    const info = vi.mocked(console.info);
    const hub = directoryAuthkit(directory, []);
    const console_ = await startApp({ bus, agent: etEntry(), authkit: hub.client });
    const kid = String(published.jwk.kid).slice(0, 8);
    const logged = () => info.mock.calls.flat().join('\n');
    expect(logged()).toContain(
      'console commands to "et": token (authkit app-call, auto, authkit key directory; sealed to the key the app publishes)',
    );
    expect(logged()).toContain(
      `console commands: token (authkit app-call, auto; sealed to key ${kid}); actions on`,
    );
    // Not looked up at boot: the first command fetches it.
    expect(hub.asked).toEqual([]);
    expect((await setPrice(console_)).status).toBe(200);
    expect(hub.asked).toEqual([{ app: 'et', purpose: 'console:agent' }]);
    expect(await et.pricing.listCurrentPrices()).toHaveLength(1);
  });

  it('a console booting before the app (nothing published yet) boots quietly', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hub = directoryAuthkit(new Map(), []);
    await startApp({ bus: new RedisBus(), agent: etEntry(), authkit: hub.client });
    expect(hub.asked).toEqual([]);
    expect(info.mock.calls.flat().join('\n')).toContain(
      'console commands to "et": token (authkit app-call, auto, authkit key directory; sealed to the key the app publishes)',
    );
    expect(warn.mock.calls.flat().join('\n')).not.toMatch(/published|directory/);
  });

  it('an explicit publicKey wins over the directory', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const bus = new RedisBus();
    const directory = new Map<string, unknown>();
    const appKey = 'an-app-key-of-32-characters-long!!';
    await startApp({
      bus,
      appKey,
      agent: { consoleCommands: { prefix: 'et', actions: true } },
      authkit: directoryAuthkit(directory, ['agent:console:*']).client,
    });
    const { consoleCommandKeys } = await import('../src/federation/console.js');
    const { publicJwk } = await import('../src/crypto-kit/index.js');
    const hub = directoryAuthkit(directory, []);
    const console_ = await startApp({
      bus,
      agent: etEntry({
        controlPlane: {
          prefix: 'et',
          publicKey: publicJwk(consoleCommandKeys(appKey, 'et').publicKey),
        },
      }),
      authkit: hub.client,
    });
    expect((await setPrice(console_)).status).toBe(200);
    expect(hub.asked).toEqual([]);
  });

  it('an app missing from the directory answers 503 with what to do', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hub = directoryAuthkit(new Map(), []);
    const console_ = await startApp({ bus: new RedisBus(), agent: etEntry(), authkit: hub.client });
    const refused = await setPrice(console_);
    expect(refused.status).toBe(503);
    expect((await refused.json()).message).toContain(
      `"et" has no console key in authkit's key directory: set its controlPlane.publicKey`,
    );
  });
});

describe('mixed Hubs: some apps with crypto, some without (§13)', () => {
  const appKey = 'an-app-key-of-32-characters-long!!';

  /** One authkit: app-call tokens for the Hub, a verifier per app, and the shared key directory. */
  function authkitFor(
    app: string,
    directory: Map<string, unknown>,
    options: { capabilities?: string[]; mint?: (target: string) => Promise<string> } = {},
  ) {
    const published: Array<{ purpose: string }> = [];
    const asked: string[] = [];
    const client: AuthkitClientLike = {
      ...authkit(options.capabilities ?? ['agent:console:*']),
      ...(options.mint !== undefined
        ? { appCallTokens: () => ({ token: options.mint as (target: string) => Promise<string> }) }
        : {}),
      publishAppKey: async (input) => {
        published.push(input);
        directory.set(`${app}/${input.purpose}`, input.jwk);
      },
      appKey: async (input) => {
        asked.push(input.app);
        return (directory.get(`${input.app}/${input.purpose}`) as never) ?? null;
      },
    };
    return { client, published, asked };
  }

  const governance = () => new InMemoryGovernanceQueries(new InMemoryAgentStore());
  const hubApps = (...apps: string[]) => ({
    dashboard: {
      appLabel: 'Hub',
      apps: Object.fromEntries(
        apps.map((app) => [
          app,
          { governance: governance(), controlPlane: { prefix: app }, timeoutMs: 1_000 },
        ]),
      ),
    },
  });
  const priceOn = (hub: Started, app: string) =>
    fetch(`${hub.url}/agent/governance/pricing?app=${app}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'gpt-x', inputPricePer1m: 1, outputPricePer1m: 2 }),
    });

  it('picks per app on the first command: crypto for the crypto app, token for the authkit-only one', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new RedisBus();
    const service = new FakeCryptoService();
    const directory = new Map<string, unknown>();
    const hubAuthkit = authkitFor('hub', directory, { capabilities: [] });
    const hub = await startApp({
      bus,
      agent: hubApps('et', 'edu'),
      crypto: embedded(service, 'hub'),
      authkit: hubAuthkit.client,
    });
    const lines = () => info.mock.calls.flat().join('\n');
    for (const app of ['et', 'edu']) {
      expect(lines()).toContain(
        `console commands to "${app}": auto (authkit key directory if the app publishes one, else crypto (auto, key console-agent, partition ${app}))`,
      );
    }
    // Boot stays quiet: nothing looked up yet.
    expect(hubAuthkit.asked).toEqual([]);

    // ET: a crypto tenant (with an APP_KEY and authkit too): crypto reaches it, so it publishes nothing.
    const etAuthkit = authkitFor('et', directory);
    const et = await startApp({
      bus,
      appKey,
      agent: { consoleCommands: { prefix: 'et', actions: true } },
      crypto: tenant(service, 'et', ['crypto:decrypt:console-*']),
      authkit: etAuthkit.client,
    });
    expect(etAuthkit.published).toEqual([]);
    // EduLiberta: authkit only: token mode, and it publishes its key.
    const eduAuthkit = authkitFor('edu', directory);
    const edu = await startApp({
      bus,
      appKey,
      agent: { consoleCommands: { prefix: 'edu', actions: true } },
      authkit: eduAuthkit.client,
    });
    expect(eduAuthkit.published).toHaveLength(1);

    expect((await priceOn(hub, 'et')).status).toBe(200);
    expect((await priceOn(hub, 'edu')).status).toBe(200);
    expect(await et.pricing.listCurrentPrices()).toHaveLength(1);
    expect(await edu.pricing.listCurrentPrices()).toHaveLength(1);
    const sealedOn = (channel: string) =>
      bus.published
        .filter((p) => p.channel === channel)
        .map((p) => (JSON.parse(p.message) as { sealed?: string }).sealed?.slice(0, 10));
    expect(sealedOn('et-agent-console')).toEqual(['agora:ct1:']);
    expect(sealedOn('edu-agent-console')).toEqual(['agora:pk1:']);
    // The choice is cached (the AutoModeChannel test below); a second command still goes as token.
    expect((await priceOn(hub, 'edu')).status).toBe(200);
    expect(sealedOn('edu-agent-console')).toEqual(['agora:pk1:', 'agora:pk1:']);
  });

  it('publishes (or warns it cannot) only when token mode is the only way to reach the app', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const line =
      "[@adonis-agora/agent] console commands: token mode is this app's only way to be reached, but authkit-client's `service` is not configured, so its key is not in authkit's key directory: configure it, or give each console controlPlane.publicKey (`node ace agent:console-key` prints it)";
    // authkit verifies tokens, but no `service` to publish with: token mode is all there is.
    const { publishAppKey: _p, appKey: _a, ...verifierOnly } = authkitFor('edu', new Map()).client;
    await startApp({
      bus: new RedisBus(),
      appKey,
      agent: { consoleCommands: { prefix: 'edu', actions: true } },
      authkit: verifierOnly,
    });
    expect(warn.mock.calls.flat().filter((l) => l === line)).toHaveLength(1);
    // With crypto as well: crypto is enough, nothing published, nothing said.
    warn.mockClear();
    await startApp({
      bus: new RedisBus(),
      appKey,
      agent: { consoleCommands: { prefix: 'et', actions: true } },
      crypto: tenant(new FakeCryptoService(), 'et', ['crypto:decrypt:console-*']),
      authkit: verifierOnly,
    });
    expect(warn.mock.calls.flat().join('\n')).not.toContain('key directory');
  });

  it('publishes with crypto too when crypto commands must carry a token (explicit crypto + verifyTenant)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new FakeCryptoService();
    const etCrypto = tenant(service, 'et', ['crypto:decrypt:console-*']);
    const required = authkitFor('et', new Map());
    await startApp({
      bus: new RedisBus(),
      appKey,
      agent: {
        consoleCommands: {
          prefix: 'et',
          actions: true,
          crypto: { cipher: etCrypto.operations },
          verifyTenant: () => ({ partition: 'et', capabilities: ['agent:*'] }),
        },
      },
      authkit: required.client,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(required.published.map((p) => p.purpose)).toEqual(['console:agent']);
    // Automatic crypto (the token only checked when sent): nothing published.
    const optional = authkitFor('et', new Map());
    await startApp({
      bus: new RedisBus(),
      appKey,
      agent: { consoleCommands: { prefix: 'et', actions: true } },
      crypto: tenant(service, 'et', ['crypto:decrypt:console-*']),
      authkit: optional.client,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(optional.published).toEqual([]);
  });

  it('a failing app-call token never blocks a crypto command: sent crypto-only, said once', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new RedisBus();
    const service = new FakeCryptoService();
    let mints = 0;
    const hub = await startApp({
      bus,
      agent: hubApps('et'),
      crypto: embedded(service, 'hub'),
      authkit: authkitFor('hub', new Map(), {
        mint: async () => {
          mints += 1;
          throw new Error('invalid_target');
        },
      }).client,
    });
    const et = await startApp({
      bus,
      agent: { consoleCommands: { prefix: 'et', actions: true } },
      crypto: tenant(service, 'et', ['crypto:decrypt:console-*']),
      authkit: authkitFor('et', new Map()).client,
    });
    expect((await priceOn(hub, 'et')).status).toBe(200);
    expect((await priceOn(hub, 'et')).status).toBe(200);
    expect(await et.pricing.listCurrentPrices()).toHaveLength(1);
    const line =
      '[@adonis-agora/agent] console commands to "et": sending without an authkit app-call token (crypto only): invalid_target. To attach it: grant the console\'s service client agent:console:* on "et" in authkit.';
    // A missing grant is info, once; never a warning.
    expect(info.mock.calls.flat().filter((l) => l === line)).toHaveLength(1);
    expect(warn.mock.calls.flat().join('\n')).not.toContain('sending without');
    // Retried after 5 minutes, not on every command.
    expect(mints).toBe(1);
  });

  it('auto-chosen token mode whose token cannot be minted goes by crypto, with the §13b warning', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new RedisBus();
    const service = new FakeCryptoService();
    const directory = new Map<string, unknown>();
    // An old version of ET published a key, then moved to crypto: the key is stale.
    const old = authkitFor('et', directory);
    await old.client.publishAppKey?.({
      purpose: 'console:agent',
      jwk: {
        kty: 'OKP',
        crv: 'X25519',
        x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        kid: 'stale',
      },
    });
    const hub = await startApp({
      bus,
      agent: hubApps('et'),
      crypto: embedded(service, 'hub'),
      authkit: authkitFor('hub', directory, {
        mint: async () => {
          throw new Error('invalid_target');
        },
      }).client,
    });
    const et = await startApp({
      bus,
      agent: { consoleCommands: { prefix: 'et', actions: true } },
      crypto: tenant(service, 'et', ['crypto:decrypt:console-*']),
      authkit: authkitFor('et', new Map()).client,
    });
    expect((await priceOn(hub, 'et')).status).toBe(200);
    expect(await et.pricing.listCurrentPrices()).toHaveLength(1);
    expect(
      bus.published
        .filter((p) => p.channel === 'et-agent-console')
        .map((p) => (JSON.parse(p.message) as { sealed?: string }).sealed?.slice(0, 10)),
    ).toEqual(['agora:ct1:']);
    expect(vi.mocked(console.info).mock.calls.flat().join('\n')).toContain(
      'console commands to "et": sending without an authkit app-call token (crypto only): invalid_target.',
    );
    void warn;
  });

  it('any other mint failure (authkit unreachable) is a warning, same wording', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new RedisBus();
    const service = new FakeCryptoService();
    const hub = await startApp({
      bus,
      agent: hubApps('et'),
      crypto: embedded(service, 'hub'),
      authkit: authkitFor('hub', new Map(), {
        mint: async () => {
          throw new Error('fetch failed: ECONNREFUSED');
        },
      }).client,
    });
    await startApp({
      bus,
      agent: { consoleCommands: { prefix: 'et', actions: true } },
      crypto: tenant(service, 'et', ['crypto:decrypt:console-*']),
      authkit: authkitFor('et', new Map()).client,
    });
    expect((await priceOn(hub, 'et')).status).toBe(200);
    const line =
      '[@adonis-agora/agent] console commands to "et": sending without an authkit app-call token (crypto only): fetch failed: ECONNREFUSED. To attach it: grant the console\'s service client agent:console:* on "et" in authkit.';
    expect(warn.mock.calls.flat().filter((l) => l === line)).toHaveLength(1);
    expect(info.mock.calls.flat().join('\n')).not.toContain('sending without');
  });

  it('in token mode the token is required: a failing mint fails the command, with the grant hint', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new RedisBus();
    const directory = new Map<string, unknown>();
    await startApp({
      bus,
      appKey,
      agent: { consoleCommands: { prefix: 'edu', actions: true } },
      authkit: authkitFor('edu', directory).client,
    });
    const hub = await startApp({
      bus,
      agent: hubApps('edu'),
      authkit: authkitFor('hub', directory, {
        mint: async () => {
          throw new Error('invalid_target');
        },
      }).client,
    });
    const refused = await priceOn(hub, 'edu');
    expect(refused.status).toBe(503);
    expect((await refused.json()).message).toContain(
      'invalid_target. To attach it: grant the console\'s service client agent:console:* on "edu" in authkit.',
    );
  });
});

describe('AutoModeChannel (§13a)', () => {
  const sender = (name: string, calls: string[], fail?: () => Error | undefined) => ({
    send: async (command: { id: string }) => {
      calls.push(name);
      const error = fail?.();
      if (error) throw error;
      return { id: command.id, ok: true as const, data: null };
    },
    close: async () => {},
  });

  it('chooses once, again after 5 minutes, and again when the app did not answer', async () => {
    const { AutoModeChannel } = await import('../src/federation/console.js');
    const calls: string[] = [];
    let published = false;
    let lookups = 0;
    let now = 0;
    let unreachable = false;
    const auto = new AutoModeChannel(
      {
        token: sender('token', calls, () =>
          unreachable
            ? Object.assign(new Error('no answer'), { code: 'federated-app-unreachable' })
            : (undefined as never),
        ),
        crypto: sender('crypto', calls),
      },
      async () => {
        lookups += 1;
        return published;
      },
      () => now,
    );
    const command = { id: 'c', verb: 'decide', args: [] } as never;
    await auto.send(command);
    await auto.send(command);
    expect(calls).toEqual(['crypto', 'crypto']);
    expect(lookups).toBe(1);
    // The app starts publishing: picked up after the 5-minute cache.
    published = true;
    now = 4 * 60_000;
    await auto.send(command);
    now = 5 * 60_000 + 1;
    await auto.send(command);
    expect(calls.slice(2)).toEqual(['crypto', 'token']);
    expect(lookups).toBe(2);
    // Nobody answered in token mode: chosen again on the next command.
    unreachable = true;
    await expect(auto.send(command)).rejects.toThrow('no answer');
    unreachable = false;
    await auto.send(command);
    expect(lookups).toBe(3);
  });

  it('sends by crypto when the token cannot be minted, and holds crypto for 5 minutes (§13b)', async () => {
    const { AutoModeChannel } = await import('../src/federation/console.js');
    const { TOKEN_UNAVAILABLE } = await import('../src/federation/redis_channel.js');
    const calls: string[] = [];
    const warned: string[] = [];
    let now = 0;
    let lookups = 0;
    const auto = new AutoModeChannel(
      {
        token: sender('token', calls, () =>
          Object.assign(new Error('invalid_target'), {
            code: TOKEN_UNAVAILABLE,
            reason: 'invalid_target',
          }),
        ),
        crypto: sender('crypto', calls),
      },
      async () => {
        lookups += 1;
        return true;
      },
      () => now,
      (reason) => warned.push(reason),
    );
    const command = { id: 'c', verb: 'decide', args: [] } as never;
    await expect(auto.send(command)).resolves.toMatchObject({ ok: true });
    expect(calls).toEqual(['token', 'crypto']);
    expect(warned).toEqual(['invalid_target']);
    // Inside the window: straight to crypto, no failing mint per command.
    now = 4 * 60_000;
    await auto.send(command);
    expect(calls.slice(2)).toEqual(['crypto']);
    expect(auto.mode).toBe('crypto');
    expect(lookups).toBe(1);
    // After 5 minutes: decided again (token again, since the app still publishes).
    now = 9 * 60_000 + 1;
    await auto.send(command);
    expect(calls.slice(3)).toEqual(['token', 'crypto']);
    expect(lookups).toBe(2);
  });
});

describe('the key check with crypto’s hasKey (§13f)', () => {
  const runtimeWith = (hasKey: (input: { key: string }) => Promise<boolean>, decrypts: string[]) =>
    ({
      topology: 'tenant',
      partition: 'et',
      operations: {
        hasKey,
        encrypt: async () => ({ ciphertext: '' }),
        decrypt: async () => {
          decrypts.push('probe');
          throw Object.assign(new Error('crypto: cannot open the ciphertext'), { code: 'invalid' });
        },
      },
    }) as never;

  it('asks hasKey (no decrypt probe), and falls back to the probe on an older server', async () => {
    const { checkTenantConsoleKey } = await import('../src/federation/auto_crypto.js');
    const decrypts: string[] = [];
    expect(await checkTenantConsoleKey(runtimeWith(async () => true, decrypts))).toBeUndefined();
    expect(await checkTenantConsoleKey(runtimeWith(async () => false, decrypts))).toMatchObject({
      level: 'info',
      line: expect.stringContaining('does not exist in partition et yet'),
    });
    expect(decrypts).toEqual([]);
    // An older crypto server without the route: the decrypt probe decides (the key is usable).
    expect(
      await checkTenantConsoleKey(
        runtimeWith(async () => {
          throw Object.assign(new Error('Not Found: no route'), { status: 404 });
        }, decrypts),
      ),
    ).toBeUndefined();
    expect(decrypts).toEqual(['probe']);
    // A refusal is the "no permission" outcome, not a fallback.
    expect(
      await checkTenantConsoleKey(
        runtimeWith(async () => {
          throw Object.assign(new Error('crypto: forbidden'), { code: 'forbidden' });
        }, decrypts),
      ),
    ).toMatchObject({ level: 'warn', line: expect.stringContaining('refused this app') });
    expect(decrypts).toEqual(['probe']);
  });
});

describe('§13b: a missing grant is info, anything else a warning', () => {
  it('classifies the mint failure the same way in every lib', async () => {
    const { isMissingGrant } = await import('../src/federation/console_auth.js');
    const error = (message: string, code?: string) =>
      Object.assign(new Error(message), code !== undefined ? { code } : {});
    // Missing grant: info.
    expect(isMissingGrant(error('authkit answered 400', 'invalid_target'))).toBe(true);
    expect(isMissingGrant(error('authkit answered 400: invalid_target (urn:agora:app:shop)'))).toBe(
      true,
    );
    expect(isMissingGrant(error('The app is Not Granted to this client'))).toBe(true);
    expect(isMissingGrant(error('no grant for shop'))).toBe(true);
    // Anything else: warn.
    expect(isMissingGrant(error('authkit answered 401', 'unauthorized_client'))).toBe(false);
    expect(isMissingGrant(error('authkit answered 401: invalid_client'))).toBe(false);
    expect(isMissingGrant(error('fetch failed: ECONNREFUSED'))).toBe(false);
  });

  it('a mint refused with the code invalid_target only (message says nothing) is info', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new RedisBus();
    const service = new FakeCryptoService();
    const hub = await startApp({
      bus,
      agent: etEntry(),
      crypto: embedded(service, 'hub'),
      authkit: {
        ...authkit([]),
        appCallTokens: () => ({
          token: async () => {
            throw Object.assign(new Error('authkit answered 400'), { code: 'invalid_target' });
          },
        }),
      },
    });
    await startApp({
      bus,
      agent: { consoleCommands: { prefix: 'et', actions: true } },
      crypto: tenant(service, 'et', ['crypto:decrypt:console-*']),
      authkit: authkit(['agent:console:*']),
    });
    expect((await setPrice(hub)).status).toBe(200);
    expect(info.mock.calls.flat().join('\n')).toContain(
      'sending without an authkit app-call token (crypto only): authkit answered 400.',
    );
    expect(warn.mock.calls.flat().join('\n')).not.toContain('sending without');
  });
});
