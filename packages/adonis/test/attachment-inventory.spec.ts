import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentService,
  type AgentStore,
  AttachmentInventoryError,
  attachmentStores,
  LucidAgentStore,
  type StagedAttachment,
} from '../src/index.js';
import {
  MediaAttachmentStaging,
  type MediaDiskLike,
  type MediaRecordLike,
  type MediaStorageLike,
  type MediaStoreLike,
} from '../src/media/index.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { InMemoryAgentStore, InMemoryAttachmentStagingStore } from '../src/testing/index.js';
import { type BootedApp, bootAgentApp } from './helpers/boot-agent-app.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

/**
 * The staged-attachment inventory: every file an actor has uploaded — including the ones never sent,
 * which no thread can show — and, from it, the ones safe to garbage-collect. After `nestjs-agent`'s
 * `nestjs/src/attachment-collection.spec.ts`; the media-backed `list` after its
 * `media-attachment-staging` inventory, and the reference half runs against both stores.
 */

const ACTOR = { id: 'u1' };
const MONDAY = new Date('2026-03-02T00:00:00.000Z');
const FRIDAY = new Date('2026-03-06T00:00:00.000Z');
const IMAGE = { url: 'https://media.test/x', contentType: 'image/png', name: 'a.png' };

const runner = {
  start: async () => ({ runId: 'run-1' }),
  signal: async () => undefined,
  cancel: async () => undefined,
};
const deps = { defaultAgentName: () => 'default' } as never;

function buildService(store: AgentStore, staging?: InMemoryAttachmentStagingStore): AgentService {
  return new AgentService(
    runner,
    store,
    deps,
    staging !== undefined ? { attachments: staging } : {},
  );
}

async function stage(
  staging: InMemoryAttachmentStagingStore,
  filename: string,
  actorId = ACTOR.id,
): Promise<string> {
  const { mediaId } = await staging.stage({
    data: Buffer.from('bytes'),
    filename,
    contentType: 'image/png',
    sizeBytes: 5,
    actor: { id: actorId },
  });
  return mediaId;
}

/** Send `mediaId` on a message, the way a turn does once the user actually submits the composer. */
async function send(store: AgentStore, threadId: string, mediaId: string): Promise<string> {
  const message = await store.appendMessage({
    threadId,
    role: 'user',
    content: 'look at this',
    attachments: [{ mediaId, ...IMAGE }],
  });
  return message.id;
}

function names(entries: StagedAttachment[]): string[] {
  return entries.map((entry) => entry.name).sort();
}

describe('InMemoryAttachmentStagingStore.list', () => {
  it('lists the actor’s own uploads, newest first, as metadata with no url', async () => {
    const staging = new InMemoryAttachmentStagingStore({}, { now: () => MONDAY });
    await stage(staging, 'older.png');
    staging.setClock(() => FRIDAY);
    await stage(staging, 'newer.png');
    await stage(staging, 'theirs.png', 'u2');

    const listed = await staging.list({ actor: ACTOR });

    expect(listed.map((entry) => entry.name)).toEqual(['newer.png', 'older.png']);
    expect(listed[0]).toEqual({
      mediaId: expect.any(String),
      name: 'newer.png',
      contentType: 'image/png',
      sizeBytes: 5,
      createdAt: FRIDAY.toISOString(),
    });
    expect(listed[0]).not.toHaveProperty('url');
  });

  it('honours stagedBefore and limit', async () => {
    const staging = new InMemoryAttachmentStagingStore({}, { now: () => MONDAY });
    await stage(staging, 'a.png');
    await stage(staging, 'b.png');
    staging.setClock(() => FRIDAY);
    await stage(staging, 'c.png');

    expect(
      names(await staging.list({ actor: ACTOR, stagedBefore: '2026-03-04T00:00:00.000Z' })),
    ).toEqual(['a.png', 'b.png']);
    expect(await staging.list({ actor: ACTOR, limit: 1 })).toHaveLength(1);
  });
});

