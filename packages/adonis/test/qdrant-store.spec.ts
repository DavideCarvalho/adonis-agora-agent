import { describe, expect, it } from 'vitest';
import type { QdrantClientLike } from '../src/rag/qdrant-store.js';
import {
  buildQdrantFilter,
  chunkIdToPointId,
  QdrantRetriever,
  QdrantStore,
} from '../src/rag/qdrant-store.js';
import { FakeEmbeddingProvider } from '../src/testing/index.js';

/** Shapes das respostas canned derivadas do próprio {@link QdrantClientLike} — assim o fake não
 *  pode divergir do contrato que ele implementa quando a interface mudar. */
type QdrantQueryResult = Awaited<ReturnType<QdrantClientLike['query']>>;
type QdrantScrollResult = Awaited<ReturnType<QdrantClientLike['scroll']>>;

/** Recording fake — captura toda chamada e devolve respostas canned. Prova que a
 *  store fala com o Qdrant do jeito certo SEM um Qdrant vivo (espelha RecordingDb). */
class RecordingQdrantClient implements QdrantClientLike {
  calls: { method: string; args: unknown[] }[] = [];
  collections: string[] = [];
  queryResult: QdrantQueryResult = { points: [] };
  scrollResult: QdrantScrollResult = { points: [] };
  /** Quando setado, sobrepõe `scrollResult` e decide a página a partir de `args.offset`
   *  — permite testar paginação multi-página (offset ausente → página 1, presente → página 2+). */
  scrollByOffset?: (args: { offset?: unknown }) => QdrantScrollResult;

  async getCollections() {
    this.calls.push({ method: 'getCollections', args: [] });
    return { collections: this.collections.map((name) => ({ name })) };
  }
  async createCollection(name: string, config: unknown) {
    this.calls.push({ method: 'createCollection', args: [name, config] });
    this.collections.push(name);
    return {};
  }
  async upsert(collection: string, args: unknown) {
    this.calls.push({ method: 'upsert', args: [collection, args] });
    return {};
  }
  async query(collection: string, args: unknown) {
    this.calls.push({ method: 'query', args: [collection, args] });
    return this.queryResult;
  }
  async delete(collection: string, args: unknown) {
    this.calls.push({ method: 'delete', args: [collection, args] });
    return {};
  }
  async scroll(collection: string, args: { offset?: unknown }) {
    this.calls.push({ method: 'scroll', args: [collection, args] });
    return this.scrollByOffset ? this.scrollByOffset(args) : this.scrollResult;
  }
  /** Resposta canned de `facet`; `facetFailures` faz as N próximas chamadas falharem antes dela. */
  facetResult: { hits: import('../src/rag/qdrant-store.js').FacetHit[] } = { hits: [] };
  facetFailures = 0;
  async facet(collection: string, args: unknown) {
    this.calls.push({ method: 'facet', args: [collection, args] });
    if (this.facetFailures > 0) {
      this.facetFailures--;
      throw new Error('Not found: field does not have a payload index');
    }
    return this.facetResult;
  }
  async createPayloadIndex(collection: string, args: unknown) {
    this.calls.push({ method: 'createPayloadIndex', args: [collection, args] });
    return {};
  }
  last(method: string) {
    const call = [...this.calls].reverse().find((c) => c.method === method);
    if (!call) throw new Error(`no ${method} recorded`);
    return call.args;
  }
}

describe('chunkIdToPointId', () => {
  it('é um UUID determinístico (mesmo id → mesmo UUID)', () => {
    const a = chunkIdToPointId('doc-1#3');
    const b = chunkIdToPointId('doc-1#3');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(chunkIdToPointId('doc-1#4')).not.toBe(a);
  });
});

describe('QdrantStore.ensureCollection', () => {
  it('cria a collection com dimensão e métrica quando ausente', async () => {
    const client = new RecordingQdrantClient();
    const store = new QdrantStore(client, { collection: 'rag', dimension: 8, metric: 'cosine' });
    await store.ensureCollection();
    const [name, config] = client.last('createCollection');
    expect(name).toBe('rag');
    expect(config).toEqual({ vectors: { size: 8, distance: 'Cosine' } });
  });

  it('é no-op quando a collection já existe', async () => {
    const client = new RecordingQdrantClient();
    client.collections = ['rag'];
    const store = new QdrantStore(client, { collection: 'rag', dimension: 8 });
    await store.ensureCollection();
    expect(client.calls.some((c) => c.method === 'createCollection')).toBe(false);
  });
});

