import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AgentService } from '../src/agent-service.js';
import { agentConsoleCommandHandler } from '../src/federation/console.js';
import {
  type AgentConsoleCommand,
  type ConsoleCipher,
  RedisConsoleChannel,
  UNAUTHORIZED_CONSOLE,
  UNSIGNED_CHANNEL,
} from '../src/federation/redis_channel.js';
import type { TenantVerifier } from '../src/federation/tenant_auth.js';
import { RedisBus } from './support/redis_bus.js';

/**
 * A stand-in for an @adonis-agora/crypto server (in the Hub or its own app): keys live here, and
 * each caller gets a cipher limited to what its token may do on them.
 */
class FakeCryptoServer {
  readonly keys = new Map<string, Buffer>([['console-agent', randomBytes(32)]]);
  readonly audit: Array<{ op: string; key: string; context?: string | undefined }> = [];

  cipherFor(allowed: { encrypt?: string[]; decrypt?: string[] }): ConsoleCipher {
    return {
      encrypt: async ({ key, plaintext, aad, context }) => {
        if (!allowed.encrypt?.includes(key)) throw new Error(`no crypto:encrypt:${key}`);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.keys.get(key)!, iv);
        cipher.setAAD(Buffer.from(aad ?? ''));
        const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        this.audit.push({ op: 'encrypt', key, context });
        return {
          ciphertext: `agora:ct1:${key}:1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`,
        };
      },
      decrypt: async ({ key, ciphertext, aad, context }) => {
        if (!allowed.decrypt?.includes(key)) throw new Error(`no crypto:decrypt:${key}`);
        const raw = Buffer.from(ciphertext.split(':').pop()!, 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', this.keys.get(key)!, raw.subarray(0, 12));
        decipher.setAAD(Buffer.from(aad ?? ''));
        decipher.setAuthTag(raw.subarray(12, 28));
        const plaintext = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
        this.audit.push({ op: 'decrypt', key, context });
        return { plaintext: plaintext.toString('utf8') };
      },
    };
  }
}

const verifyTenant: TenantVerifier = ({ token }) =>
  token === 'hub-approver'
    ? { partition: 'et', capabilities: ['agent:approvals:decide'], clientId: 'hub' }
    : null;

async function setup(options: { verify?: boolean } = {}) {
  const bus = new RedisBus();
  const server = new FakeCryptoServer();
  const approve = vi.fn(async () => {});
  const service = {
    signalsReachOtherProcesses: true,
    toolCallRun: async (id: string) => (id === 'call-1' ? 'run-1' : null),
    toolCallApproval: async () => ({
      status: 'pending_approval',
      approver: 'requester',
      expiresAt: null,
    }),
    runOwner: async () => 'student-9',
    mayDecide: async () => false,
    approve,
    reject: async () => {},
  } as unknown as AgentService;
  const seen: AgentConsoleCommand[] = [];
  const errors: unknown[] = [];
  const handler = agentConsoleCommandHandler({ service, actions: true, app: 'et' });
  // The app: may only decrypt with the key (its crypto token: crypto:decrypt:console-agent).
  await new RedisConsoleChannel({
    client: bus.connection(),
    prefix: 'et',
    app: 'et',
    crypto: { cipher: server.cipherFor({ decrypt: ['console-agent'] }) },
    ...(options.verify ? { verifyTenant } : {}),
  }).answer(
    async (command) => {
      seen.push(command);
      return handler(command);
    },
    { onError: (error) => errors.push(error) },
  );
  // The console: may only encrypt with it (in the Hub: serviceCipher(crypto.service, 'et')).
  let resolved = 0;
  const console = (token?: string) =>
    new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'et',
      crypto: {
        // Lazy, like `() => crypto.client!` in config/agent.ts.
        cipher: () => {
          resolved += 1;
          return server.cipherFor({ encrypt: ['console-agent'] });
        },
      },
      ...(token !== undefined ? { token } : {}),
    });
  return { bus, server, approve, seen, errors, console, resolvedCount: () => resolved };
}

const decide = (capabilities = ['agent:approvals:decide']): AgentConsoleCommand => ({
  id: crypto.randomUUID(),
  verb: 'decide',
  args: [{ toolCallId: 'call-1', decision: { kind: 'approve' } }],
  actor: 'ana@hub',
  capabilities,
});

describe('federated agent console, sealed with @adonis-agora/crypto', () => {
  it('runs a command the console encrypted and the app decrypted, with nothing readable on Redis', async () => {
    const { bus, server, approve, seen, console, resolvedCount } = await setup();
    expect(resolvedCount()).toBe(0);
    const reply = await console().send(decide());
    expect(reply).toMatchObject({ ok: true });
    expect(resolvedCount()).toBe(1);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(seen[0]).toMatchObject({ verb: 'decide', actor: 'ana@hub' });
    expect(seen[0]?.verified).toBeUndefined();
    expect(bus.wire).not.toContain('call-1');
    expect(bus.wire).not.toContain('ana@hub');
    // Crypto audits both sides, with the command's channel and id as context.
    expect(server.audit.map((row) => row.op)).toEqual(['encrypt', 'decrypt']);
    expect(server.audit[0]?.context).toContain('agora:console-command');
  });

  it('refuses commands from someone who cannot encrypt with the key', async () => {
    const { bus, server, seen, errors, approve } = await setup();
    const raw = bus.connection();
    // Another key of theirs, a made-up ciphertext under the right name, and a plain command.
    server.keys.set('mine', randomBytes(32));
    const theirs = server.cipherFor({ encrypt: ['mine'] });
    const { ciphertext } = await theirs.encrypt({ key: 'mine', plaintext: '{}', aad: 'x' });
    await raw.publish(
      'et-agent-console',
      JSON.stringify({ id: crypto.randomUUID(), sealed: ciphertext }),
    );
    await raw.publish(
      'et-agent-console',
      JSON.stringify({
        id: crypto.randomUUID(),
        sealed: `agora:ct1:console-agent:1:${randomBytes(64).toString('base64url')}`,
      }),
    );
    await raw.publish('et-agent-console', JSON.stringify(decide(['*'])));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toHaveLength(0);
    expect(approve).not.toHaveBeenCalled();
    expect(errors).toHaveLength(3);
    for (const error of errors) expect(error).toMatchObject({ code: UNSIGNED_CHANNEL });
  });

  it('with verifyTenant on the app, the command must also carry a valid token', async () => {
    const { seen, console } = await setup({ verify: true });
    const without = await console().send(decide());
    expect(without).toMatchObject({ ok: false, error: { code: UNAUTHORIZED_CONSOLE } });
    const withToken = await console('hub-approver').send(decide());
    expect(withToken).toMatchObject({ ok: true });
    expect(seen.at(-1)?.verified).toMatchObject({ partition: 'et', clientId: 'hub' });
  });

  it('ignores a forged answer', async () => {
    const { bus, console } = await setup();
    const raw = bus.connection();
    await raw.subscribe('et-agent-console', (message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish('et-agent-console-reply', JSON.stringify({ id, ok: true, data: 'forged' }));
    });
    const reply = await console().send(decide());
    expect(reply.ok && reply.data).not.toBe('forged');
  });

  it('says so when crypto is not ready yet', async () => {
    const bus = new RedisBus();
    const channel = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'et',
      crypto: { cipher: () => undefined as never },
    });
    await expect(channel.send(decide(), { timeoutMs: 100 })).rejects.toThrow(
      /crypto\.cipher.*not ready/,
    );
  });
});
