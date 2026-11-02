import { QdrantClient } from '@qdrant/js-client-rest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QdrantClientLike } from '../src/index.js';
import { chunkIdToPointId, QdrantStore } from '../src/index.js';

/**
 * Live-Qdrant verification for the store capabilities that a fake cannot honestly prove: whether
 * `set_payload` really leaves the vector alone, and whether a filtered `delete` really honours the
 * empty-array deny the same way `query` does. A fake proves only that we CALL the client a certain way;
 * these prove the server does what we think it does with that call.
 *
 * Skipped unless `AGENT_QDRANT_URL` points at a throwaway Qdrant (it creates and drops its own
 * collection):
 *
 *   docker run -d -p 6399:6333 qdrant/qdrant
 *   AGENT_QDRANT_URL=http://127.0.0.1:6399 npx vitest run test/rag-qdrant-live.spec.ts
 */
const URL = process.env.AGENT_QDRANT_URL;
const COLLECTION = `agent_rag_live_${process.pid}`;
const DIM = 4;

const A = [1, 0, 0, 0];
const B = [0, 1, 0, 0];
const C = [0, 0, 1, 0];
const D = [0, 0, 0, 1];

describe.skipIf(URL === undefined)('QdrantStore against a live Qdrant', () => {
  let raw: QdrantClient;
  let client: QdrantClientLike;
  let store: QdrantStore;

  beforeAll(async () => {
    raw = new QdrantClient({ url: String(URL) });
    client = raw as unknown as QdrantClientLike;
    store = new QdrantStore(client, { collection: COLLECTION, dimension: DIM });
    await store.ensureCollection();
  });

  afterAll(async () => {
    if (raw !== undefined) {
      await raw.deleteCollection(COLLECTION).catch(() => undefined);
    }
  });

  it('concurrent replaceDocument calls in one process leave exactly one version', async () => {
    for (let round = 0; round < 5; round++) {
      await Promise.all(
        Array.from({ length: 6 }, (_, writer) =>
          store.replaceDocument(
            'race',
            Array.from({ length: 12 - writer }, (_, chunk) => ({
              id: `race#${chunk}`,
              text: `writer-${writer}`,
              embedding: D,
            })),
          ),
        ),
      );
      const hits = await store.search(D, { topK: 30 });
      const race = hits.filter((hit) => hit.text.startsWith('writer-'));
      expect(new Set(race.map((hit) => hit.text)).size).toBe(1);
      expect(race).toHaveLength(7);
    }
    await store.remove('race');
  });

  describe('replaceDocument across store instances, as separate processes would be', () => {
    /** A store whose writes stop at the turnstile named by `stops`, in the order the test opens them. */
    function writer(stops: Record<number, Promise<void>>, reached?: Record<number, () => void>) {
      let writes = 0;
      const pausing = async () => {
        writes += 1;
        reached?.[writes]?.();
        await stops[writes];
      };
      const paused = {
        ...Object.fromEntries(
          ['getCollections', 'createCollection', 'query', 'scroll'].map((name) => [
            name,
            (...args: unknown[]) =>
              (raw as unknown as Record<string, (...a: unknown[]) => unknown>)[name]?.(...args),
          ]),
        ),
        upsert: async (collection: string, args: never) => {
          await pausing();
          return raw.upsert(collection, args);
        },
        delete: async (collection: string, args: never) => {
          await pausing();
          return raw.delete(collection, args);
        },
      } as unknown as QdrantClientLike;
      return new QdrantStore(paused, {
        collection: COLLECTION,
        dimension: DIM,
        upsertBatchSize: 1,
      });
    }

    const version = (text: string, length: number) =>
      Array.from({ length }, (_, chunk) => ({ id: `multi#${chunk}`, text, embedding: D }));

    const stored = async () => {
      const page = await raw.scroll(COLLECTION, {
        filter: { must: [{ key: 'documentId', match: { value: 'multi' } }] },
        with_payload: true,
        limit: 100,
      });
      return page.points.map((point) => String(point.payload?.text));
    };

    function turnstile() {
      let open = () => {};
      let arrive = () => {};
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      const arrived = new Promise<void>((resolve) => {
        arrive = resolve;
      });
      return { open, opened, arrive, arrived };
    }

    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

    beforeEach(async () => {
      await store.remove('multi');
      await tick();
    });

    it('an older writer paused before its delete does not cut the newer version', async () => {
      const gate = turnstile();
      const older = writer({ 4: gate.opened }, { 4: gate.arrive }).replaceDocument(
        'multi',
        version('older', 3),
      );
      await gate.arrived;
      await tick();
      await writer({}).replaceDocument('multi', version('newer', 5));
      gate.open();
      await older;
      const texts = await stored();
      expect(new Set(texts)).toEqual(new Set(['newer']));
      expect(texts).toHaveLength(5);
    });

    it('an older writer paused between writes leaves no chunk behind the newer version', async () => {
      const gate = turnstile();
      const older = writer({ 2: gate.opened }, { 2: gate.arrive }).replaceDocument(
        'multi',
        version('older', 5),
      );
      await gate.arrived;
      await tick();
      await writer({}).replaceDocument('multi', version('newer', 3));
      gate.open();
      await older;
      const texts = await stored();
      expect(new Set(texts)).toEqual(new Set(['newer']));
      expect(texts).toHaveLength(3);
    });

    it('an older writer starting its writes during the newer one cannot overwrite it', async () => {
      const newerGate = turnstile();
      const olderGate = turnstile();
      const older = writer({ 1: olderGate.opened }, { 1: olderGate.arrive }).replaceDocument(
        'multi',
        version('older', 4),
      );
      await olderGate.arrived;
      await tick();
      const newer = writer({ 3: newerGate.opened }, { 3: newerGate.arrive }).replaceDocument(
        'multi',
        version('newer', 4),
      );
      await newerGate.arrived;
      olderGate.open();
      await older;
      newerGate.open();
      await newer;
      const texts = await stored();
      expect(new Set(texts)).toEqual(new Set(['newer']));
      expect(texts).toHaveLength(4);
    });

    it('writers overlapping at random always leave exactly one whole version', async () => {
      for (let round = 0; round < 15; round++) {
        const lengths = [3, 7, 5];
        const jitter = new Proxy(raw, {
          get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            return typeof value !== 'function'
              ? value
              : async (...args: unknown[]) => {
                  await new Promise((resolve) => setTimeout(resolve, Math.random() * 6));
                  return value.apply(target, args);
                };
          },
        }) as unknown as QdrantClientLike;
        await Promise.all(
          lengths.map((length, index) =>
            new QdrantStore(jitter, {
              collection: COLLECTION,
              dimension: DIM,
              upsertBatchSize: 1,
            }).replaceDocument('multi', version(`writer-${index}`, length)),
          ),
        );
        const texts = await stored();
        expect(new Set(texts).size).toBe(1);
        const winner = Number(texts[0]?.slice('writer-'.length));
        expect(texts).toHaveLength(lengths[winner] as number);
      }
    });

    it('a later call on a host whose clock runs behind still wins', async () => {
      await store.replaceDocument('multi', version('earlier', 4));
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 3_600_000);
      try {
        await store.replaceDocument('multi', version('later', 2));
      } finally {
        clock.mockRestore();
      }
      expect(await stored()).toEqual(['later', 'later']);
    });

    it('replaces chunks stored without a generation', async () => {
      await store.upsert(version('legacy', 4));
      await store.replaceDocument('multi', version('current', 2));
      expect(await stored()).toEqual(['current', 'current']);
    });

    it('a plain upsert after a replace still overwrites its chunk', async () => {
      await store.replaceDocument('multi', version('replaced', 1));
      await store.upsert(version('upserted', 1));
      expect(await stored()).toEqual(['upserted']);
    });
  });

  /** Re-seed a known corpus, waiting for it to be visible. */
  async function seed(): Promise<void> {
    await raw.delete(COLLECTION, { filter: {}, wait: true }).catch(() => undefined);
    await store.upsert([
      {
        id: 'alpha#0',
        text: 'alpha zero',
        embedding: A,
        metadata: { audience: ['public'], rev: 1 },
      },
      {
        id: 'alpha#1',
        text: 'alpha one',
        embedding: B,
        metadata: { audience: ['public'], rev: 1 },
      },
      {
        id: 'beta#0',
        text: 'beta zero',
        embedding: C,
        metadata: { audience: ['role:ADMIN'], rev: 1 },
      },
    ]);
    // upsert does not pass `wait`, so give Qdrant a beat to index before asserting.
    for (let i = 0; i < 50; i++) {
      const { count } = await raw.count(COLLECTION, { exact: true });
      if (count === 3) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('seed did not become visible');
  }

  async function vectorOf(chunkId: string): Promise<number[]> {
    const result = await raw.retrieve(COLLECTION, {
      ids: [chunkIdToPointId(chunkId)],
      with_vector: true,
      with_payload: true,
    });
    const vector = result[0]?.vector;
    if (!Array.isArray(vector)) throw new Error(`no vector for ${chunkId}`);
    return vector as number[];
  }

  it('updateMetadata leaves the stored vectors byte-identical (real set_payload)', async () => {
    await seed();
    const before = { a0: await vectorOf('alpha#0'), a1: await vectorOf('alpha#1') };
    expect(before.a0).toEqual(A);

    const written = await store.updateMetadata('alpha', { audience: ['role:ADMIN'], rev: null });
    expect(written).toBe(2);

    expect(await vectorOf('alpha#0')).toEqual(before.a0);
    expect(await vectorOf('alpha#1')).toEqual(before.a1);
  });

  it('updateMetadata rewrites metadata, deletes null keys, and keeps text/source', async () => {
    await seed();
    await store.updateMetadata('alpha', { audience: ['role:ADMIN'], rev: null, added: 'yes' });

    const points = await raw.retrieve(COLLECTION, {
      ids: [chunkIdToPointId('alpha#0')],
      with_payload: true,
    });
    expect(points[0]!.payload).toMatchObject({
      id: 'alpha#0',
      documentId: 'alpha',
      text: 'alpha zero',
      metadata: { audience: ['role:ADMIN'], added: 'yes' },
    });
    expect(
      (points[0]!.payload as { metadata: Record<string, unknown> }).metadata.rev,
    ).toBeUndefined();
  });

  it('the rewritten metadata is immediately filterable by search', async () => {
    await seed();
    await store.updateMetadata('alpha', { audience: ['role:ADMIN'] });
    const admin = await store.search(A, { topK: 10, filter: { audience: ['role:ADMIN'] } });
    expect(admin.map((p) => p.id).sort()).toEqual(['alpha#0', 'alpha#1', 'beta#0']);
    const pub = await store.search(A, { topK: 10, filter: { audience: ['public'] } });
    expect(pub).toEqual([]);
  });

  it('updateMetadata on an unknown document returns 0', async () => {
    await seed();
    expect(await store.updateMetadata('nope', { a: 1 })).toBe(0);
  });

  it('listDocumentIds matches listDocuments for the same filter', async () => {
    await seed();
    for (const filter of [
      undefined,
      {},
      { audience: ['public'] },
      { audience: ['role:ADMIN'] },
      { rev: 1 },
      { audience: ['nobody'] },
      { audience: [] },
      { audience: [], rev: 1 },
    ]) {
      const ids = await store.listDocumentIds(filter);
      const docs = await store.listDocuments(filter);
      expect([...ids].sort(), `filter=${JSON.stringify(filter)}`).toEqual(
        docs.map((d) => d.id).sort(),
      );
    }
  });

  it('an empty-array filter denies on the live server for search AND for removeWhere', async () => {
    await seed();
    // This is the assertion a fake cannot make: that Qdrant itself treats `any: []` as "matches
    // nothing" rather than erroring or matching everything.
    expect(await store.search(A, { topK: 10, filter: { audience: [] } })).toEqual([]);
    expect(await store.listDocumentIds({ audience: [] })).toEqual([]);
    expect(await store.removeWhere({ audience: [] })).toBe(0);
    expect(await store.removeWhere({ audience: [], rev: 1 })).toBe(0);
    expect(await store.search(A, { topK: 10, filter: { audience: [], rev: 1 } })).toEqual([]);
    // Nothing was removed.
    expect((await raw.count(COLLECTION, { exact: true })).count).toBe(3);
  });

  it('removeWhere removes exactly what search with the same filter reaches, and nothing else', async () => {
    await seed();
    const reachable = await store.search(A, { topK: 100, filter: { audience: ['public'] } });
    expect(reachable.map((p) => p.id).sort()).toEqual(['alpha#0', 'alpha#1']);

    const removed = await store.removeWhere({ audience: ['public'] });
    expect(removed).toBe(2);

    expect((await raw.count(COLLECTION, { exact: true })).count).toBe(1);
    const survivors = await store.search(C, { topK: 100 });
    expect(survivors.map((p) => p.id)).toEqual(['beta#0']);
  });

  it('removeWhere refuses an empty filter instead of wiping the collection', async () => {
    await seed();
    await expect(store.removeWhere({})).rejects.toThrow(/empty filter/i);
    expect((await raw.count(COLLECTION, { exact: true })).count).toBe(3);
  });

  it('removeMany-by-enumeration still works: listDocumentIds then removeWhere on a scoping key', async () => {
    await seed();
    expect((await store.listDocumentIds()).sort()).toEqual(['alpha', 'beta']);
    expect(await store.removeWhere({ rev: 1 })).toBe(3);
    expect(await store.listDocumentIds()).toEqual([]);
  });
});