describe('QdrantStore.upsert', () => {
  it('mapeia records para pontos com id UUIDv5, vetor e payload', async () => {
    const client = new RecordingQdrantClient();
    const store = new QdrantStore(client, { collection: 'rag', dimension: 3 });
    await store.upsert([
      {
        id: 'doc-1#0',
        text: 'olá',
        embedding: [0.1, 0.2, 0.3],
        source: 'Fonte A',
        metadata: { page: 2 },
      },
    ]);
    const [collection, args] = client.last('upsert') as [string, { points: any[] }];
    expect(collection).toBe('rag');
    const p = args.points[0];
    expect(p.id).toBe(chunkIdToPointId('doc-1#0'));
    expect(p.vector).toEqual([0.1, 0.2, 0.3]);
    expect(p.payload).toEqual({
      id: 'doc-1#0',
      documentId: 'doc-1',
      text: 'olá',
      source: 'Fonte A',
      metadata: { page: 2 },
    });
  });

  it('fatia records grandes em vários upserts (batch) preservando todos os pontos', async () => {
    const client = new RecordingQdrantClient();
    const store = new QdrantStore(client, { collection: 'rag', dimension: 1, upsertBatchSize: 2 });
    const records = Array.from({ length: 5 }, (_, i) => ({
      id: `doc-1#${i}`,
      text: `t${i}`,
      embedding: [i],
    }));
    await store.upsert(records);
    const upserts = client.calls.filter((c) => c.method === 'upsert');
    // 5 records, batch 2 → 3 requests (2 + 2 + 1)
    expect(upserts.length).toBe(3);
    const sizes = upserts.map((c) => (c.args[1] as { points: unknown[] }).points.length);
    expect(sizes).toEqual([2, 2, 1]);
    // nenhum lote excede o batch e todos os pontos aparecem exatamente uma vez
    expect(Math.max(...sizes)).toBeLessThanOrEqual(2);
    const ids = upserts.flatMap((c) =>
      (c.args[1] as { points: { id: string }[] }).points.map((p) => p.id),
    );
    expect(new Set(ids).size).toBe(5);
    expect(ids).toEqual(records.map((r) => chunkIdToPointId(r.id)));
  });

  it('faz um único upsert quando cabe no batch', async () => {
    const client = new RecordingQdrantClient();
    const store = new QdrantStore(client, {
      collection: 'rag',
      dimension: 1,
      upsertBatchSize: 100,
    });
    await store.upsert([
      { id: 'a#0', text: 'a', embedding: [1] },
      { id: 'a#1', text: 'b', embedding: [2] },
    ]);
    expect(client.calls.filter((c) => c.method === 'upsert').length).toBe(1);
  });
});

describe('buildQdrantFilter', () => {
  it('scalar → match value; array → match any; múltiplas chaves → must', () => {
    expect(buildQdrantFilter({ tenant: 't1', audience: ['public', 'role:ADMIN'] })).toEqual({
      must: [
        { key: 'metadata.tenant', match: { value: 't1' } },
        { key: 'metadata.audience', match: { any: ['public', 'role:ADMIN'] } },
      ],
    });
  });
  it('array vazio → condição que nega tudo', () => {
    // `match.except` com o próprio universo é impraticável; usamos `any: []`, que nunca casa.
    expect(buildQdrantFilter({ audience: [] })).toEqual({
      must: [{ key: 'metadata.audience', match: { any: [] } }],
    });
  });
  it('filtro vazio/ausente → undefined', () => {
    expect(buildQdrantFilter(undefined)).toBeUndefined();
    expect(buildQdrantFilter({})).toBeUndefined();
  });
});

