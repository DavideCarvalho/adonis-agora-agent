import { describe, expect, it, vi } from 'vitest';
import type { AgentService } from '../src/agent-service.js';
import {
  agentConsoleCommandHandler,
  buildFederatedAgentApp,
  CAPABILITIES_REQUIRED,
  consoleCommandKeys,
  validateFederatedConsoleApp,
} from '../src/federation/console.js';
import {
  type AgentConsoleCommand,
  RedisConsoleChannel,
  UNAUTHORIZED_CONSOLE,
  UNSIGNED_CHANNEL,
} from '../src/federation/redis_channel.js';
import type { TenantVerifier } from '../src/federation/tenant_auth.js';
import type { AgentGovernanceQueries } from '../src/index.js';
import { InMemoryPricingStore } from '../src/testing/in-memory-pricing.js';
import { RedisBus } from './support/redis_bus.js';

/**
 * The federated console channel is authenticated: Redis is not a trust boundary, so a command from
 * anyone who can publish there (forged, tampered, stale, replayed) never approves a tool call or
 * changes a price, and a forged answer never reaches the console.
 */

const PREFIX = 'et';
const SECRET = 'federation-secret-0123456789';
const APP_KEY = 'entre-textos-app-key-0123456789';

/** The owning app's agent service, as far as settling a tool call goes. */
function owningService() {
  const approve = vi.fn(async () => {});
  const reject = vi.fn(async () => {});
  const service = {
    signalsReachOtherProcesses: true,
    toolCallRun: async (id: string) => (id === 'call-1' ? 'run-1' : null),
    toolCallApproval: async (id: string) =>
      id === 'call-1'
        ? { status: 'pending_approval', approver: 'requester', expiresAt: null }
        : null,
    runOwner: async (runId: string) => (runId === 'run-1' ? 'student-9' : null),
    mayDecide: async () => false,
    approve,
    reject,
  } as unknown as AgentService;
  return { service, approve, reject };
}

const decide = (actor = 'ana', capabilities?: string[]): AgentConsoleCommand => ({
  id: crypto.randomUUID(),
  verb: 'decide',
  args: [{ toolCallId: 'call-1', decision: { kind: 'approve' } }],
  actor,
  ...(capabilities !== undefined ? { capabilities } : {}),
});

