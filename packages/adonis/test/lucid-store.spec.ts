import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/index.js';
import { LucidAgentStore } from '../src/index.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

let db: Database;
let store: LucidAgentStore;
const actor: Actor = { id: 'user-1', roles: ['ADMIN'], tenantRef: 'tenant-1' };

beforeEach(async () => {
  db = await makeStoreDb();
  store = new LucidAgentStore(asStoreDb(db));
});

afterEach(async () => {
  await db?.manager.closeAll();
});

describe('LucidAgentStore', () => {
  it('creates a thread and reads it back with messages', async () => {
    const thread = await store.createThread({ actor, persona: 'default', title: 'First' });
    expect(thread.title).toBe('First');
    expect(thread.persona).toBe('default');

    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'hello' });
    await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'hi there',
      usage: { inputTokens: 3, outputTokens: 2 },
    });

    const detail = await store.getThread(thread.id);
    expect(detail).not.toBeNull();
    expect(detail?.messages.map((m) => m.content)).toEqual(['hello', 'hi there']);
    expect(detail?.messages[1]?.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(detail?.lastMessagePreview).toBe('hi there');
  });

  it('round-trips user-message attachments (image/PDF) through the JSON column', async () => {
    const thread = await store.createThread({ actor, persona: 'default' });
    const attachments = [
      {
        mediaId: 'm1',
        url: 'https://example.test/pic.png',
        contentType: 'image/png',
        name: 'pic.png',
      },
      {
        mediaId: 'm2',
        url: 'https://example.test/r.pdf',
        contentType: 'application/pdf',
        name: 'r.pdf',
      },
    ];
    const stored = await store.appendMessage({
      threadId: thread.id,
      role: 'user',
      content: 'look',
      attachments,
    });
    expect(stored.attachments).toEqual(attachments);

    const detail = await store.getThread(thread.id);
    expect(detail?.messages[0]?.attachments).toEqual(attachments);
    // A message with no attachments has no `attachments` field (back-compatible).
    await store.appendMessage({ threadId: thread.id, role: 'assistant', content: 'ok' });
    const reloaded = await store.getThread(thread.id);
    expect(reloaded?.messages[1] && 'attachments' in reloaded.messages[1]).toBe(false);
  });

  it('lists an actor threads newest-first and hides soft-deleted / transient ones', async () => {
    const a = await store.createThread({ actor, persona: 'default', title: 'A' });
    await store.createThread({ actor, persona: 'default', title: 'transient', transient: true });
    const b = await store.createThread({ actor, persona: 'default', title: 'B' });
    await store.appendMessage({ threadId: b.id, role: 'user', content: 'bump b' });

    let list = await store.listThreads(actor.id);
    expect(list.map((t) => t.title)).toEqual(['B', 'A']);

    await store.softDeleteThread(a.id);
    list = await store.listThreads(actor.id);
    expect(list.map((t) => t.title)).toEqual(['B']);
    expect(await store.getThread(a.id)).toBeNull();
  });

  it('records a tool call under the model-supplied id and flips its status', async () => {
    const thread = await store.createThread({ actor, persona: 'default' });
    const msg = await store.appendMessage({ threadId: thread.id, role: 'assistant', content: '' });
    await store.recordToolCall({
      toolCallId: 'call-abc',
      messageId: msg.id,
      toolName: 'danger',
      toolType: 'action',
      input: { x: 1 },
      status: 'pending_approval',
    });

    let row = await db.from('agent_tool_call').where('id', 'call-abc').first();
    expect(row?.status).toBe('pending_approval');
    // PK is exactly the model-supplied toolCallId.
    expect(row?.id).toBe('call-abc');

    await store.updateToolCall({
      toolCallId: 'call-abc',
      status: 'executed',
      output: { ok: true },
      executedByRef: actor.id,
    });
    row = await db.from('agent_tool_call').where('id', 'call-abc').first();
    expect(row?.status).toBe('executed');
    expect(row?.executed_by_ref).toBe('user-1');
    expect(JSON.parse(String(row?.output))).toEqual({ ok: true });
  });

  it('sums input+output tokens for the day in quotaToday (cache tokens never re-added)', async () => {
    const thread = await store.createThread({ actor, persona: 'default' });
    await store.recordUsage({
      threadId: thread.id,
      actorRef: actor.id,
      modelId: 'm',
      purpose: 'chat',
      usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 90 },
    });
    await store.recordUsage({
      threadId: thread.id,
      actorRef: actor.id,
      modelId: 'm',
      purpose: 'chat',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const day = new Date().toISOString().slice(0, 10);
    expect(await store.quotaToday(actor.id, day)).toEqual({ usedTokens: 155 });
    // A different day is empty.
    expect(await store.quotaToday(actor.id, '2000-01-01')).toEqual({ usedTokens: 0 });
  });

  it('forks a thread up to a message (in a transaction)', async () => {
    const thread = await store.createThread({ actor, persona: 'default', title: 'Src' });
    const m1 = await store.appendMessage({ threadId: thread.id, role: 'user', content: 'one' });
    await store.appendMessage({ threadId: thread.id, role: 'assistant', content: 'two' });
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'three' });

    const fork = await store.forkThread(thread.id, m1.id);
    const forked = await store.getThread(fork.id);
    expect(forked?.messages.map((m) => m.content)).toEqual(['one']);
    // The source is untouched.
    const source = await store.getThread(thread.id);
    expect(source?.messages).toHaveLength(3);
  });

  it('truncates messages from a point, deleting their tool calls too', async () => {
    const thread = await store.createThread({ actor, persona: 'default' });
    const m1 = await store.appendMessage({ threadId: thread.id, role: 'user', content: 'keep' });
    const m2 = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'drop',
    });
    await store.recordToolCall({
      toolCallId: 'tc-1',
      messageId: m2.id,
      toolName: 't',
      toolType: 'read',
      input: {},
      status: 'auto_executed',
    });

    await store.truncateFrom(thread.id, m2.id);
    const detail = await store.getThread(thread.id);
    expect(detail?.messages.map((m) => m.id)).toEqual([m1.id]);
    const tc = await db.from('agent_tool_call').where('id', 'tc-1').first();
    expect(tc).toBeNull();
  });
});