describe('QdrantStore.search', () => {
  it('passa limit/score_threshold/filter e mapeia pontos para Passage (id do payload)', async () => {
    const client = new RecordingQdrantClient();
    client.queryResult = {
      points: [
        {
          score: 0.71,
          payload: {
            id: 'doc-1#2',
            documentId: 'doc-1',
            text: 'trecho',
            source: 'Fonte A',
            metadata: { page: 5 },
          },
        },
      ],
    };
    const store = new QdrantStore(client, { collection: 'rag', dimension: 3 });
    const passages = await store.search([0.1, 0.2, 0.3], {
      topK: 8,
      minScore: 0.4,
      filter: { tenant: 't1' },
    });

    const [collection, args] = client.last('query') as [string, any];
    expect(collection).toBe('rag');
    expect(args.query).toEqual([0.1, 0.2, 0.3]);
    expect(args.limit).toBe(8);
    expect(args.score_threshold).toBe(0.4);
    expect(args.with_payload).toBe(true);
    expect(args.filter).toEqual({ must: [{ key: 'metadata.tenant', match: { value: 't1' } }] });

    expect(passages).toEqual([
      { id: 'doc-1#2', text: 'trecho', score: 0.71, source: 'Fonte A', metadata: { page: 5 } },
    ]);
  });

  it('sem filtro/minScore não envia esses campos', async () => {
    const client = new RecordingQdrantClient();
    const store = new QdrantStore(client, { collection: 'rag', dimension: 3 });
    await store.search([0, 0, 0], { topK: 5 });
    const [, args] = client.last('query') as [string, any];
    expect('filter' in args).toBe(false);
    expect('score_threshold' in args).toBe(false);
    expect(args.limit).toBe(5);
  });

  it('metric l2: nega o score (distância → relevância) e nega o score_threshold enviado', async () => {
    const client = new RecordingQdrantClient();
    client.queryResult = {
      points: [{ score: 0.3, payload: { id: 'doc-1#0', text: 'trecho' } }],
    };
    const store = new QdrantStore(client, { collection: 'rag', dimension: 3, metric: 'l2' });
    const passages = await store.search([0.1, 0.2, 0.3], { topK: 5, minScore: 0.2 });

    const [, args] = client.last('query') as [string, any];
    expect(args.score_threshold).toBe(-0.2);
    expect(passages[0]?.score).toBe(-0.3);
  });

  it('metric cosine (default): score e score_threshold passam sem alteração', async () => {
    const client = new RecordingQdrantClient();
    client.queryResult = {
      points: [{ score: 0.71, payload: { id: 'doc-1#0', text: 'trecho' } }],
    };
    const store = new QdrantStore(client, { collection: 'rag', dimension: 3 });
    const passages = await store.search([0.1, 0.2, 0.3], { topK: 5, minScore: 0.4 });

    const [, args] = client.last('query') as [string, any];
    expect(args.score_threshold).toBe(0.4);
    expect(passages[0]?.score).toBe(0.71);
  });
});

describe('QdrantStore.remove', () => {
  it('deleta por filtro em documentId', async () => {
    const client = new RecordingQdrantClient();
    const store = new QdrantStore(client, { collection: 'rag', dimension: 3 });
    await store.remove('doc-1');
    const [collection, args] = client.last('delete') as [string, any];
    expect(collection).toBe('rag');
    expect(args.filter).toEqual({ must: [{ key: 'documentId', match: { value: 'doc-1' } }] });
  });
});

