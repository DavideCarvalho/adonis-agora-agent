import { afterEach, describe, expect, it } from 'vitest';
import {
  type AttachmentStagingStore,
  attachmentStores,
  type MessageAttachment,
  type ThreadDetail,
} from '../src/index.js';
import {
  MediaAttachmentStaging,
  type MediaDiskLike,
  type MediaRecordLike,
  type MediaStorageLike,
  type MediaStoreLike,
} from '../src/media/index.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { InMemoryAgentStore } from '../src/testing/index.js';
import { type BootedApp, bootAgentApp, readSse } from './helpers/boot-agent-app.js';

function fakeMedia(options: { sign?: boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  const rows = new Map<string, MediaRecordLike>();
  const disk: MediaDiskLike = {
    async put(key, contents) {
      files.set(key, contents);
    },
    async getBytes(key) {
      return files.get(key) ?? new Uint8Array();
    },
    async getUrl(key) {
      return `https://cdn.test/${key}`;
    },
    async getSignedUrl(key, opts) {
      if (options.sign === false) throw new Error('cannot sign');
      return `https://s3.test/${key}?ttl=${opts?.expiresIn}`;
    },
    async delete(key) {
      files.delete(key);
    },
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
  };
  return { files, rows, storage, store };
}

const alice = { id: 'alice' };
const bob = { id: 'bob' };
const upload = {
  data: Buffer.from('hi'),
  filename: '../../etc/notes.txt',
  contentType: 'text/plain',
  sizeBytes: 2,
};

describe('MediaAttachmentStaging', () => {
  it('stores an upload as a media row owned by the actor and resolves a signed url for its owner only', async () => {
    const media = fakeMedia();
    let n = 0;
    const staging = new MediaAttachmentStaging(media, { idGenerator: () => `m${++n}` });
    const staged = await staging.stage({ ...upload, actor: alice });
    expect(staged).toMatchObject({ mediaId: 'm1', name: 'notes.txt', contentType: 'text/plain' });
    expect([...media.files.keys()]).toEqual(['agent-actor/alice/agent-attachments/m1/notes.txt']);
    expect(media.rows.get('m1')).toMatchObject({
      ownerType: 'agent-actor',
      ownerId: 'alice',
      collection: 'agent-attachments',
    });

    expect(await staging.resolve({ mediaId: 'm1', actor: alice })).toEqual({
      mediaId: 'm1',
      contentType: 'text/plain',
      name: 'notes.txt',
      url: 'https://s3.test/agent-actor/alice/agent-attachments/m1/notes.txt?ttl=604800',
    });
    expect(await staging.resolve({ mediaId: 'm1', actor: bob })).toBeNull();
    expect(await staging.resolve({ mediaId: 'nope', actor: alice })).toBeNull();
  });

  it('lets canAccess widen access, and mints public / custom urls', async () => {
    const media = fakeMedia();
    const shared = new MediaAttachmentStaging(media, {
      idGenerator: () => 'm1',
      visibility: 'public',
      canAccess: ({ actor, allowed }) => allowed || actor.id === 'bob',
    });
    await shared.stage({ ...upload, actor: alice });
    expect((await shared.resolve({ mediaId: 'm1', actor: bob }))?.url).toMatch(
      /^https:\/\/cdn\.test\//,
    );
    const custom = new MediaAttachmentStaging(media, {
      resolveUrl: (record) => `/files/${record.id}`,
    });
    expect((await custom.resolve({ mediaId: 'm1', actor: alice }))?.url).toBe('/files/m1');
  });

  it('resolves media another actor staged when it rides a message in the caller’s own thread', async () => {
    const media = fakeMedia();
    const agentStore = new InMemoryAgentStore();
    const staging = new MediaAttachmentStaging(
      { ...media, agentStore },
      { idGenerator: () => 'm1' },
    );
    const attachment = await staging.stage({ ...upload, actor: alice });
    expect(await staging.resolve({ mediaId: 'm1', actor: bob })).toBeNull();

    const thread = await agentStore.createThread({ actor: bob, persona: 'default' });
    const message = await agentStore.appendMessage({
      threadId: thread.id,
      role: 'user',
      content: 'look',
      attachments: [attachment],
    });
    expect(await staging.resolve({ mediaId: 'm1', actor: bob })).not.toBeNull();

    // Derived, not remembered: once the message is gone, so is the access.
    await agentStore.truncateFrom(thread.id, message.id);
    expect(await staging.resolve({ mediaId: 'm1', actor: bob })).toBeNull();
  });

  it('hands canAccess the referenced verdict as `allowed`, so it can narrow it too', async () => {
    const media = fakeMedia();
    const agentStore = new InMemoryAgentStore();
    const seen: boolean[] = [];
    const staging = new MediaAttachmentStaging(
      { ...media, agentStore },
      {
        idGenerator: () => 'm1',
        canAccess: ({ record, actor, allowed }) => {
          seen.push(allowed);
          return allowed && record.ownerId === actor.id;
        },
      },
    );
    const attachment = await staging.stage({ ...upload, actor: alice });
    const thread = await agentStore.createThread({ actor: bob, persona: 'default' });
    await agentStore.appendMessage({
      threadId: thread.id,
      role: 'user',
      content: 'look',
      attachments: [attachment],
    });
    expect(await staging.resolve({ mediaId: 'm1', actor: bob })).toBeNull();
    expect(seen).toEqual([true]);
  });

  it('falls back to the bytes inline on a disk that cannot sign — for the model only', async () => {
    const media = fakeMedia({ sign: false });
    const staging = new MediaAttachmentStaging(media, { idGenerator: () => 'm1' });
    expect((await staging.stage({ ...upload, actor: alice })).url).toBe('');
    expect((await staging.resolve({ mediaId: 'm1', actor: alice }))?.url).toBe(
      'data:text/plain;base64,aGk=',
    );
  });
});

describe('attachments over HTTP', () => {
  let booted: BootedApp | null = null;
  afterEach(async () => {
    await booted?.close();
    booted = null;
  });
  const json = (id: string) => ({ 'content-type': 'application/json', 'x-actor-id': id });

  async function uploadAs(url: string, id: string): Promise<MessageAttachment> {
    const form = new FormData();
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
    const response = await fetch(`${url}/agent/attachments`, {
      method: 'POST',
      headers: { 'x-actor-id': id },
      body: form,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as MessageAttachment;
  }
  const send = (url: string, id: string, attachments: unknown) =>
    fetch(`${url}/agent/chat`, {
      method: 'POST',
      headers: json(id),
      body: JSON.stringify({ message: 'see file', attachments }),
    });

  it('resolves { mediaId } refs server-side and refuses anything else', async () => {
    booted = await bootAgentApp({
      model: new FakeModelProvider(() => ({ text: 'Got it.' })),
      attachments: attachmentStores.memory({ maxBytes: 1024 }),
    });
    const { url } = booted;
    const config = (await (await fetch(`${url}/agent/config`, { headers: json('u1') })).json()) as {
      attachments: unknown;
    };
    expect(config.attachments).toMatchObject({
      enabled: true,
      upload: 'multipart',
      maxBytes: 1024,
      maxPerMessage: 10,
    });

    const staged = await uploadAs(url, 'u1');
    const ok = await send(url, 'u1', [{ mediaId: staged.mediaId }]);
    expect(ok.status).toBe(200);
    const threadId = ok.headers.get('x-agent-thread-id');
    await readSse(ok);
    const thread = (await (
      await fetch(`${url}/agent/threads/${threadId}`, { headers: json('u1') })
    ).json()) as ThreadDetail;
    expect(thread.messages[0]?.attachments).toEqual([
      { mediaId: staged.mediaId, url: staged.url, contentType: 'text/plain', name: 'notes.txt' },
    ]);

    expect(
      (await send(url, 'u1', [{ mediaId: staged.mediaId, url: 'https://evil.test/x' }])).status,
    ).toBe(400);
    expect((await send(url, 'u1', [staged.mediaId])).status).toBe(400);
    expect((await send(url, 'u2', [{ mediaId: staged.mediaId }])).status).toBe(403);
  });

  it('re-mints each attachment url when a thread is read back', async () => {
    let minted = 0;
    const store: AttachmentStagingStore = {
      async stage(input) {
        return {
          mediaId: 'm1',
          url: 'https://s3.test/v0',
          contentType: input.contentType,
          name: input.filename,
        };
      },
      async resolve({ mediaId }) {
        minted += 1;
        return {
          mediaId,
          url: `https://s3.test/v${minted}`,
          contentType: 'text/plain',
          name: 'notes.txt',
        };
      },
    };
    booted = await bootAgentApp({
      model: new FakeModelProvider(() => ({ text: 'Ok.' })),
      attachments: store,
    });
    const { url } = booted;
    const response = await send(url, 'u1', [{ mediaId: 'm1' }]);
    const threadId = response.headers.get('x-agent-thread-id');
    await readSse(response);
    const read = async () =>
      (
        (await (
          await fetch(`${url}/agent/threads/${threadId}`, { headers: json('u1') })
        ).json()) as ThreadDetail
      ).messages[0]?.attachments?.[0]?.url;
    expect(await read()).toBe('https://s3.test/v2');
    expect(await read()).toBe('https://s3.test/v3');
  });

  it('answers 501 for refs when attachments are off', async () => {
    booted = await bootAgentApp({ model: new FakeModelProvider(() => ({ text: 'Ok.' })) });
    expect((await send(booted.url, 'u1', [{ mediaId: 'm1' }])).status).toBe(501);
  });
});