describe('AgentService — listing an actor’s staged attachments', () => {
  it('returns the actor’s own inventory', async () => {
    const staging = new InMemoryAttachmentStagingStore();
    await stage(staging, 'mine.png');
    await stage(staging, 'theirs.png', 'u2');

    const listed = await buildService(new InMemoryAgentStore(), staging).listAttachments(ACTOR);

    expect(names(listed)).toEqual(['mine.png']);
  });

  it('refuses rather than reporting an empty inventory when the store cannot list', async () => {
    const staging = new InMemoryAttachmentStagingStore();
    await stage(staging, 'mine.png');
    Reflect.set(staging, 'list', undefined);

    const refusal = buildService(new InMemoryAgentStore(), staging).listAttachments(ACTOR);
    await expect(refusal).rejects.toBeInstanceOf(AttachmentInventoryError);
    await expect(refusal).rejects.toMatchObject({ status: 501 });
  });

  it('refuses when no staging store is bound at all', async () => {
    await expect(
      buildService(new InMemoryAgentStore()).listAttachments(ACTOR),
    ).rejects.toBeInstanceOf(AttachmentInventoryError);
  });
});

describe('AgentService — what is safe to collect', () => {
  it('offers up media that was staged and never sent', async () => {
    const staging = new InMemoryAttachmentStagingStore({}, { now: () => MONDAY });
    await stage(staging, 'abandoned.png');

    const collectable = await buildService(
      new InMemoryAgentStore(),
      staging,
    ).collectableAttachments(ACTOR, { olderThan: FRIDAY });

    expect(names(collectable)).toEqual(['abandoned.png']);
  });

  it('keeps media a live message still carries', async () => {
    const staging = new InMemoryAttachmentStagingStore({}, { now: () => MONDAY });
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
    const sent = await stage(staging, 'sent.png');
    await stage(staging, 'abandoned.png');
    await send(store, thread.id, sent);

    const collectable = await buildService(store, staging).collectableAttachments(ACTOR, {
      olderThan: FRIDAY,
    });

    expect(names(collectable)).toEqual(['abandoned.png']);
  });

  it('keeps media a message waiting in the thread’s queue carries — queued is not abandoned', async () => {
    const staging = new InMemoryAttachmentStagingStore({}, { now: () => MONDAY });
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
    const queued = await stage(staging, 'queued.png');
    await store.enqueueMessage({
      threadId: thread.id,
      actor: ACTOR,
      content: 'and this one',
      attachments: [{ mediaId: queued, ...IMAGE }],
    });

    const collectable = await buildService(store, staging).collectableAttachments(ACTOR, {
      olderThan: FRIDAY,
    });

    expect(collectable).toEqual([]);
  });

  it('offers up media again once the message carrying it is truncated away', async () => {
    const staging = new InMemoryAttachmentStagingStore({}, { now: () => MONDAY });
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
    const sent = await stage(staging, 'sent.png');
    const messageId = await send(store, thread.id, sent);
    const service = buildService(store, staging);
    expect(await service.collectableAttachments(ACTOR, { olderThan: FRIDAY })).toEqual([]);

    // exactly what regenerating a turn does
    await store.truncateFrom(thread.id, messageId);

    expect(names(await service.collectableAttachments(ACTOR, { olderThan: FRIDAY }))).toEqual([
      'sent.png',
    ]);
  });

  it('leaves an upload that has not been sent YET alone — in flight is not garbage', async () => {
    const staging = new InMemoryAttachmentStagingStore({}, { now: () => MONDAY });
    await stage(staging, 'old.png');
    staging.setClock(() => FRIDAY);
    await stage(staging, 'just-uploaded.png');

    const collectable = await buildService(
      new InMemoryAgentStore(),
      staging,
    ).collectableAttachments(ACTOR, { olderThan: new Date('2026-03-04T00:00:00.000Z') });

    expect(names(collectable)).toEqual(['old.png']);
  });

  it('applies the age cut itself, so a staging store that ignores stagedBefore cannot delete an in-flight upload', async () => {
    const staging = new InMemoryAttachmentStagingStore({}, { now: () => FRIDAY });
    await stage(staging, 'just-uploaded.png');
    const listAll = staging.list.bind(staging);
    Reflect.set(staging, 'list', (input: { actor: { id: string } }) =>
      listAll({ actor: input.actor }),
    );

    const collectable = await buildService(
      new InMemoryAgentStore(),
      staging,
    ).collectableAttachments(ACTOR, { olderThan: new Date('2026-03-04T00:00:00.000Z') });

    expect(collectable).toEqual([]);
  });

  it('pushes the age cut down to the staging store, so a sweep does not read the whole inventory', async () => {
    const staging = new InMemoryAttachmentStagingStore({}, { now: () => MONDAY });
    await stage(staging, 'old.png');
    const list = vi.spyOn(staging, 'list');

    await buildService(new InMemoryAgentStore(), staging).collectableAttachments(ACTOR, {
      olderThan: FRIDAY,
    });

    expect(list.mock.calls[0]?.[0]?.stagedBefore).toBe(FRIDAY.toISOString());
  });

  it('refuses rather than declaring everything collectable when the store cannot answer references', async () => {
    const staging = new InMemoryAttachmentStagingStore({}, { now: () => MONDAY });
    const backing = new InMemoryAgentStore();
    const thread = await backing.createThread({ actor: ACTOR, persona: 'default' });
    const sent = await stage(staging, 'sent.png');
    await send(backing, thread.id, sent);
    // a store predating the reference query: everything else delegates, this one is simply absent
    const store: AgentStore = Object.create(backing);
    Reflect.set(store, 'referencedMediaIds', undefined);

    await expect(
      buildService(store, staging).collectableAttachments(ACTOR, { olderThan: FRIDAY }),
    ).rejects.toBeInstanceOf(AttachmentInventoryError);
  });

  it('refuses when the staging store cannot list its inventory', async () => {
    const staging = new InMemoryAttachmentStagingStore({}, { now: () => MONDAY });
    await stage(staging, 'abandoned.png');
    Reflect.set(staging, 'list', undefined);

    await expect(
      buildService(new InMemoryAgentStore(), staging).collectableAttachments(ACTOR, {
        olderThan: FRIDAY,
      }),
    ).rejects.toBeInstanceOf(AttachmentInventoryError);
  });
});