describe('QdrantStore.listDocuments', () => {
  it('faz scroll, dedupa por documentId e traz metadata representativo', async () => {
    const client = new RecordingQdrantClient();
    client.scrollResult = {
      points: [
        { payload: { documentId: 'doc-1', metadata: { title: 'A' } } },
        { payload: { documentId: 'doc-1', metadata: { title: 'A' } } },
        { payload: { documentId: 'doc-2', metadata: { title: 'B' } } },
      ],
      next_page_offset: undefined,
    };
    const store = new QdrantStore(client, { collection: 'rag', dimension: 3 });
    const docs = await store.listDocuments();
    expect(docs).toEqual([
      { id: 'doc-1', metadata: { title: 'A' } },
      { id: 'doc-2', metadata: { title: 'B' } },
    ]);
    const [, args] = client.last('scroll') as [string, any];
    expect(args.with_payload).toBe(true);
    expect(args.with_vector).toBe(false);
  });

  it('pagina de verdade: encadeia offset entre páginas e dedupa a união', async () => {
    const client = new RecordingQdrantClient();
    const cursor = { some: 'cursor' };
    client.scrollByOffset = (args) => {
      if (args.offset === undefined) {
        // página 1: doc-1 duplicado (deve dedupar), sinaliza que há mais.
        return {
          points: [
            { payload: { documentId: 'doc-1', metadata: { title: 'A' } } },
            { payload: { documentId: 'doc-1', metadata: { title: 'A' } } },
          ],
          next_page_offset: cursor,
        };
      }
      // página 2: só é servida se o offset da página 1 foi encaminhado de volta.
      expect(args.offset).toBe(cursor);
      return {
        points: [{ payload: { documentId: 'doc-2', metadata: { title: 'B' } } }],
        next_page_offset: undefined,
      };
    };
    const store = new QdrantStore(client, { collection: 'rag', dimension: 3 });
    const docs = await store.listDocuments();

    expect(docs).toEqual([
      { id: 'doc-1', metadata: { title: 'A' } },
      { id: 'doc-2', metadata: { title: 'B' } },
    ]);
    const scrollCalls = client.calls.filter((c) => c.method === 'scroll');
    expect(scrollCalls).toHaveLength(2);
    const [, secondArgs] = scrollCalls[1]!.args as [string, any];
    expect(secondArgs.offset).toBe(cursor);
  });
});

describe('QdrantRetriever', () => {
  it('embeda a query e busca na store (via client injetado)', async () => {
    const client = new RecordingQdrantClient();
    client.queryResult = {
      points: [
        {
          score: 0.9,
          payload: { id: 'd#0', documentId: 'd', text: 't', source: 'S', metadata: {} },
        },
      ],
    };
    const store = new QdrantStore(client, { collection: 'rag', dimension: 8 });
    const retriever = new QdrantRetriever(new FakeEmbeddingProvider(8), store);
    const passages = await retriever.retrieve('pergunta', { topK: 3, minScore: 0.5 });
    expect(passages).toHaveLength(1);
    const [, args] = client.last('query') as [string, any];
    expect(args.limit).toBe(3);
    expect(args.score_threshold).toBe(0.5);
  });
});

describe('QdrantStore.facetValues', () => {
  it('repassa campo, limit e o filtro RAW para o client e devolve os hits', async () => {
    const client = new RecordingQdrantClient();
    client.facetResult = {
      hits: [
        { value: 'proc-1', count: 3 },
        { value: 'proc-2', count: 1 },
      ],
    };
    const store = new QdrantStore(client, { collection: 'rag', dimension: 3 });
    const hits = await store.facetValues('metadata.numeroProcesso', {
      limit: 5000,
      filter: {
        must: [{ key: 'metadata.tipo', match: { value: 'bula' } }],
        must_not: [{ is_empty: { key: 'metadata.numeroProcesso' } }],
      },
    });
    expect(hits).toEqual([
      { value: 'proc-1', count: 3 },
      { value: 'proc-2', count: 1 },
    ]);
    const [, args] = client.last('facet') as [string, any];
    expect(args.key).toBe('metadata.numeroProcesso');
    expect(args.limit).toBe(5000);
    // contagem APROXIMADA é o default do server e o único padrão da store: `exact:
    // true` nela custa dezenas de segundos por facet num corpus de centenas de milhar
    // de pontos (o hang do painel em produção), então não é mais enviada.
    expect(args.exact).toBeUndefined();
    expect(args.filter.must_not).toEqual([{ is_empty: { key: 'metadata.numeroProcesso' } }]);
  });

  it('`exact: true` só via opt-in explícito', async () => {
    const client = new RecordingQdrantClient();
    const store = new QdrantStore(client, { collection: 'rag', dimension: 3 });
    await store.facetValues('metadata.tipo', { exact: true });
    const [, args] = client.last('facet') as [string, any];
    expect(args.exact).toBe(true);
  });

  it('default de limit é 200 sem filter no request', async () => {
    const client = new RecordingQdrantClient();
    const store = new QdrantStore(client, { collection: 'rag', dimension: 3 });
    await store.facetValues('source');
    const [, args] = client.last('facet') as [string, any];
    expect(args.limit).toBe(200);
    expect(args.filter).toBeUndefined();
  });

  it('no primeiro erro provisiona o índice keyword do campo e repete o facet uma vez', async () => {
    const client = new RecordingQdrantClient();
    client.facetFailures = 1;
    client.facetResult = { hits: [{ value: 'a', count: 2 }] };
    const store = new QdrantStore(client, { collection: 'rag', dimension: 3 });
    const hits = await store.facetValues('metadata.tipo');
    expect(hits).toEqual([{ value: 'a', count: 2 }]);
    const [collection, indexArgs] = client.last('createPayloadIndex') as [string, any];
    expect(collection).toBe('rag');
    expect(indexArgs).toEqual({
      field_name: 'metadata.tipo',
      field_schema: { type: 'keyword' },
      wait: true,
    });
    expect(client.calls.filter((c) => c.method === 'facet')).toHaveLength(2);
  });

  it('erro persistente propaga (sem retry infinito)', async () => {
    const client = new RecordingQdrantClient();
    client.facetFailures = 3;
    const store = new QdrantStore(client, { collection: 'rag', dimension: 3 });
    await expect(store.facetValues('metadata.tipo')).rejects.toThrow(/payload index/);
    expect(client.calls.filter((c) => c.method === 'facet')).toHaveLength(2);
  });

  it('client sem `facet` → erro nomeado', async () => {
    const client = new RecordingQdrantClient();
    (client as { facet?: unknown }).facet = undefined;
    const store = new QdrantStore(client, { collection: 'rag', dimension: 3 });
    await expect(store.facetValues('source')).rejects.toThrow(/requires a client with `facet`/);
  });
});

