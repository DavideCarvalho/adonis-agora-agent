// @vitest-environment node
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import type { BaseCommand } from '@adonisjs/core/ace';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import { defineConfig as defineHttpConfig } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentCryptoReseal } from '../../commands/agent_crypto.js';
import loader from '../../commands/main.js';
import { gcmEncryption } from '../../src/crypto-kit/index.js';
import { generateEs256Key } from '../../src/poppy-client/keys.js';
import {
  connectionStateAad,
  InMemoryPoppyConnectionStore,
  type PoppyConnectionRecord,
  pendingFlowAad,
  Sealer,
  walkSealed,
} from '../../src/poppy-connections/index.js';
import { sealedReportVerdict } from '../../src/poppy-connections/reseal.js';

const APP_KEY = 'app-key-of-the-test-app-32-chars';
const NEW_KEY = 'the-new-sealing-key-of-32-chars!';

/** What agent wrote before the crypto kit (the old `Sealer.seal`), byte for byte. */
function oldSeal(secret: string, value: unknown): string {
  const key = createHash('sha256').update(`poppy-connections:v1:${secret}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), body]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

const record = (owner: string, state: string): PoppyConnectionRecord => ({
  owner,
  issuer: 'https://shop.example/poppy',
  domain: 'shop.example',
  organization: 'Shop',
  scope: '',
  status: 'active',
  state,
  createdAt: 1,
  updatedAt: 1,
});

async function pendingWithFlow(store: InMemoryPoppyConnectionStore, id: string, flow: string) {
  await store.createPending({
    id,
    owner: 'acct-1',
    domain: 'shop.example',
    issuer: 'https://shop.example/poppy',
    organization: 'Shop',
    scope: '',
    actor: null,
    threadId: null,
    runId: null,
    toolCallId: null,
    flow,
    status: 'open',
    expiresAt: Date.now() + 60_000,
    createdAt: 1,
  });
}

describe('poppy-connections sealing (crypto kit)', () => {
  it('opens values sealed by the old Sealer, with no migration', async () => {
    const sealer = new Sealer(APP_KEY);
    const legacy = oldSeal(APP_KEY, { refreshToken: 'rt_1' });
    expect(await sealer.status(legacy, 'any')).toBe('legacy');
    expect(await sealer.open(legacy, connectionStateAad('acct-1', 'https://x'))).toEqual({
      refreshToken: 'rt_1',
    });
  });

  it('opens old values after a rotation, when the old app key is still in `keys`', async () => {
    const sealer = new Sealer(NEW_KEY, { keys: [NEW_KEY, APP_KEY] });
    expect(await sealer.open(oldSeal(APP_KEY, 'v'), 'any')).toBe('v');
    await expect(new Sealer(NEW_KEY).open(oldSeal(APP_KEY, 'v'), 'any')).rejects.toThrow(/legacy/);
  });

  it('seals new values in the agora:v1 format (Adonis encryption) and round-trips them', async () => {
    const sealer = new Sealer(APP_KEY);
    const sealed = await sealer.seal({ a: 1 }, 'row');
    expect(sealed.startsWith('agora:v1:')).toBe(true);
    expect(await sealer.status(sealed, 'row')).toBe('active');
    expect(await sealer.open(sealed, 'row')).toEqual({ a: 1 });
  });

  it("seals with an Adonis encryption instance (the app's service) when given one", async () => {
    const encryption = gcmEncryption([NEW_KEY], 'app');
    const sealer = new Sealer(APP_KEY, { encryption });
    const sealed = await sealer.seal('v', 'row');
    expect(sealed.startsWith('agora:v1:app.v1:')).toBe(true);
    expect(await new Sealer(NEW_KEY, { encryption }).open(sealed, 'row')).toBe('v');
    // The old format still opens: the legacy reader uses the app key.
    expect(await sealer.open(oldSeal(APP_KEY, 'old'), 'row')).toBe('old');
  });

  it('refuses a tampered value, a value moved to another row and a legacy value under another key', async () => {
    const sealer = new Sealer(APP_KEY);
    const sealed = await sealer.seal('v', connectionStateAad('a', 'i'));
    // Adonis' ciphertext: `<id>.v1:<ct>.<iv>.<tag>` after the kit prefix. Flip a bit of the tag.
    const parts = sealed.split('.');
    const tag = Buffer.from(parts[3]!, 'base64url');
    tag[3] = tag[3]! ^ 0x80;
    parts[3] = tag.toString('base64url');
    await expect(sealer.open(parts.join('.'), connectionStateAad('a', 'i'))).rejects.toThrow(
      /did not open/,
    );
    await expect(sealer.open(sealed, connectionStateAad('b', 'i'))).rejects.toThrow(/did not open/);
    const legacy = oldSeal(APP_KEY, 'v').split('.');
    const body = Buffer.from(legacy[3]!, 'base64url');
    body[0] = body[0]! ^ 0x01;
    legacy[3] = body.toString('base64url');
    await expect(sealer.open(legacy.join('.'), 'x')).rejects.toThrow(/legacy/);
  });

  it('reports legacy and retired values, and reseal moves them to the active key', async () => {
    const store = new InMemoryPoppyConnectionStore();
    const before = new Sealer(APP_KEY);
    await store.saveConnection(record('acct-1', oldSeal(APP_KEY, { t: 1 })));
    await store.saveConnection(
      record(
        'acct-2',
        await before.seal({ t: 2 }, connectionStateAad('acct-2', record('', '').issuer)),
      ),
    );
    await pendingWithFlow(store, 'p1', await before.seal({ kind: 'device' }, pendingFlowAad('p1')));

    const rotated = new Sealer(NEW_KEY, { keys: [NEW_KEY, APP_KEY] });
    const report = await walkSealed(store, rotated, { reseal: false });
    expect(report.columns).toEqual([
      expect.objectContaining({
        column: 'agent_poppy_connection.state',
        scanned: 2,
        legacy: 1,
        retired: 1,
      }),
      expect.objectContaining({ column: 'agent_poppy_connect.flow', scanned: 1, retired: 1 }),
    ]);
    expect(sealedReportVerdict(report)).toMatchObject({
      status: 'warn',
      fix: 'Run `node ace agent:crypto:reseal`',
    });

    const dry = await walkSealed(store, rotated, { reseal: true, dryRun: true });
    expect(dry.columns.map((c) => c.resealed)).toEqual([2, 1]);
    expect(
      (await store.getConnection('acct-1', record('', '').issuer))?.state.startsWith('v1.'),
    ).toBe(true);

    const done = await walkSealed(store, rotated, { reseal: true });
    expect(done.columns.map((c) => [c.resealed, c.failed])).toEqual([
      [2, 0],
      [1, 0],
    ]);
    const after = await walkSealed(store, rotated, { reseal: false });
    expect(after.columns.map((c) => c.active)).toEqual([2, 1]);
    expect(sealedReportVerdict(after).status).toBe('ok');
    const row = await store.getConnection('acct-1', record('', '').issuer);
    expect(await rotated.status(row!.state, connectionStateAad('acct-1', row!.issuer))).toBe(
      'active',
    );
    expect(await rotated.open(row!.state, connectionStateAad('acct-1', row!.issuer))).toEqual({
      t: 1,
    });
    // The old key can go now.
    const only = new Sealer(NEW_KEY, { keys: [NEW_KEY] });
    expect(await only.open(row!.state, connectionStateAad('acct-1', row!.issuer))).toEqual({
      t: 1,
    });
  });

  it('flags values whose key is gone as errors, and reseal counts them as failed', async () => {
    const store = new InMemoryPoppyConnectionStore();
    const gone = new Sealer(NEW_KEY);
    await store.saveConnection(
      record('acct-1', await gone.seal('v', connectionStateAad('acct-1', record('', '').issuer))),
    );
    const sealer = new Sealer(APP_KEY);
    const report = await walkSealed(store, sealer, { reseal: false });
    expect(report.columns[0]).toMatchObject({ unreadable: 1 });
    expect(sealedReportVerdict(report).status).toBe('error');
    const reseal = await walkSealed(store, sealer, { reseal: true });
    expect(reseal.columns[0]).toMatchObject({ failed: 1, resealed: 0 });
  });

  it('skips a value the app changed between the read and the write', async () => {
    const store = new InMemoryPoppyConnectionStore();
    const sealer = new Sealer(APP_KEY);
    await store.saveConnection(record('acct-1', oldSeal(APP_KEY, 'v')));
    const racing = Object.assign(Object.create(store), {
      listSealed: () => store.listSealed(),
      replaceSealed: async () => false,
    }) as InMemoryPoppyConnectionStore;
    const report = await walkSealed(racing, sealer, { reseal: true });
    expect(report.columns[0]).toMatchObject({ resealed: 0, skipped: 1 });
  });

  it('--all re-seals values that are already active (keys the kit cannot tell apart)', async () => {
    const store = new InMemoryPoppyConnectionStore();
    const sealer = new Sealer(APP_KEY);
    const aad = connectionStateAad('acct-1', record('', '').issuer);
    const before = await sealer.seal('v', aad);
    await store.saveConnection(record('acct-1', before));
    expect((await walkSealed(store, sealer, { reseal: true })).columns[0]).toMatchObject({
      resealed: 0,
    });
    expect((await walkSealed(store, sealer, { reseal: true, all: true })).columns[0]).toMatchObject(
      {
        resealed: 1,
      },
    );
    const after = (await store.getConnection('acct-1', record('', '').issuer))!.state;
    expect(after).not.toBe(before);
    expect(await sealer.open(after, aad)).toBe('v');
  });

  it('a custom store without listSealed is reported, not walked', async () => {
    const report = await walkSealed({} as never, new Sealer(APP_KEY), { reseal: false });
    expect(report.walkable).toBe(false);
    expect(sealedReportVerdict(report).status).toBe('skip');
  });
});

describe('agent:crypto:reseal', { timeout: 60_000 }, () => {
  let current: ApplicationService | undefined;
  afterEach(async () => {
    await current?.terminate();
    current = undefined;
  });

  async function boot(store: InMemoryPoppyConnectionStore, crypto?: Record<string, unknown>) {
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: {
          providers: [() => import('../../providers/poppy_connections_provider.js')],
        },
        config: {
          // The app key opens the values older versions sealed; new ones use config/encryption.ts.
          app: { appKey: APP_KEY, appUrl: 'http://localhost:3333', http: defineHttpConfig({}) },
          poppy_connections: {
            baseUrl: 'https://app.example',
            identity: {
              name: 'Test',
              keys: [(await generateEs256Key()).privateJwk as Record<string, unknown>],
            },
            store,
            ...(crypto ? { crypto } : {}),
          },
        },
      })
      .create(new URL('../', import.meta.url));
    const app = ignitor.createApp('console');
    await app.init();
    await app.boot();
    await app.start(() => {});
    current = app as unknown as ApplicationService;
    return current;
  }

  async function run(app: ApplicationService, argv: string[]) {
    const ace = await app.container.make('ace');
    ace.ui.switchMode('raw');
    const cmd = await ace.create(AgentCryptoReseal as unknown as typeof BaseCommand, argv);
    await cmd.exec();
    return { logs: cmd.logger.getLogs().map((l) => l.message), exitCode: cmd.exitCode };
  }

  it('is in the commands barrel', async () => {
    const names = (await loader.getMetaData()).map((c) => c.commandName);
    expect(names).toContain('agent:crypto:reseal');
  });

  it('--dry-run --json reports without writing; a real run migrates legacy values', async () => {
    const store = new InMemoryPoppyConnectionStore();
    const legacy = oldSeal(APP_KEY, { t: 1 });
    await store.saveConnection(record('acct-1', legacy));
    const app = await boot(store);

    const dry = await run(app, ['--dry-run', '--json']);
    expect(dry.exitCode).toBe(0);
    const report = JSON.parse(dry.logs.join('\n'));
    expect(report).toMatchObject({ walkable: true, dryRun: true });
    expect(report.columns[0]).toMatchObject({ scanned: 1, legacy: 1, resealed: 1, failed: 0 });
    expect((await store.getConnection('acct-1', record('', '').issuer))?.state).toBe(legacy);

    const real = await run(app, []);
    expect(real.exitCode).toBe(0);
    const row = await store.getConnection('acct-1', record('', '').issuer);
    expect(row?.state.startsWith('agora:v1:')).toBe(true);
    // Sealed with the app's own encryption service (config/encryption.ts), not the bare app key.
    const encryption = (await app.container.make('encryption')) as never;
    const aad = connectionStateAad('acct-1', row!.issuer);
    expect(await new Sealer(APP_KEY, { encryption }).open(row!.state, aad)).toEqual({ t: 1 });
    await expect(new Sealer(APP_KEY).open(row!.state, aad)).rejects.toThrow(/did not open/);
  });

  it('exits 1 when a value cannot be opened', async () => {
    const store = new InMemoryPoppyConnectionStore();
    await store.saveConnection(record('acct-1', oldSeal(NEW_KEY, 'not with this app key')));
    const app = await boot(store);
    const { exitCode, logs } = await run(app, ['--json']);
    expect(exitCode).toBe(1);
    expect(logs.join('\n')).toContain('could not be opened');
  });
});
