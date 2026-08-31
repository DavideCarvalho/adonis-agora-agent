import diagnostics_channel from 'node:diagnostics_channel';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultTextExtractor,
  MediaRagIngestion,
  MediaRagResolveRequiredError,
  type MediaRef,
  MemoryVectorStore,
  mediaRagIngestion,
  UPLOAD_COMPLETE_CHANNEL,
  type UploadCompletePayload,
} from '../src/index.js';
import {
  FakeEmbeddingProvider,
  FakeMediaManager,
  fakePdfExtractor,
  inMemoryMediaRagIngestion,
} from '../src/testing/index.js';

/** Publish a raw `agora:media:upload.complete` diagnostics envelope, as a media library would. */
function publishUploadComplete(payload: UploadCompletePayload): void {
  diagnostics_channel.channel(UPLOAD_COMPLETE_CHANNEL).publish({
    v: 1,
    ts: Date.now(),
    lib: 'media',
    event: 'upload.complete',
    payload,
  });
}

const ingestions: MediaRagIngestion[] = []; // teardown so no subscriber leaks across tests
afterEach(async () => {
  for (const ingestion of ingestions.splice(0)) {
    await ingestion.unsubscribe();
  }
});
function track(ingestion: MediaRagIngestion): MediaRagIngestion {
  ingestions.push(ingestion);
  return ingestion;
}

describe('mediaRagIngestion.ingestMedia', () => {
  it('extracts, chunks, embeds and stores a text/plain file with owner/tenant metadata', async () => {
    const { ingestion, store, media } = inMemoryMediaRagIngestion();
    media.put('uploads', 'docs/handbook.txt', 'The onboarding handbook explains vacation policy.');

    const result = await ingestion.ingestMedia({
      id: 'media_1',
      disk: 'uploads',
      key: 'docs/handbook.txt',
      contentType: 'text/plain',
      ownerType: 'user',
      ownerId: 'u_1',
      collection: 'handbooks',
      tenantRef: 'tenant_a',
    });

    expect(result).toEqual({ status: 'ingested', chunks: 1 });
    const docs = await store.listDocuments();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toEqual({
      id: 'media_1',
      metadata: {
        mediaId: 'media_1',
        ownerType: 'user',
        ownerId: 'u_1',
        collection: 'handbooks',
        tenantRef: 'tenant_a',
      },
    });
  });

  it('ingests text/csv and application/json', async () => {
    const media = new FakeMediaManager()
      .put('d', 'data.csv', 'name,role\nada,eng\ngrace,eng')
      .put('d', 'data.json', JSON.stringify({ hello: 'world' }));
    const { ingestion, store } = inMemoryMediaRagIngestion({ media });

    const csv = await ingestion.ingestMedia({
      id: 'csv_1',
      disk: 'd',
      key: 'data.csv',
      contentType: 'text/csv',
    });
    const json = await ingestion.ingestMedia({
      id: 'json_1',
      disk: 'd',
      key: 'data.json',
      contentType: 'application/json; charset=utf-8',
    });

    expect(csv.status).toBe('ingested');
    expect(json.status).toBe('ingested');
    expect(await store.listDocuments()).toHaveLength(2);
  });

  it('re-ingesting the same media id replaces its chunks (remove-then-upsert)', async () => {
    const media = new FakeMediaManager().put('d', 'a.txt', 'first version');
    const { ingestion, store } = inMemoryMediaRagIngestion({ media });
    const ref: MediaRef = { id: 'm', disk: 'd', key: 'a.txt', contentType: 'text/plain' };

    await ingestion.ingestMedia(ref);
    media.put(
      'd',
      'a.txt',
      'a completely different, much longer second version of the document body',
    );
    await ingestion.ingestMedia(ref);

    const docs = await store.listDocuments();
    expect(docs).toHaveLength(1);
    expect(docs[0]?.id).toBe('m');
  });
});

describe('content-type filtering', () => {
  it('skips a content type absent from the allow-list', async () => {
    const media = new FakeMediaManager().put('d', 'f.txt', 'hello');
    const { ingestion, store } = inMemoryMediaRagIngestion({
      media,
      contentTypes: ['text/markdown'],
    });

    const result = await ingestion.ingestMedia({
      id: 'm',
      disk: 'd',
      key: 'f.txt',
      contentType: 'text/plain',
    });

    expect(result).toEqual({ status: 'skipped', reason: 'unsupported-type' });
    expect(await store.listDocuments()).toHaveLength(0);
  });

  it('skips an unsupported binary type (no extractor) rather than indexing garbage', async () => {
    const media = new FakeMediaManager().put('d', 'f.pdf', 'PDFBYTES');
    const { ingestion, store } = inMemoryMediaRagIngestion({ media });

    const result = await ingestion.ingestMedia({
      id: 'm',
      disk: 'd',
      key: 'f.pdf',
      contentType: 'application/pdf',
    });

    expect(result).toEqual({ status: 'skipped', reason: 'unsupported-type' });
    expect(await store.listDocuments()).toHaveLength(0);
  });

  it('skips a file larger than maxBytes', async () => {
    const media = new FakeMediaManager().put('d', 'big.txt', 'hello world');
    const { ingestion, store } = inMemoryMediaRagIngestion({ media, maxBytes: 4 });

    const result = await ingestion.ingestMedia({
      id: 'm',
      disk: 'd',
      key: 'big.txt',
      contentType: 'text/plain',
      size: 11,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'too-large' });
    expect(await store.listDocuments()).toHaveLength(0);
  });

  it('skips a file whose extracted text is empty', async () => {
    const media = new FakeMediaManager().put('d', 'blank.txt', '   \n  ');
    const { ingestion } = inMemoryMediaRagIngestion({ media });
    const result = await ingestion.ingestMedia({
      id: 'm',
      disk: 'd',
      key: 'blank.txt',
      contentType: 'text/plain',
    });
    expect(result).toEqual({ status: 'skipped', reason: 'empty-text' });
  });
});

