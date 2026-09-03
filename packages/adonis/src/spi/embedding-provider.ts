/**
 * Turns text into embedding vectors — the retrieval-side sibling of {@link import('./model-provider.js').ModelProvider}.
 * Batched (`texts` → one vector each, in the same order) so ingestion can embed many chunks per call.
 * An adapter implements it (`aiSdkEmbedding` over the Vercel AI SDK `embedMany`, deferred this round);
 * `@adonis-agora/agent/testing` ships a deterministic {@link import('../testing/fake-embedding-provider.js').FakeEmbeddingProvider}
 * for offline tests. Mirrors the reference `EmbeddingProvider` contract exactly.
 */
export interface EmbeddingProvider {
  /** Embed each input string; returns one vector per input, in the same order. */
  embed(texts: string[]): Promise<number[][]>;
  /**
   * Same as {@link EmbeddingProvider.embed}, plus what it consumed. OPTIONAL — a provider that
   * cannot report token counts simply omits it, and the caller falls back to `embed`.
   *
   * Existe porque embedding É gasto, e por muito tempo ele foi o único gasto que este pacote não
   * conseguia enxergar: `embed` devolvia só vetores, então nada de RAG chegava ao ledger nem à
   * cota. Um agente com retrieval ligado gastava tokens em toda pergunta e o painel jurava que
   * não. Ver `docs/governance/quota-and-cost.mdx`.
   */
  embedWithUsage?(texts: string[]): Promise<EmbeddingResult>;
}

/** What one `embed` call consumed. Embeddings têm só lado de entrada — não existe output. */
export interface EmbeddingUsage {
  /** Tokens de entrada consumidos pela chamada inteira (o lote todo, não por texto). */
  inputTokens: number;
  /**
   * O modelo que o provider REPORTOU (`text-embedding-3-small`). Sem ele o custo não tem como ser
   * estimado, então vale mandar sempre que o provider disser.
   */
  modelId?: string;
}

/** Vetores mais, quando o provider sabe dizer, o que eles custaram. */
export interface EmbeddingResult {
  vectors: number[][];
  usage?: EmbeddingUsage;
}

/**
 * Chama `embedWithUsage` quando o provider tem, senão cai para `embed`.
 *
 * O ponto único onde essa escolha é feita. Sem ele, cada chamador repetiria o `typeof
 * provider.embedWithUsage === 'function'`, e o primeiro que esquecesse voltaria a perder o
 * consumo em silêncio — que é exatamente o modo de falha que esta capacidade existe para fechar.
 */
export async function embedCountingUsage(
  provider: EmbeddingProvider,
  texts: string[],
): Promise<EmbeddingResult> {
  if (typeof provider.embedWithUsage === 'function') {
    return provider.embedWithUsage(texts);
  }
  return { vectors: await provider.embed(texts) };
}