/**
 * Painel de inspeção ao vivo: `facetValues`/`countChunks`/`scrollChunks` com o filtro RAW
 * estendido (`is_empty`/`must_not`/`should`) — exatamente a linguagem que a agregação
 * server-side de um admin usa. O que só o server prova:
 *
 * - `facet` REAL exige índice de payload no campo — o primeiro facet numa coleção nova deve
 *   falhar, o store deve PROVISIONAR o índice keyword e repetir (o retry auto-provisionado
 *   acontece de verdade, não só no fake);
 * - `is_empty` cobre ausente E null (o bucket `desconhecido` do painel depende disso);
 * - `must_not: [is_empty]` é "campo presente" (a presença que habilita o GROUP BY);
 * - facet com `filter` honra a PRIORIDADE da cadeia de chave (campos anteriores vazios).
 */
const FACET_COLLECTION = `agent_rag_facet_live_${process.pid}`;

describe.skipIf(URL === undefined)('QdrantStore facets ao vivo (agregação de painel)', () => {
  let raw: QdrantClient;
  let store: QdrantStore;

  beforeAll(async () => {
    raw = new QdrantClient({ url: String(URL) });
    store = new QdrantStore(raw as unknown as QdrantClientLike, {
      collection: FACET_COLLECTION,
      dimension: DIM,
    });
    await store.ensureCollection();
    await store.upsert([
      { id: 'bula-P#0', text: 'b1', embedding: A, metadata: { tipo: 'bula', numeroProcesso: 'P' } },
      { id: 'bula-P#1', text: 'b2', embedding: B, metadata: { tipo: 'bula', numeroProcesso: 'P' } },
      { id: 'exame-E#0', text: 'e1', embedding: C, metadata: { tipo: 'exame', examId: 'E' } },
      // corpus real: SEM metadata.tipo, chave no campo `source` — o bucket `desconhecido`.
      { id: 'src-S-p1', text: 'c1', embedding: A, source: 'S', metadata: { page: 1 } },
      // cadeia com prioridade: tem numeroProcesso E examId E source — pertence só ao P.
      {
        id: 'mix#0',
        text: 'm',
        embedding: B,
        source: 'M',
        metadata: { tipo: 'exame', numeroProcesso: 'P', examId: 'E' },
      },
      // órfão de verdade: sem tipo E sem nenhum campo da cadeia — o `sem-chave` do painel.
      { id: 'solto#0', text: 's', embedding: C, metadata: { nota: 'x' } },
    ]);
    for (let i = 0; i < 50; i++) {
      const { count } = await raw.count(FACET_COLLECTION, { exact: true });
      if (count === 6) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });

  afterAll(async () => {
    if (raw !== undefined) {
      await raw.deleteCollection(FACET_COLLECTION).catch(() => undefined);
    }
  });

  it('facetValues: primeiro erro provisiona o índice keyword e o retry resolve com contagem EXATA', async () => {
    // Coleção nova NÃO tem índice de payload → o server recusa o primeiro facet; o retry
    // auto-provisionado tem que achar o índice recém-criado e contar certo.
    const hits = await store.facetValues('metadata.numeroProcesso', {
      filter: {
        must: [{ key: 'metadata.tipo', match: { value: 'bula' } }],
        must_not: [{ is_empty: { key: 'metadata.numeroProcesso' } }],
      },
    });
    expect(hits).toEqual([{ value: 'P', count: 2 }]);
  });

  it('facet com cadeia exclui o cross-chunk do examId (só o PRIMEIRO campo não-vazio conta)', async () => {
    const byExam = await store.facetValues('metadata.examId', {
      filter: {
        must: [
          { key: 'metadata.tipo', match: { value: 'exame' } },
          { is_empty: { key: 'metadata.numeroProcesso' } },
        ],
        must_not: [{ is_empty: { key: 'metadata.examId' } }],
      },
    });
    // mix#0 tem tipo 'exame' + numeroProcesso 'P' → a prioridade da cadeia o joga fora do E.
    expect(byExam).toEqual([{ value: 'E', count: 1 }]);
    // pelo numeroProcesso, mix#0 conta no P (bula-P#* filtradas pelo tipo ficam fora daqui):
    const byProcessoQualquerTipo = await store.facetValues('metadata.numeroProcesso', {
      filter: { must_not: [{ is_empty: { key: 'metadata.numeroProcesso' } }] },
    });
    expect(byProcessoQualquerTipo).toEqual([{ value: 'P', count: 3 }]);
  });

  it('countChunks e should(is_empty|literal) cobrem o bucket `desconhecido` (tipo ausente de verdade)', async () => {
    const desconhecidos = await store.countChunks({
      filter: {
        should: [
          { key: 'metadata.tipo', match: { value: 'desconhecido' } },
          { is_empty: { key: 'metadata.tipo' } },
        ],
      },
    });
    // corpus + órfão: tipo ausente nos dois (e nenhum dos dois é o literal 'desconhecido').
    expect(desconhecidos).toBe(2);
    // sem-chave: os campos da cadeia TODOS vazios — só o órfão se encaixa.
    const chaveless = await store.countChunks({
      filter: {
        must: [
          { is_empty: { key: 'metadata.numeroProcesso' } },
          { is_empty: { key: 'metadata.examId' } },
          { is_empty: { key: 'source' } },
        ],
      },
    });
    expect(chaveless).toBe(1);
  });

  it('scrollChunks pagina com cursor OPACO do Qdrant, narrow por filtro RAW, sem transferir vetor', async () => {
    const filter = { must: [{ key: 'metadata.tipo', match: { value: 'bula' } }] };
    const payloads: Record<string, unknown>[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await store.scrollChunks({
        filter,
        payloadKeys: ['id', 'text'],
        first: 1,
        ...(after !== undefined ? { after } : {}),
      });
      // Forward-only: o Qdrant não devolve token de volta, então a metade de trás é constante.
      expect(page.prevCursor).toBeNull();
      expect(page.hasPrev).toBe(false);
      expect(page.hasNext).toBe(page.nextCursor !== null);
      payloads.push(...page.items);
      after = page.nextCursor ?? undefined;
      pages += 1;
    } while (after !== undefined && pages < 10);

    expect(payloads.map((p) => String(p.id)).sort()).toEqual(['bula-P#0', 'bula-P#1']);
    expect(payloads[0]).not.toHaveProperty('embedding');
    // `first: 1` de verdade paginou contra o server vivo (não veio tudo de uma vez).
    expect(pages).toBeGreaterThan(1);
  });
});
