import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type ApprovalPolicy,
  type MemoryProvider,
  staticSkillProvider,
  type ToolRegistry,
} from '../../src/index.js';
import { openCode } from '../../src/opencode/index.js';
import {
  actor,
  approve,
  bootEngine,
  eventually,
  frames,
  framesUntil,
  type Harness,
  textOf,
} from '../helpers/opencode-harness.js';

/** A read and an action, as an app registers them. */
function registerAppTools(registry: ToolRegistry): void {
  registry.register(
    { name: 'lookup', kind: 'read', description: 'look something up', inputSchema: z.object({}) },
    { execute: async () => ({ found: true }) },
  );
  registry.register(
    { name: 'send', kind: 'action', description: 'send it', inputSchema: z.object({}) },
    { execute: async () => ({ sent: true }) },
  );
}

describe('openCode engine: the library seams', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('asks only what the approval policy requires, with its approver and expiry', async () => {
    const policy: ApprovalPolicy = {
      requirementFor: (tool) =>
        tool.name.endsWith('send_email')
          ? { required: true, approver: 'manager', ttlMs: 40 }
          : { required: false, approver: 'requester' },
    };
    h = await bootEngine({
      engine: (host) => openCode({ host }),
      options: { approvalPolicy: policy },
      script: async (t) => {
        t.emit('permission.asked', { id: 'per_read', action: 'company.gmail__search' });
        await t.next('permission.reply');
        t.emit('permission.asked', { id: 'per_send', action: 'company.gmail__send_email' });
        const reply = await t.next('permission.reply');
        t.emit('session.text.delta', { delta: String(reply.args.decision) });
        t.succeed();
      },
    });
    const { runId } = await h.service.chat({ actor, message: 'go' });
    const fs = await frames(h.service, runId);

    // Not required: answered at once, no card.
    expect(h.fake.callsOf('permission.reply')[0]?.args).toMatchObject({
      requestID: 'per_read',
      decision: 'once',
    });
    expect(fs).toContainEqual(
      expect.objectContaining({ kind: 'approval-settled', id: 'per_read', decidedVia: 'policy' }),
    );
    // Required: a card for the manager, which lapses.
    const requested = fs.find((f) => f.kind === 'approval-requested');
    expect(requested).toMatchObject({ id: 'per_send', approver: 'manager' });
    expect(requested && 'expiresAt' in requested && requested.expiresAt).toBeTruthy();
    const expired = h.fake.callsOf('permission.reply')[1]?.args;
    expect(expired).toMatchObject({ requestID: 'per_send', decision: 'reject' });
    expect(String(expired?.message)).toContain('in time');
    expect(fs).toContainEqual(
      expect.objectContaining({ kind: 'approval-settled', id: 'per_send', status: 'expired' }),
    );
    expect((await h.store.toolCallApproval('per_send'))?.status).toBe('expired');
  });

  it('approves without asking what was remembered for the conversation', async () => {
    h = await bootEngine({
      engine: (host) => openCode({ host }),
      script: async (t) => {
        t.emit('permission.asked', { id: `per_${t.text}`, action: 'company.send' });
        await t.next('permission.reply');
        t.succeed();
      },
    });
    const first = await h.service.chat({ actor, message: 'a' });
    await framesUntil(h.service, first.runId, (f) => f.kind === 'approval-requested');
    await approve(h.service, 'per_a', { remember: true });
    await frames(h.service, first.runId);
    const second = await h.service.chat({ actor, message: 'b', threadId: first.threadId });
    const fs = await frames(h.service, second.runId);
    expect(fs).toContainEqual(
      expect.objectContaining({ kind: 'approval-settled', id: 'per_b', decidedVia: 'remembered' }),
    );
    expect(fs.some((f) => f.kind === 'approval-requested')).toBe(false);
  });

  it('rewinds the OpenCode session on a regenerate', async () => {
    h = await bootEngine({ engine: (host) => openCode({ host }) });
    const first = await h.service.chat({ actor, message: 'draft it' });
    await frames(h.service, first.runId);
    const again = await h.service.chat({
      actor,
      message: 'draft it',
      threadId: first.threadId,
      regenerate: true,
    });
    await frames(h.service, again.runId);

    expect(h.fake.callsOf('session.revert.stage')[0]?.args).toMatchObject({
      sessionID: 'ses_1',
      messageID: 'msg_ses_1_1',
    });
    expect(h.fake.callsOf('session.revert.commit')).toHaveLength(1);
    const messages = (await h.store.getThread(first.threadId))?.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it("serves the app's tools over MCP: reads allowed, actions asked, a signed token", async () => {
    h = await bootEngine({
      engine: (host) => openCode({ host, tools: { url: 'https://app.test/agent/opencode/mcp' } }),
      register: registerAppTools,
      appKey: 'app-key-for-tests',
    });
    const { runId } = await h.service.chat({ actor, message: 'hi' });
    await frames(h.service, runId);

    const [added] = h.fake.callsOf('mcp.add');
    expect(added?.args).toMatchObject({
      server: 'agora',
      location: { directory: '/work/u1' },
      config: { type: 'remote', url: 'https://app.test/agent/opencode/mcp', oauth: false },
    });
    const config = added?.args.config as { headers?: Record<string, string> } | undefined;
    const authorization = config?.headers?.Authorization;
    const claims = h.engine.endpoint?.authenticate(authorization);
    expect(claims).toMatchObject({ actor: { id: 'u1' }, server: 'tenant-1' });
    expect(h.engine.endpoint?.authenticate(`${authorization}x`)).toBeNull();

    const rules = h.fake.callsOf('session.create')[0]?.args.permissions as Array<{
      action: string;
    }>;
    expect(rules).toEqual(
      expect.arrayContaining([
        { action: 'agora*', resource: '*', effect: 'allow' },
        { action: 'agora.send', resource: '*', effect: 'ask' },
        { action: 'agora_send', resource: '*', effect: 'ask' },
      ]),
    );
    // Reads ride the server-wide allow; the action's ask comes after it (last match wins).
    expect(rules.findIndex((r) => r.action === 'agora*')).toBeLessThan(
      rules.findIndex((r) => r.action === 'agora.send'),
    );
    // The host's own rules come first: OpenCode's last matching rule wins.
    expect(rules[0]).toEqual({ action: '*', resource: '*', effect: 'deny' });

    // A kept session is not re-registered while its token is fresh.
    const second = await h.service.chat({ actor, message: 'again' });
    await frames(h.service, second.runId);
    expect(h.fake.callsOf('mcp.add')).toHaveLength(2); // a second thread → a second session
  });

  it("denies the tools outside the agent's allow-list", async () => {
    h = await bootEngine({
      engine: (host) => openCode({ host, tools: { url: 'https://app.test/mcp' } }),
      register: registerAppTools,
      defaultAgent: { tools: ['lookup'] },
    });
    const { runId } = await h.service.chat({ actor, message: 'hi' });
    await frames(h.service, runId);
    expect(h.fake.callsOf('session.create')[0]?.args.permissions).toEqual(
      expect.arrayContaining([
        { action: 'agora.send', resource: '*', effect: 'deny' },
        { action: 'agora_send', resource: '*', effect: 'deny' },
      ]),
    );
  });

  it("writes the agent's skills where OpenCode finds them, and allows them", async () => {
    h = await bootEngine({
      engine: (host) => openCode({ host }),
      options: {
        skills: {
          provider: staticSkillProvider([
            {
              name: 'weekly-status',
              description: 'How to write the weekly status',
              scope: 'global',
              body: '1. Start with what shipped.',
            },
          ]),
        },
      },
    });
    const { runId } = await h.service.chat({ actor, message: 'hi' });
    await frames(h.service, runId);

    expect(h.fake.files.get('.opencode/skills/weekly-status/SKILL.md')).toBe(
      '---\nname: weekly-status\ndescription: "How to write the weekly status"\n---\n\n1. Start with what shipped.\n',
    );
    expect(h.fake.callsOf('session.create')[0]?.args.permissions).toContainEqual({
      action: 'skill',
      resource: 'weekly-status',
      effect: 'allow',
    });
  });

  it('puts what is on file about the actor in the session', async () => {
    const provider: MemoryProvider = {
      list: () => [
        {
          id: 'm1',
          key: 'email.tone',
          text: 'Prefers short emails',
          scope: 'actor:u1',
          origin: { author: 'human' },
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      forget: () => false,
    };
    h = await bootEngine({
      engine: (host) => openCode({ host }),
      options: { memory: { provider } },
    });
    const { runId } = await h.service.chat({ actor, message: 'hi' });
    await frames(h.service, runId);

    const memory = h.fake
      .callsOf('session.instructions.entry.put')
      .find((c) => c.args.key === 'agora.memory');
    expect(String(memory?.args.value)).toContain('Prefers short emails');
    // Read-only without `tools` (nothing serves `remember`): the block does not offer it.
    expect(String(memory?.args.value)).not.toContain('`remember`');
  });

  it('finds a permission it never heard about once the session goes idle', async () => {
    const box: { h?: Harness } = {};
    h = await bootEngine({
      engine: (host) => openCode({ host }),
      script: async (t) => {
        box.h?.fake.emitUnheard({
          type: 'permission.asked',
          data: { id: 'per_lost', sessionID: t.sessionId, action: 'company.send' },
        });
        box.h?.fake.goIdle();
        await t.next('permission.reply');
        t.emit('session.text.delta', { delta: 'done' });
        t.succeed();
      },
    });
    box.h = h;
    const { runId } = await h.service.chat({ actor, message: 'go' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    await approve(h.service, 'per_lost');
    const fs = await frames(h.service, runId);
    expect(textOf(fs)).toBe('done');
    await eventually(
      () => h?.fake.callsOf('permission.reply')[0]?.args.decision === 'once',
      'the lost permission was answered',
    );
  }, 15_000);
});