describe('tenant/owner metadata is filterable at retrieval', () => {
  it('retrieval filtered by tenantRef only returns that tenant’s chunks', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    const media = new FakeMediaManager()
      .put('d', 'a.txt', 'shared secret vacation policy alpha')
      .put('d', 'b.txt', 'shared secret vacation policy beta');
    const { ingestion, retriever } = inMemoryMediaRagIngestion({ embedder, store, media });

    await ingestion.ingestMedia({
      id: 'a',
      disk: 'd',
      key: 'a.txt',
      contentType: 'text/plain',
      tenantRef: 'tenant_a',
    });
    await ingestion.ingestMedia({
      id: 'b',
      disk: 'd',
      key: 'b.txt',
      contentType: 'text/plain',
      tenantRef: 'tenant_b',
    });

    const passages = await retriever.retrieve('vacation policy', {
      topK: 10,
      filter: { tenantRef: 'tenant_a' },
    });
    expect(passages.length).toBeGreaterThan(0);
    for (const passage of passages) {
      expect(passage.metadata?.tenantRef).toBe('tenant_a');
    }
  });
});

describe('pluggable extractor hook (application/pdf)', () => {
  it('invokes an injected fake pdf extractor for application/pdf', async () => {
    const extractor = defaultTextExtractor().register(
      'application/pdf',
      fakePdfExtractor('parsed pdf body'),
    );
    const media = new FakeMediaManager().put('d', 'f.pdf', 'RAWPDF');
    const { ingestion, store } = inMemoryMediaRagIngestion({
      media,
      extractor,
      contentTypes: ['application/pdf'],
    });

    const result = await ingestion.ingestMedia({
      id: 'pdf_1',
      disk: 'd',
      key: 'f.pdf',
      contentType: 'application/pdf',
    });

    expect(result).toEqual({ status: 'ingested', chunks: 1 });
    const passages = await store.search(
      (await new FakeEmbeddingProvider().embed(['parsed pdf body']))[0]!,
      { topK: 1 },
    );
    expect(passages[0]?.text).toBe('parsed pdf body');
  });
});

describe('auto-subscribe on upload.complete', () => {
  it('ingests a resolved upload when subscribed', async () => {
    const media = new FakeMediaManager().put('uploads', 'k/1', 'auto ingested content');
    const resolve = async (payload: UploadCompletePayload): Promise<MediaRef> => ({
      id: payload.id,
      disk: payload.disk,
      key: payload.key,
      contentType: 'text/plain',
      tenantRef: 'tenant_x',
    });
    const { ingestion, store } = inMemoryMediaRagIngestion({ media, resolve });
    track(ingestion);

    ingestion.subscribe();
    publishUploadComplete({ id: 'media_9', disk: 'uploads', key: 'k/1' });
    await ingestion.settle();

    const docs = await store.listDocuments();
    expect(docs).toHaveLength(1);
    expect(docs[0]?.metadata?.tenantRef).toBe('tenant_x');
  });

  it('does nothing after unsubscribe', async () => {
    const media = new FakeMediaManager().put('uploads', 'k/2', 'content');
    const resolve = async (p: UploadCompletePayload): Promise<MediaRef> => ({
      id: p.id,
      disk: p.disk,
      key: p.key,
      contentType: 'text/plain',
    });
    const { ingestion, store } = inMemoryMediaRagIngestion({ media, resolve });

    const off = ingestion.subscribe();
    off();
    publishUploadComplete({ id: 'media_10', disk: 'uploads', key: 'k/2' });
    await ingestion.settle();

    expect(await store.listDocuments()).toHaveLength(0);
  });

  it('subscribe() throws without a resolve seam', () => {
    const { ingestion } = inMemoryMediaRagIngestion();
    expect(() => ingestion.subscribe()).toThrow(MediaRagResolveRequiredError);
  });
});

describe('unconfigured / no-op behaviour', () => {
  it('an ingestion that never subscribed ignores upload.complete events', async () => {
    const media = new FakeMediaManager().put('uploads', 'k/3', 'content');
    const store = new MemoryVectorStore();
    // Build the bridge but do NOT subscribe.
    mediaRagIngestion({
      media,
      embedder: new FakeEmbeddingProvider(),
      store,
      resolve: async (p) => ({ id: p.id, disk: p.disk, key: p.key, contentType: 'text/plain' }),
    });

    publishUploadComplete({ id: 'media_11', disk: 'uploads', key: 'k/3' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(await store.listDocuments()).toHaveLength(0);
  });

  it('handleUploadComplete is a no-op when resolve is unconfigured', async () => {
    const { ingestion, store } = inMemoryMediaRagIngestion();
    const result = await ingestion.handleUploadComplete({ id: 'x', disk: 'd', key: 'k' });
    expect(result).toBeUndefined();
    expect(await store.listDocuments()).toHaveLength(0);
  });
});

describe('removeMedia', () => {
  it('drops a media document’s chunks from the store', async () => {
    const media = new FakeMediaManager().put('d', 'a.txt', 'some indexed body text');
    const { ingestion, store } = inMemoryMediaRagIngestion({ media });
    await ingestion.ingestMedia({ id: 'm', disk: 'd', key: 'a.txt', contentType: 'text/plain' });
    expect(await store.listDocuments()).toHaveLength(1);

    await ingestion.removeMedia('m');
    expect(await store.listDocuments()).toHaveLength(0);
  });
});