describe('the reference half on the Lucid store', () => {
  let db: Database | undefined;
  afterEach(async () => {
    await db?.manager.closeAll();
    db = undefined;
  });

  it('keeps sent and queued media and offers up the rest', async () => {
    db = await makeStoreDb();
    const store = new LucidAgentStore(asStoreDb(db));
    const staging = new InMemoryAttachmentStagingStore({}, { now: () => MONDAY });
    const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
    const sent = await stage(staging, 'sent.png');
    const queued = await stage(staging, 'queued.png');
    await stage(staging, 'abandoned.png');
    await send(store, thread.id, sent);
    await store.enqueueMessage({
      threadId: thread.id,
      actor: ACTOR,
      content: 'next',
      attachments: [{ mediaId: queued, ...IMAGE }],
    });

    const collectable = await buildService(store, staging).collectableAttachments(ACTOR, {
      olderThan: FRIDAY,
    });

    expect(names(collectable)).toEqual(['abandoned.png']);
  });
});

function fakeMedia() {
  const rows = new Map<string, MediaRecordLike>();
  const disk: MediaDiskLike = {
    async put() {},
    async getBytes() {
      return new Uint8Array();
    },
    async getUrl(key) {
      return `https://cdn.test/${key}`;
    },
    async getSignedUrl(key) {
      return `https://s3.test/${key}`;
    },
    async delete() {},
  };
  const storage: MediaStorageLike = { defaultDisk: 'local', disk: () => disk };
  const store: MediaStoreLike = {
    async save(record) {
      rows.set(record.id, record);
      return record;
    },
    async find(id) {
      return rows.get(id) ?? null;
    },
    async delete(id) {
      rows.delete(id);
    },
    async nextOrder() {
      return rows.size;
    },
    async listByOwner(ownerType, ownerId, collection) {
      return [...rows.values()].filter(
        (row) =>
          row.ownerType === ownerType &&
          row.ownerId === ownerId &&
          (collection === undefined || row.collection === collection),
      );
    },
  };
  return { rows, storage, store };
}

