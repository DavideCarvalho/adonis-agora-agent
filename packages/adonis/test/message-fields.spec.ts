import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, AgentStore, AppendMessageInput, StoredMessage } from '../src/index.js';
import { LucidAgentStore } from '../src/index.js';
import { InMemoryAgentStore } from '../src/testing/index.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

const ACTOR: Actor = { id: 'u1', roles: ['ADMIN'] };

/**
 * Every optional field `appendMessage` accepts, filled in. Typed `Required<...>` on purpose: a new
 * optional field on `AppendMessageInput` fails to compile here until it is listed, so the
 * round-trip assertion below can never fall behind the input shape it is meant to cover.
 */
const OPTIONAL_FIELDS: Required<Omit<AppendMessageInput, 'threadId' | 'role' | 'content'>> = {
  persona: 'analyst',
  toolCalls: [{ id: 'call-1', name: 'search', input: { q: 'ship' } }],
  toolResults: [{ id: 'call-1', name: 'search', output: { hits: 2 } }],
  attachments: [
    {
      mediaId: 'm1',
      url: 'https://example.test/pic.png',
      contentType: 'image/png',
      name: 'pic.png',
    },
  ],
  followUps: ['and then?'],
  usage: { inputTokens: 3, outputTokens: 5, costUsd: 0.01 },
  runId: 'run-1',
};

async function appendAndRead(
  store: AgentStore,
): Promise<{ appended: StoredMessage; readBack: StoredMessage | undefined }> {
  const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
  const appended = await store.appendMessage({
    threadId: thread.id,
    role: 'user',
    content: 'what does this say?',
    ...OPTIONAL_FIELDS,
  });
  const readBack = (await store.getThread(thread.id))?.messages[0];
  return { appended, readBack };
}

/**
 * A field an adapter accepts but never surfaces is invisible until someone reopens a thread and
 * finds their attachment gone — nothing fails, nothing is logged. So both shipped stores are held
 * to the same contract: what `appendMessage` took, `getThread` returns.
 */
describe('a message round-trips every field it was appended with', () => {
  let db: Database;

  beforeEach(async () => {
    db = await makeStoreDb();
  });

  afterEach(async () => {
    await db?.manager.closeAll();
  });

  it('InMemoryAgentStore', async () => {
    const { appended, readBack } = await appendAndRead(new InMemoryAgentStore());
    expect(readBack).toMatchObject(OPTIONAL_FIELDS);
    expect(appended).toMatchObject(OPTIONAL_FIELDS);
  });

  it('LucidAgentStore', async () => {
    const { appended, readBack } = await appendAndRead(new LucidAgentStore(asStoreDb(db)));
    expect(readBack).toMatchObject(OPTIONAL_FIELDS);
    expect(appended).toMatchObject(OPTIONAL_FIELDS);
  });
});
