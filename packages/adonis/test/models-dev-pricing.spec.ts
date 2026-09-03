import { describe, expect, it, vi } from 'vitest';
import { fetchModelsDevPrices, seedPricesFromModelsDev } from '../src/pricing/models-dev.js';
import { InMemoryPricingStore } from '../src/testing/in-memory-pricing.js';

/**
 * O formato aqui é o do catálogo REAL (conferido contra `https://models.dev/api.json`): provider →
 * `models` → id → `cost.{input,output,cache_read}`, em USD por 1M de tokens. Se a fixture divergisse
 * do catálogo, estes testes passariam contra uma forma que não existe — que é o modo de falha de
 * qualquer teste que dubla um terceiro.
 */
const CATALOG = {
  openai: {
    models: {
      'gpt-4o-mini': { cost: { input: 0.15, output: 0.6, cache_read: 0.075 } },
      'text-embedding-3-small': { cost: { input: 0.02, output: 0 } },
      'sem-preco': {},
    },
  },
  anthropic: {
    models: {
      // Mesmo NOME em outro provider, com outro preço — o caso que torna o prefixo obrigatório.
      'gpt-4o-mini': { cost: { input: 99, output: 99 } },
    },
  },
};

function fakeFetch(body: unknown = CATALOG, init: { ok?: boolean; status?: number } = {}) {
  return vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  })) as unknown as typeof globalThis.fetch;
}

describe('fetchModelsDevPrices', () => {
  it('traz input, output e cache_read do catálogo', async () => {
    const [price] = await fetchModelsDevPrices(['openai/gpt-4o-mini'], { fetch: fakeFetch() });
    expect(price).toEqual({
      modelId: 'gpt-4o-mini',
      inputPricePer1m: 0.15,
      outputPricePer1m: 0.6,
      cacheReadPricePer1m: 0.075,
    });
  });

  it('chaveia pelo NOME do modelo, sem o provider — é o alias que o fold resolve', async () => {
    const [price] = await fetchModelsDevPrices(['openai/gpt-4o-mini'], { fetch: fakeFetch() });
    expect(price?.modelId).toBe('gpt-4o-mini');
  });

  it('o provider decide o preço quando o nome se repete', async () => {
    const [anthropic] = await fetchModelsDevPrices(['anthropic/gpt-4o-mini'], {
      fetch: fakeFetch(),
    });
    expect(anthropic?.inputPricePer1m).toBe(99);
  });

  it('exige o prefixo do provider em vez de adivinhar', async () => {
    await expect(fetchModelsDevPrices(['gpt-4o-mini'], { fetch: fakeFetch() })).rejects.toThrow(
      /provider/,
    );
  });

  it('modelo ausente do catálogo é ERRO, não linha faltando', async () => {
    // Uma linha faltando reapareceria depois como `$0.00` num painel, longe da causa.
    await expect(
      fetchModelsDevPrices(['openai/nao-existe'], { fetch: fakeFetch() }),
    ).rejects.toThrow(/não achei/);
  });

  it('modelo sem preço publicado é ERRO', async () => {
    await expect(
      fetchModelsDevPrices(['openai/sem-preco'], { fetch: fakeFetch() }),
    ).rejects.toThrow(/não publica preço/);
  });

  it('resposta HTTP ruim é ERRO', async () => {
    await expect(
      fetchModelsDevPrices(['openai/gpt-4o-mini'], {
        fetch: fakeFetch({}, { ok: false, status: 503 }),
      }),
    ).rejects.toThrow(/503/);
  });

  it('lista vazia não vai à rede', async () => {
    const fetchSpy = fakeFetch();
    expect(await fetchModelsDevPrices([], { fetch: fetchSpy })).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('cobre embeddings, que também têm preço no catálogo', async () => {
    const [price] = await fetchModelsDevPrices(['openai/text-embedding-3-small'], {
      fetch: fakeFetch(),
    });
    expect(price?.inputPricePer1m).toBe(0.02);
  });

  it('busca o catálogo UMA vez para a lista inteira', async () => {
    const fetchSpy = fakeFetch();
    await fetchModelsDevPrices(['openai/gpt-4o-mini', 'anthropic/gpt-4o-mini'], {
      fetch: fetchSpy,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('seedPricesFromModelsDev', () => {
  it('grava no store e o preço volta legível', async () => {
    const store = new InMemoryPricingStore();
    await seedPricesFromModelsDev(store, ['openai/gpt-4o-mini'], { fetch: fakeFetch() });

    const current = await store.listCurrentPrices();
    expect(current).toHaveLength(1);
    expect(current[0]?.modelId).toBe('gpt-4o-mini');
    expect(current[0]?.inputPricePer1m).toBe(0.15);
  });

  it('é idempotente — semear de novo deixa UM preço corrente', async () => {
    const store = new InMemoryPricingStore();
    await seedPricesFromModelsDev(store, ['openai/gpt-4o-mini'], { fetch: fakeFetch() });
    await seedPricesFromModelsDev(store, ['openai/gpt-4o-mini'], { fetch: fakeFetch() });

    expect(await store.listCurrentPrices()).toHaveLength(1);
  });

  it('não grava nada quando o catálogo não tem um dos modelos', async () => {
    // Tudo-ou-nada: um seed parcial deixaria metade da conta certa e metade zerada, que é o
    // estado mais difícil de perceber.
    const store = new InMemoryPricingStore();
    await expect(
      seedPricesFromModelsDev(store, ['openai/gpt-4o-mini', 'openai/nao-existe'], {
        fetch: fakeFetch(),
      }),
    ).rejects.toThrow();
    expect(await store.listCurrentPrices()).toHaveLength(0);
  });
});