describe('QdrantStore.countChunks', () => {
  it('conta com o filtro RAW repassado e exact', async () => {
    class CountingClient extends RecordingQdrantClient {
      async count(_collection: string, args: unknown) {
        this.calls.push({ method: 'count', args: [_collection, args] });
        return { count: 7 };
      }
    }
    const client = new CountingClient();
    const store = new QdrantStore(client, { collection: 'rag', dimension: 3 });
    const n = await store.countChunks({ filter: { must: [{ is_empty: { key: 'source' } }] } });
    expect(n).toBe(7);
    const [, args] = client.last('count') as [string, any];
    // default aproximado (count exato varre os segmentos — o painel chama por grupo)
    expect(args.exact).toBeUndefined();
    expect(args.filter.must).toEqual([{ is_empty: { key: 'source' } }]);
  });
});

describe('QdrantStore.scrollChunks', () => {
  it('devolve payloads das páginas, sem vetor, com filtro e keys de payload repassados', async () => {
    const client = new RecordingQdrantClient();
    const cursor = 'p2';
    client.scrollByOffset = ({ offset }) => {
      if (offset === undefined) {
        return {
          points: [{ payload: { id: 'a#0', text: 'A' } }],
          next_page_offset: cursor,
        };
      }
      return { points: [{ payload: { id: 'a#1', text: 'B' } }] };
    };
    const store = new QdrantStore(client, { collection: 'rag', dimension: 3 });
    const payloads = await store.scrollChunks({
      filter: { should: [{ is_empty: { key: 'metadata.tipo' } }] },
      payloadKeys: ['id', 'text'],
      pageSize: 1,
    });
    expect(payloads).toEqual([
      { id: 'a#0', text: 'A' },
      { id: 'a#1', text: 'B' },
    ]);
    const scrollCalls = client.calls.filter((c) => c.method === 'scroll');
    expect(scrollCalls).toHaveLength(2);
    const [, firstArgs] = scrollCalls[0]!.args as [string, any];
    expect(firstArgs.with_vector).toBe(false);
    expect(firstArgs.with_payload).toEqual(['id', 'text']);
    expect(firstArgs.filter.should).toEqual([{ is_empty: { key: 'metadata.tipo' } }]);
  });

  it('guarda maxPages contra cursor infinito', async () => {
    const client = new RecordingQdrantClient();
    client.scrollByOffset = () => ({
      points: [{ payload: { id: 'x' } }],
      next_page_offset: 'sempre',
    });
    const store = new QdrantStore(client, { collection: 'rag', dimension: 3 });
    await expect(store.scrollChunks({ maxPages: 3 })).rejects.toThrow(/maxPages/);
  });
});
