// Resumable (tus) chat attachments end to end, with every piece real: `@dudousxd/nestjs-agent-react`'s
// `createMediaUpload` (re-exported as `@adonis-agora/agent/react/media`) → this package's
// `POST <path>/attachments/uploads` routes over HTTP → `@adonis-agora/media`'s own
// `ResumableUploadManager` + `TusUploadHandler`. Only the media library's tus ROUTE is replaced — by
// a fetch hook that hands the request to its framework-neutral handler — because the media provider
// is not booted here; the handler, the session store and the disk are the library's.

import {
  ResumableUploadManager,
  StorageManager,
  type TusRequest,
  TusUploadHandler,
} from '@adonis-agora/media';
import {
  InMemoryMediaStore,
  InMemoryUploadSessionStore,
  inMemoryDiskResolver,
} from '@adonis-agora/media/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { MessageAttachment } from '../src/index.js';
import {
  MediaAttachmentStaging,
  type MediaStorageLike,
  type MediaStoreLike,
} from '../src/media/index.js';
import { createMediaUpload } from '../src/react/media.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { InMemoryAgentStore } from '../src/testing/index.js';
import { type BootedApp, bootAgentApp } from './helpers/boot-agent-app.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6]);
const ALICE = { id: 'alice' };
const BOB = { id: 'bob' };

function media(options: { resumable?: boolean } = {}) {
  const { resolve, disks } = inMemoryDiskResolver(['fs']);
  const storage = new StorageManager({ default: 'fs', resolve });
  const store = new InMemoryMediaStore();
  const uploads = new ResumableUploadManager({
    storage,
    sessions: new InMemoryUploadSessionStore(),
  });
  const tus = new TusUploadHandler({
    manager: uploads,
    disk: 'fs',
    basePath: '/media/uploads/tus',
  });
  const agentStore = new InMemoryAgentStore();
  let n = 0;
  const staging = new MediaAttachmentStaging(
    {
      storage: storage as unknown as MediaStorageLike,
      store: store as unknown as MediaStoreLike,
      agentStore,
      uploads: options.resumable === false ? null : uploads,
    },
    { idGenerator: () => `m${++n}`, allowedContentTypes: ['image/png'], maxBytes: 1024 },
  );
  return { storage, store, uploads, tus, disks, staging, agentStore };
}

/** Write bytes into a session the way the tus `PATCH` route does. */
async function pushBytes(tus: TusUploadHandler, uploadId: string, bytes: Uint8Array) {
  const response = await tus.handle({
    method: 'PATCH',
    uploadId,
    headers: {
      'tus-resumable': '1.0.0',
      'content-type': 'application/offset+octet-stream',
      'upload-offset': '0',
    },
    body: bytes,
  });
  expect(response.status).toBe(204);
}

