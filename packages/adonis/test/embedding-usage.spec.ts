import { describe, expect, it } from 'vitest';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  type EmbeddingProvider,
  embedCountingUsage,
  ingestChunks,
  type Passage,
  type RetrievalResult,
  type Retriever,
  runAgentLoop,
  ToolRegistry,
} from '../src/index.js';
import { MemoryVectorStore } from '../src/rag/memory-vector-store.js';
import {
  FakeEmbeddingProvider,
  FakeModelProvider,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
  inMemoryRetriever,
} from '../src/testing/index.js';

/**
 * Embedding É gasto, e por muito tempo foi o único que este pacote não conseguia enxergar:
 * `embed` devolvia só vetores, então nada de RAG chegava ao ledger — nem à COTA, que soma o
 * ledger inteiro. Um agente com retrieval em modo inject gastava tokens em TODA pergunta e o
 * painel jurava que não, o que é pior do que não medir: é medir errado para baixo, justamente na
 * conta que decide quando barrar alguém.
 *
 * O que estes testes prendem é o caminho inteiro — do provider até a linha do ledger — e, com o
 * mesmo peso, que um retriever ou provider ANTIGO (sem a capacidade nova) continua funcionando.
 */
async function runWithRetriever(retriever: Retriever) {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({
    actor: { id: 'u1', roles: ['ADMIN'] },
    persona: 'default',
  });
  const deps: AgentLoopDeps = {
    model: new FakeModelProvider(() => ({ text: 'ok' })),
    store,
    registry: new ToolRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'You are a test agent.',
    retriever,
  };
  const hooks: AgentLoopHooks = {
    runId: 'run-1',
    openSink: () => sink.open('run-1'),
    awaitApproval: async () => ({ approved: true }),
    step: (_name, fn) => fn(),
  };
  await runAgentLoop(
    deps,
    { threadId: thread.id, actor: { id: 'u1', roles: ['ADMIN'] }, userText: 'qual e a regra' },
    hooks,
  );
  return store;
}

/** Um retriever escrito ANTES desta capacidade: só `retrieve`, sem `retrieveWithUsage`. */
class LegacyRetriever implements Retriever {
  async retrieve(): Promise<Passage[]> {
    return [{ id: 'p1', text: 'uma passagem', score: 1 }];
  }
}

/** Um provider escrito ANTES desta capacidade: só `embed`. */
class LegacyEmbedder implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0]);
  }
}

describe('gasto de embedding no retrieval', () => {
  it('grava uma linha de ledger com purpose `embedding`', async () => {
    const retriever = await inMemoryRetriever({
      documents: [{ id: 'd1', text: 'a regra do orientando e entregar no prazo' }],
    });
    const store = await runWithRetriever(retriever);

    const embeddingRows = store.usageRows().filter((row) => row.purpose === 'embedding');
    expect(embeddingRows).toHaveLength(1);
    expect(embeddingRows[0]?.tokens).toBeGreaterThan(0);
    expect(embeddingRows[0]?.modelId).toBe('fake-embedding');
  });

  it('o gasto de embedding CONTA para a cota do dia', async () => {
    // É o ponto: a cota soma o ledger sem filtrar propósito, então registrar aqui é o que faz o
    // RAG passar a pesar no teto diário. Antes, não pesava nada.
    const retriever = await inMemoryRetriever({
      documents: [{ id: 'd1', text: 'a regra do orientando e entregar no prazo' }],
    });
    const store = await runWithRetriever(retriever);

    // O dia vem do timestamp REAL da linha (o dublê usa `createdAt`, e o store Lucid uma janela
    // sobre `created_at`), não do `deps.day` do loop — então a cota se consulta pelo dia de hoje.
    const today = new Date().toISOString().slice(0, 10);
    const { usedTokens } = await store.quotaToday('u1', today);
    const embeddingTokens = store
      .usageRows()
      .filter((row) => row.purpose === 'embedding')
      .reduce((total, row) => total + row.tokens, 0);

    expect(embeddingTokens).toBeGreaterThan(0);
    expect(usedTokens).toBeGreaterThanOrEqual(embeddingTokens);
  });

  it('a linha de chat continua existindo, separada da de embedding', async () => {
    // O embedding não pode SUBSTITUIR a contabilidade do turno; ele soma.
    const retriever = await inMemoryRetriever({
      documents: [{ id: 'd1', text: 'a regra do orientando' }],
    });
    const store = await runWithRetriever(retriever);

    const purposes = store.usageRows().map((row) => row.purpose);
    expect(purposes).toContain('chat');
    expect(purposes).toContain('embedding');
  });

  it('retriever ANTIGO (sem retrieveWithUsage) segue funcionando, sem linha de embedding', async () => {
    const store = await runWithRetriever(new LegacyRetriever());

    const rows = store.usageRows();
    expect(rows.filter((row) => row.purpose === 'embedding')).toHaveLength(0);
    // E o turno foi contabilizado normalmente.
    expect(rows.filter((row) => row.purpose === 'chat').length).toBeGreaterThan(0);
  });

  it('provider que não reporta consumo não inventa número', async () => {
    const retriever = await inMemoryRetriever({
      documents: [{ id: 'd1', text: 'texto' }],
      embedder: new FakeEmbeddingProvider(64, false),
    });
    const store = await runWithRetriever(retriever);

    expect(store.usageRows().filter((row) => row.purpose === 'embedding')).toHaveLength(0);
  });
});

describe('embedCountingUsage', () => {
  it('usa embedWithUsage quando existe', async () => {
    const result = await embedCountingUsage(new FakeEmbeddingProvider(), ['duas palavras']);
    expect(result.vectors).toHaveLength(1);
    expect(result.usage?.inputTokens).toBe(2);
  });

  it('cai para embed quando o provider é antigo, e devolve usage indefinido', async () => {
    const result = await embedCountingUsage(new LegacyEmbedder(), ['qualquer coisa']);
    expect(result.vectors).toEqual([[1, 0, 0]]);
    expect(result.usage).toBeUndefined();
  });
});

describe('gasto de embedding na ingestão', () => {
  it('reporta o consumo do lote pelo callback', async () => {
    // Ingestão não acontece dentro de thread nenhuma, e `agent_token_usage.thread_id` é NOT NULL
    // com FK — então aqui o gasto é OBSERVÁVEL, não gravado. Melhor que invisível, que era o caso.
    const seen: number[] = [];
    await ingestChunks(
      [
        { id: 'c1', text: 'primeira parte do texto' },
        { id: 'c2', text: 'segunda parte' },
      ],
      {
        embedder: new FakeEmbeddingProvider(),
        store: new MemoryVectorStore(),
        onUsage: (usage) => {
          seen.push(usage.inputTokens);
        },
      },
    );

    expect(seen).toHaveLength(1); // um lote, uma chamada
    expect(seen[0]).toBe(6); // 4 palavras + 2 palavras
  });

  it('sem callback, ingere igual — a capacidade é opcional', async () => {
    const count = await ingestChunks([{ id: 'c1', text: 'texto' }], {
      embedder: new FakeEmbeddingProvider(),
      store: new MemoryVectorStore(),
    });
    expect(count).toBe(1);
  });
});

describe('EmbeddingRetriever.retrieveWithUsage', () => {
  it('devolve o consumo mesmo quando não acha passagem nenhuma', async () => {
    // A consulta foi embedada de qualquer jeito. "Não achou" e "não custou" são fatos diferentes.
    const retriever = await inMemoryRetriever({ documents: [] });
    const result: RetrievalResult = await retriever.retrieveWithUsage('pergunta sem corpus');

    expect(result.passages).toEqual([]);
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
  });
});