describe('MediaAttachmentStaging.list', () => {
  const upload = { data: Buffer.from('hi'), contentType: 'text/plain', sizeBytes: 2 };

  it('lists the actor’s own attachment media, newest first, from its own collection only', async () => {
    const media = fakeMedia();
    let now = MONDAY;
    let n = 0;
    const staging = new MediaAttachmentStaging(media, {
      idGenerator: () => `m${++n}`,
      clock: () => now,
    });
    await staging.stage({ ...upload, filename: 'older.txt', actor: ACTOR });
    now = FRIDAY;
    await staging.stage({ ...upload, filename: 'newer.txt', actor: ACTOR });
    await staging.stage({ ...upload, filename: 'theirs.txt', actor: { id: 'u2' } });
    // A media row of the app's own, owned by the same id but in another collection.
    media.rows.set('avatar', {
      ...(media.rows.get('m1') as MediaRecordLike),
      id: 'avatar',
      collection: 'avatars',
    });

    expect(await staging.list({ actor: ACTOR })).toEqual([
      {
        mediaId: 'm2',
        name: 'newer.txt',
        contentType: 'text/plain',
        sizeBytes: 2,
        createdAt: FRIDAY.toISOString(),
      },
      {
        mediaId: 'm1',
        name: 'older.txt',
        contentType: 'text/plain',
        sizeBytes: 2,
        createdAt: MONDAY.toISOString(),
      },
    ]);
    expect(
      (await staging.list({ actor: ACTOR, stagedBefore: '2026-03-04T00:00:00.000Z' })).map(
        (entry) => entry.mediaId,
      ),
    ).toEqual(['m1']);
    expect(await staging.list({ actor: ACTOR, limit: 1 })).toHaveLength(1);
  });

  it('refuses (501) on a media store that cannot enumerate an owner', async () => {
    const media = fakeMedia();
    Reflect.deleteProperty(media.store, 'listByOwner');
    const staging = new MediaAttachmentStaging(media);
    await expect(staging.list({ actor: ACTOR })).rejects.toMatchObject({ status: 501 });
  });
});

describe('GET <path>/attachments', () => {
  let booted: BootedApp | null = null;
  afterEach(async () => {
    await booted?.close();
    booted = null;
  });

  async function uploadAs(url: string, id: string, name: string): Promise<void> {
    const form = new FormData();
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), name);
    const response = await fetch(`${url}/agent/attachments`, {
      method: 'POST',
      headers: { 'x-actor-id': id },
      body: form,
    });
    expect(response.status).toBe(200);
  }

  it('answers the caller’s own staged files, metadata only', async () => {
    booted = await bootAgentApp({
      model: new FakeModelProvider(() => ({ text: 'Ok.' })),
      attachments: attachmentStores.memory(),
    });
    const { url } = booted;
    await uploadAs(url, 'u1', 'mine.txt');
    await uploadAs(url, 'u2', 'theirs.txt');

    const response = await fetch(`${url}/agent/attachments`, { headers: { 'x-actor-id': 'u1' } });
    expect(response.status).toBe(200);
    const listed = (await response.json()) as StagedAttachment[];
    expect(listed.map((entry) => entry.name)).toEqual(['mine.txt']);
    expect(listed[0]).not.toHaveProperty('url');
  });

  it('answers 501 when the configured store keeps no inventory', async () => {
    booted = await bootAgentApp({
      model: new FakeModelProvider(() => ({ text: 'Ok.' })),
      attachments: {
        async stage() {
          throw new Error('unused');
        },
        async resolve() {
          return null;
        },
      },
    });
    const response = await fetch(`${booted.url}/agent/attachments`, {
      headers: { 'x-actor-id': 'u1' },
    });
    expect(response.status).toBe(501);
  });
});