const price = (capabilities?: string[]): AgentConsoleCommand => ({
  id: crypto.randomUUID(),
  verb: 'upsertPrice',
  args: [{ modelId: 'gpt-x', inputPricePer1m: 99, outputPricePer1m: 99 }],
  actor: 'ana',
  ...(capabilities !== undefined ? { capabilities } : {}),
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('federated agent console channel, shared secret', () => {
  it('neither sends nor answers without authentication', async () => {
    const bus = new RedisBus();
    const channel = new RedisConsoleChannel({ client: bus.connection(), prefix: PREFIX });
    await expect(channel.answer(async () => null)).rejects.toMatchObject({
      code: UNSIGNED_CHANNEL,
    });
    await expect(channel.send(decide(), { timeoutMs: 100 })).rejects.toMatchObject({
      code: UNSIGNED_CHANNEL,
    });
    expect(bus.published).toHaveLength(0);
  });

  it("logs 'replayed' only on the instance that already ran the command id", async () => {
    const bus = new RedisBus();
    const owner = owningService();
    const handler = agentConsoleCommandHandler({
      service: owner.service,
      actions: true,
      app: PREFIX,
    });
    // Two instances of the owning app on the same channel, each with its own log.
    const logs: unknown[][] = [[], []];
    for (const errors of logs) {
      await new RedisConsoleChannel({
        client: bus.connection(),
        prefix: PREFIX,
        secret: SECRET,
      }).answer(handler, { onError: (error) => errors.push(error) });
    }
    const console_ = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: SECRET,
    });
    expect(await console_.send(decide('ana', ['*']))).toMatchObject({ ok: true });
    const sent = bus.published.find((p) => p.channel === 'et-agent-console')!;
    const raw = bus.connection();
    await raw.publish('et-agent-console', sent.message);
    await settle();
    const reasons = logs.map((errors) => errors.map((e) => (e as { reason?: string }).reason));
    // Exactly one instance ran it, and only that one says `replayed`; the other stays silent.
    expect(reasons.flat()).toEqual(['replayed']);
    expect(owner.approve).toHaveBeenCalledTimes(1);
  });

  it('refuses unsigned, forged, tampered, stale and replayed commands, and runs a signed one', async () => {
    const bus = new RedisBus();
    const owner = owningService();
    const ran: AgentConsoleCommand[] = [];
    const errors: unknown[] = [];
    const handler = agentConsoleCommandHandler({
      service: owner.service,
      actions: true,
      app: PREFIX,
    });
    await new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: SECRET,
    }).answer(
      async (command) => {
        ran.push(command);
        return handler(command);
      },
      { onError: (error) => errors.push(error) },
    );
    const raw = bus.connection();
    // Someone with Redis access approves as an admin, claiming every capability and a token.
    const forged = {
      ...decide('mallory', ['*']),
      verified: { partition: PREFIX, capabilities: ['*'] },
    };
    await raw.publish('et-agent-console', JSON.stringify(forged));
    await raw.publish(
      'et-agent-console',
      JSON.stringify({ ...forged, id: 'forged-2', ts: Date.now(), mac: 'AAAA' }),
    );
    await settle();
    expect(ran).toHaveLength(0);
    expect(owner.approve).not.toHaveBeenCalled();
    expect(errors.length).toBeGreaterThanOrEqual(2);
    for (const error of errors) expect(error).toMatchObject({ code: UNSIGNED_CHANNEL });

    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: SECRET,
    });
    const command = { ...decide('ana', ['agent:approvals:decide']), id: 'real-1' };
    const reply = await console.send(command);
    expect(reply).toMatchObject({ ok: true });
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ actor: 'ana' });
    expect(ran[0]).not.toHaveProperty('mac');
    expect(ran[0]).not.toHaveProperty('verified');
    expect(owner.approve).toHaveBeenCalledTimes(1);

    // The same signed message published again (a replay) does not run twice.
    const signed = bus.published.find((p) => p.message.includes('"real-1"'))!;
    await raw.publish('et-agent-console', signed.message);
    // A tampered copy (another actor) fails the MAC.
    await raw.publish(
      'et-agent-console',
      JSON.stringify({ ...JSON.parse(signed.message), id: 'real-2', actor: 'mallory' }),
    );
    // A copy re-signed with a wrong secret, and a stale one, fail too.
    const wrong = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: 'not-the-shared-secret-000',
    });
    await expect(wrong.send(decide('mallory', ['*']), { timeoutMs: 100 })).rejects.toThrow(
      /no instance of "et" answered within 0.1s — the app may have refused the command/,
    );
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 5 * 60_000);
    const stale = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: SECRET,
    });
    const pendingStale = stale.send(decide('ana', ['*']), { timeoutMs: 100 });
    clock.mockRestore();
    await expect(pendingStale).rejects.toThrow(
      /no instance of "et" answered within 0.1s — the app may have refused the command/,
    );
    await settle();
    expect(ran).toHaveLength(1);
    expect(owner.approve).toHaveBeenCalledTimes(1);
  });

  it('ignores a forged reply and waits for the signed one', async () => {
    const bus = new RedisBus();
    const raw = bus.connection();
    // A rogue subscriber answers every command first.
    await raw.subscribe('et-agent-console', (message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish('et-agent-console-reply', JSON.stringify({ id, ok: true, data: 'forged' }));
    });
    await new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: SECRET,
    }).answer(async () => 'real');
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: SECRET,
    });
    expect(await console.send(decide())).toMatchObject({ ok: true, data: 'real' });
  });
});