describe('MediaAttachmentStaging — resumable uploads', () => {
  it('opens a session, refuses the file until its bytes land, then attaches it', async () => {
    const { staging, tus } = media();
    expect(staging.describe().upload).toBe('resumable');
    const begun = await staging.beginUpload({
      actor: ALICE,
      filename: 'cat.png',
      contentType: 'image/png',
      size: PNG.byteLength,
    });
    expect(begun.location).toBe(`/media/uploads/tus/${begun.uploadId}`);
    // Pending: not attachable, and completion says the bytes are missing.
    expect(await staging.resolve({ mediaId: begun.mediaId, actor: ALICE })).toBeNull();
    await expect(
      staging.completeUpload({ actor: ALICE, mediaId: begun.mediaId }),
    ).rejects.toMatchObject({ status: 409 });

    await pushBytes(tus, begun.uploadId, PNG);
    const attachment = await staging.completeUpload({ actor: ALICE, mediaId: begun.mediaId });
    expect(attachment).toMatchObject({ mediaId: begun.mediaId, name: 'cat.png' });
    // Idempotent once ready, and only for the uploader.
    expect(await staging.completeUpload({ actor: ALICE, mediaId: begun.mediaId })).not.toBeNull();
    expect(await staging.completeUpload({ actor: BOB, mediaId: begun.mediaId })).toBeNull();
    expect(await staging.resolve({ mediaId: begun.mediaId, actor: ALICE })).not.toBeNull();
    expect(await staging.resolve({ mediaId: begun.mediaId, actor: BOB })).toBeNull();
    expect(await staging.discard({ actor: BOB, mediaId: begun.mediaId })).toBe(false);
  });

  it('refuses content types and sizes outside the policy before any session opens', async () => {
    const { staging } = media();
    const begin = (filename: string, contentType: string, size: number) =>
      staging.beginUpload({ actor: ALICE, filename, contentType, size });
    await expect(begin('x.exe', 'app/x', 1)).rejects.toMatchObject({ status: 415 });
    await expect(begin('big.png', 'image/png', 2048)).rejects.toMatchObject({ status: 413 });
    await expect(begin('', 'image/png', 1)).rejects.toMatchObject({ status: 400 });
    await expect(begin('zero.png', 'image/png', 0)).rejects.toMatchObject({ status: 400 });
  });

  it('drops an upload whose bytes do not match the declared size', async () => {
    const { staging, uploads, store, disks } = media();
    const begun = await staging.beginUpload({
      actor: ALICE,
      filename: 'cat.png',
      contentType: 'image/png',
      size: PNG.byteLength,
    });
    // A session completed short of its declared size (the tus route would refuse to; a bypass may not).
    await uploads.writeChunk(begun.uploadId, 0, PNG.subarray(0, 4));
    await uploads.complete(begun.uploadId);
    await expect(
      staging.completeUpload({ actor: ALICE, mediaId: begun.mediaId }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await store.find(begun.mediaId)).toBeNull();
    expect(disks.fs?.files.size).toBe(0);
  });

  it('discards an upload in flight, aborting its session', async () => {
    const { staging, uploads, store } = media();
    const begun = await staging.beginUpload({
      actor: ALICE,
      filename: 'cat.png',
      contentType: 'image/png',
      size: PNG.byteLength,
    });
    expect(await staging.discard({ actor: ALICE, mediaId: begun.mediaId })).toBe(true);
    expect(await store.find(begun.mediaId)).toBeNull();
    await expect(uploads.status(begun.uploadId)).rejects.toThrow();
  });

  it('is multipart-only, and says so, without `uploads.resumable` on the media library', async () => {
    const { staging } = media({ resumable: false });
    expect(staging.describe().upload).toBe('multipart');
    await expect(
      staging.beginUpload({ actor: ALICE, filename: 'a.png', contentType: 'image/png', size: 1 }),
    ).rejects.toMatchObject({ status: 501 });
  });
});

describe('resumable uploads over HTTP, driven by @adonis-agora/agent/react/media', {
  timeout: 30_000,
}, () => {
  let booted: BootedApp | null = null;
  afterEach(async () => {
    await booted?.close();
    booted = null;
  });

  async function boot(options: { resumable?: boolean } = {}) {
    const lib = media(options);
    booted = await bootAgentApp({
      model: new FakeModelProvider(() => ({ text: 'ok' })),
      attachments: lib.staging,
    });
    // The media library's tus route, as its provider would mount it under `/media/uploads/tus`.
    const tusRoute: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (!url.pathname.startsWith('/media/uploads/tus/')) return fetch(input, init);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const body =
        init?.body instanceof Blob ? new Uint8Array(await init.body.arrayBuffer()) : undefined;
      const answer = await lib.tus.handle({
        method: (init?.method ?? 'GET') as TusRequest['method'],
        uploadId: url.pathname.split('/').pop() as string,
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      return new Response(answer.body ?? null, { status: answer.status, headers: answer.headers });
    };
    return { ...lib, url: booted.url, fetch: tusRoute };
  }

  it('begins, streams over tus, completes — and the chat config says resumable', async () => {
    const { url, fetch: tusFetch, staging } = await boot();
    const config = (await (
      await fetch(`${url}/agent/config`, { headers: { 'x-actor-id': 'alice' } })
    ).json()) as { attachments: { upload: string } };
    expect(config.attachments.upload).toBe('resumable');

    const upload = createMediaUpload({
      baseUrl: url,
      headers: { 'x-actor-id': 'alice' },
      fetch: tusFetch,
      chunkSize: 5,
    });
    const progress: number[] = [];
    const attachment: MessageAttachment = await upload(
      new File([PNG], 'cat.png', { type: 'image/png' }),
      { onProgress: (value) => progress.push(value) },
    );
    expect(attachment).toMatchObject({ name: 'cat.png', contentType: 'image/png' });
    expect(progress.at(-1)).toBe(1);
    expect(await staging.resolve({ mediaId: attachment.mediaId, actor: ALICE })).not.toBeNull();
  });

  it('answers the refusals with their status, and 404 for another actor’s upload', async () => {
    const { url } = await boot();
    const post = (path: string, body?: unknown, actor = 'alice') =>
      fetch(`${url}/agent/attachments/uploads${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-actor-id': actor },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    expect((await post('', { filename: 'a.exe', contentType: 'app/x', size: 1 })).status).toBe(415);
    const begun = (await (
      await post('', { filename: 'a.png', contentType: 'image/png', size: PNG.byteLength })
    ).json()) as { mediaId: string };
    expect((await post(`/${begun.mediaId}/complete`)).status).toBe(409);
    expect((await post(`/${begun.mediaId}/complete`, undefined, 'bob')).status).toBe(404);
    const drop = (actor: string) =>
      fetch(`${url}/agent/attachments/uploads/${begun.mediaId}`, {
        method: 'DELETE',
        headers: { 'x-actor-id': actor },
      });
    expect((await drop('bob')).status).toBe(404);
    expect((await drop('alice')).status).toBe(204);
  });

  it('mounts no upload-session routes when the media library has no resumable uploads', async () => {
    const { url } = await boot({ resumable: false });
    const response = await fetch(`${url}/agent/attachments/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'alice' },
      body: JSON.stringify({ filename: 'a.png', contentType: 'image/png', size: 1 }),
    });
    expect(response.status).toBe(404);
  });
});