describe('agentConsoleCommandHandler', () => {
  it('refuses every action while consoleCommands.actions is off', async () => {
    const owner = owningService();
    const pricing = new InMemoryPricingStore();
    const handler = agentConsoleCommandHandler({ service: owner.service, pricing, app: PREFIX });
    await expect(handler(decide('ana', ['*']))).rejects.toMatchObject({ status: 403 });
    await expect(handler(price(['*']))).rejects.toMatchObject({ status: 403 });
    expect(owner.approve).not.toHaveBeenCalled();
    expect(await pricing.listCurrentPrices()).toEqual([]);
  });

  it('checks capabilities first: with actions off, a command without them is still capabilities-required', async () => {
    const owner = owningService();
    const handler = agentConsoleCommandHandler({
      service: owner.service,
      pricing: new InMemoryPricingStore(),
      app: PREFIX,
    });
    await expect(handler(decide('ana'))).rejects.toMatchObject({
      status: 403,
      code: CAPABILITIES_REQUIRED,
    });
    // With capabilities, actions off is what refuses it.
    await expect(handler(decide('ana', ['agent:*']))).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('consoleCommands.actions is off'),
    });
  });

  it("takes literal aliases and trailing-`*` grants in agent's namespace, nothing else", async () => {
    const owner = owningService();
    const pricing = new InMemoryPricingStore();
    const handler = agentConsoleCommandHandler({
      service: owner.service,
      pricing,
      actions: true,
      app: PREFIX,
    });
    // A `*` anywhere but the last segment (or outside agent's namespace) grants nothing.
    for (const pattern of [
      '*:pricing:write',
      'agent:*:write',
      'agent:console:w*',
      '*:console:*',
      'agent:pri*',
      'other:pricing:*',
      // A known alias, but the agent has no console reads: it grants no write.
      'agent:console:read',
    ]) {
      await expect(handler(price([pattern]))).rejects.toMatchObject({ status: 403 });
    }
    // The literal aliases, and hierarchical trailing-`*` grants in agent's own namespace.
    for (const grant of [
      '*',
      'agent:*',
      'agent:console:*',
      'agent:console:write',
      'agent:pricing:*',
    ]) {
      expect(await handler(price([grant]))).toEqual({ ok: true });
    }
    // A hierarchical grant covers only its own branch.
    await expect(handler(price(['agent:approvals:*']))).rejects.toMatchObject({ status: 403 });
  });

  it('never takes a command without capabilities for "everything"', async () => {
    const owner = owningService();
    const pricing = new InMemoryPricingStore();
    const handler = agentConsoleCommandHandler({
      service: owner.service,
      pricing,
      actions: true,
      app: PREFIX,
    });
    await expect(handler(decide('ana'))).rejects.toMatchObject({ status: 403 });
    await expect(handler(price())).rejects.toMatchObject({ status: 403 });
    // The capability of one verb does not cover the other.
    await expect(handler(price(['agent:approvals:decide']))).rejects.toMatchObject({
      status: 403,
    });
    expect(owner.approve).not.toHaveBeenCalled();
    expect(await handler(price(['agent:pricing:write']))).toEqual({ ok: true });
  });
});

/** A stand-in for authkitTenantVerifier: one token per console client. */
const verifyTenant: TenantVerifier = ({ token }) => {
  if (token === 'hub-admin') {
    return { partition: PREFIX, capabilities: ['agent:*'], clientId: 'hub' };
  }
  if (token === 'hub-approver') {
    return { partition: PREFIX, capabilities: ['agent:approvals:decide'], clientId: 'hub-ap' };
  }
  if (token === 'hub-other-app') {
    return { partition: 'billing', capabilities: ['*'], clientId: 'hub-billing' };
  }
  return null;
};

async function tokenSetup(options: { actions?: boolean } = {}) {
  const bus = new RedisBus();
  const owner = owningService();
  const pricing = new InMemoryPricingStore();
  const keys = consoleCommandKeys(APP_KEY, PREFIX);
  const seen: AgentConsoleCommand[] = [];
  const errors: unknown[] = [];
  const handler = agentConsoleCommandHandler({
    service: owner.service,
    pricing,
    actions: options.actions ?? true,
    app: PREFIX,
  });
  await new RedisConsoleChannel({
    client: bus.connection(),
    prefix: PREFIX,
    app: PREFIX,
    keys,
    verifyTenant,
  }).answer(
    async (command) => {
      seen.push(command);
      return handler(command);
    },
    { onError: (error) => errors.push(error) },
  );
  // What `agent:console-key` prints on the app, configured on the console (never read from Redis).
  const { d: _private, ...publicKey } = keys.publicKey;
  const consoleWith = (token: string, onReset?: () => void) =>
    new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      token: Object.assign(async () => token, { reset: () => onReset?.() }),
      recipient: publicKey,
    });
  return { bus, owner, pricing, seen, errors, consoleWith, publicKey };
}

/** The viewer's grant a console sends when `authorize` does not narrow it. */
const ALL = ['agent:*'];

describe('federated agent console, token mode (authkit)', () => {
  it('runs a decision whose token the app verifies, with neither on the wire', async () => {
    const { bus, owner, seen, consoleWith } = await tokenSetup();
    const reply = await consoleWith('hub-admin').send(decide('ana@hub', ALL));
    expect(reply).toMatchObject({ ok: true });
    expect(owner.approve).toHaveBeenCalledTimes(1);
    expect(seen[0]?.verified).toEqual({
      partition: PREFIX,
      capabilities: ['agent:*'],
      clientId: 'hub',
    });
    expect(bus.wire).not.toContain('hub-admin');
    expect(bus.wire).not.toContain('call-1');
    expect(bus.wire).not.toContain('ana@hub');
  });

  it('logs each refusal with its uniform reason', async () => {
    const { errors, consoleWith } = await tokenSetup();
    await consoleWith('stolen-or-made-up').send(decide('ana', ALL));
    await consoleWith('hub-admin').send(decide());
    const reasons = errors.map((error) => (error as { reason?: string }).reason);
    expect(reasons).toEqual(['token refused', 'capabilities-required']);
    for (const error of errors) {
      expect((error as Error).message).toMatch(/^refused a command \(/);
    }
  });

  it('refuses an unknown token with a 401 (and the console drops its cached token)', async () => {
    const { owner, consoleWith } = await tokenSetup();
    let resets = 0;
    const reply = await consoleWith('stolen-or-made-up', () => {
      resets += 1;
    }).send(decide('ana', ALL));
    expect(reply).toMatchObject({ ok: false, error: { code: UNAUTHORIZED_CONSOLE, status: 401 } });
    expect(resets).toBe(1);
    expect(owner.approve).not.toHaveBeenCalled();
  });

  it('refuses a verified command that carries no capabilities (never "the token decides")', async () => {
    const { owner, pricing, consoleWith } = await tokenSetup();
    for (const command of [decide(), price()]) {
      const reply = await consoleWith('hub-admin').send(command);
      expect(reply).toMatchObject({
        ok: false,
        error: { status: 403, code: CAPABILITIES_REQUIRED },
      });
    }
    expect(owner.approve).not.toHaveBeenCalled();
    expect(await pricing.listCurrentPrices()).toEqual([]);
  });

  it('lets the token decide the app and the capabilities, whatever the message claims', async () => {
    const { owner, pricing, consoleWith } = await tokenSetup();
    // A token for another app cannot act on this one.
    const other = await consoleWith('hub-other-app').send(decide('ana', ALL));
    expect(other).toMatchObject({ ok: false, error: { status: 403 } });
    expect(!other.ok && other.error.message).toMatch(/token is for "billing"/);
    // An approver's token cannot change prices, even if the message claims every capability.
    const approver = await consoleWith('hub-approver').send(price(['*']));
    expect(approver).toMatchObject({ ok: false, error: { status: 403 } });
    expect(!approver.ok && approver.error.message).toMatch(/lacks agent:pricing:write/);
    expect(await pricing.listCurrentPrices()).toEqual([]);
    // The viewer's capabilities only narrow the token's.
    const narrowed = await consoleWith('hub-admin').send(decide('ana', ['agent:pricing:write']));
    expect(narrowed).toMatchObject({ ok: false, error: { status: 403 } });
    expect(owner.approve).not.toHaveBeenCalled();
    // The approver can approve; the admin can change a price.
    expect(await consoleWith('hub-approver').send(decide('ana', ALL))).toMatchObject({ ok: true });
    expect(await consoleWith('hub-admin').send(price(ALL))).toMatchObject({ ok: true });
    expect((await pricing.listCurrentPrices())[0]?.modelId).toBe('gpt-x');
  });

  it('refuses a verified console while actions are off', async () => {
    const { owner, consoleWith } = await tokenSetup({ actions: false });
    const reply = await consoleWith('hub-admin').send(decide('ana', ALL));
    expect(reply).toMatchObject({ ok: false, error: { status: 403 } });
    expect(owner.approve).not.toHaveBeenCalled();
  });

  it('refuses unsealed, tampered and replayed commands', async () => {
    const { bus, owner, seen, errors, consoleWith } = await tokenSetup();
    const raw = bus.connection();
    await raw.publish(
      'et-agent-console',
      JSON.stringify({
        ...decide('mallory', ['*']),
        verified: { partition: PREFIX, capabilities: ['*'] },
      }),
    );
    await settle();
    expect(seen).toHaveLength(0);
    expect(errors[0]).toMatchObject({ code: UNSIGNED_CHANNEL });

    await consoleWith('hub-admin').send(decide('ana', ALL));
    const sent = bus.published.find(
      (p) => p.channel === 'et-agent-console' && p.message.includes('sealed'),
    )!;
    const wire = JSON.parse(sent.message) as { id: string; sealed: string };
    const flipped = wire.sealed.slice(0, -2) + (wire.sealed.endsWith('A') ? 'BB' : 'AA');
    // Moved to another id (the AAD binds it), bit-flipped, and replayed as is.
    await raw.publish(
      'et-agent-console',
      JSON.stringify({ id: crypto.randomUUID(), sealed: wire.sealed }),
    );
    await raw.publish('et-agent-console', JSON.stringify({ ...wire, sealed: flipped }));
    await raw.publish('et-agent-console', sent.message);
    await settle();
    expect(seen).toHaveLength(1);
    expect(owner.approve).toHaveBeenCalledTimes(1);
  });

  it('ignores a forged answer and waits for the app', async () => {
    const { bus, consoleWith } = await tokenSetup();
    const raw = bus.connection();
    await raw.subscribe('et-agent-console', (message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish(
        'et-agent-console-reply',
        JSON.stringify({ id, ok: false, error: { message: 'forged', status: 409 } }),
      );
    });
    expect(await consoleWith('hub-admin').send(decide('ana', ALL))).toMatchObject({ ok: true });
  });

  it('fails the boot on a console token without the app public key, or a malformed key', () => {
    const governance = {} as AgentGovernanceQueries;
    expect(() =>
      validateFederatedConsoleApp(
        'et',
        { governance, controlPlane: { prefix: PREFIX, token: 'hub-admin' } },
        { names: ['main'], default: 'main' },
      ),
    ).toThrow(/needs that app's `publicKey`/);
    expect(() =>
      validateFederatedConsoleApp(
        'et',
        { governance, controlPlane: { prefix: PREFIX, token: 'x', publicKey: '{"kty":"RSA"}' } },
        { names: ['main'], default: 'main' },
      ),
    ).toThrow(/X25519 public JWK/);
  });

  it('builds a federated app that sends with the configured token and public key', async () => {
    const { bus, owner, publicKey } = await tokenSetup();
    const app = await buildFederatedAgentApp(
      'entre-textos',
      {
        governance: {} as AgentGovernanceQueries,
        controlPlane: {
          prefix: PREFIX,
          token: 'hub-approver',
          // As an env var would carry it: the JSON text `agent:console-key` prints.
          publicKey: JSON.stringify(publicKey),
        },
      },
      { container: { make: async () => ({ connection: () => bus.connection() }) } } as never,
      { via: 'Hub' },
    );
    expect(
      await app.send('decide', [{ toolCallId: 'call-1', decision: { kind: 'approve' } }], 'ana'),
    ).toMatchObject({ ok: true });
    expect(owner.approve).toHaveBeenCalledTimes(1);
    await expect(
      app.send('upsertPrice', [{ modelId: 'm', inputPricePer1m: 1, outputPricePer1m: 1 }], 'ana'),
    ).rejects.toMatchObject({ status: 403 });
    await app.close();
  });
});
