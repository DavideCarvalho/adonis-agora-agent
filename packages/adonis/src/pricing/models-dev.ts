import type { AgentPricingStore, ModelPriceInput } from '../spi/pricing-store.js';

/** O endereço do catálogo. Aberto, sem chave, JSON único. */
export const MODELS_DEV_URL = 'https://models.dev/api.json';

/** O recorte do catálogo que nos interessa. Tudo o mais é ignorado de propósito. */
interface ModelsDevCatalog {
  [provider: string]: {
    models?: {
      [model: string]: {
        cost?: {
          input?: number;
          output?: number;
          cache_read?: number;
          cache_write?: number;
        };
      };
    };
  };
}

export interface ModelsDevOptions {
  /** Sobrescreve a URL do catálogo (um espelho interno, um arquivo em disco servido por você). */
  url?: string;
  /** `fetch` alternativo. Existe para os testes não irem à rede, e para quem precisa de proxy. */
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

/** Um modelo no catálogo: `'<provider>/<model>'`, por exemplo `'openai/gpt-4o-mini'`. */
export type ModelsDevRef = string;

function parseRef(ref: ModelsDevRef): { provider: string; model: string } {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(
      `models.dev: "${ref}" não tem a forma "<provider>/<model>" (ex.: "openai/gpt-4o-mini"). ` +
        'O provider é obrigatório porque o mesmo nome de modelo existe em provedores diferentes, ' +
        'com preços diferentes — adivinhar aqui seria adivinhar uma conta.',
    );
  }
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

/**
 * Busca no [models.dev](https://models.dev) os preços dos modelos pedidos.
 *
 * Existe porque a alternativa é alguém copiar números de uma tabela de preços para dentro de um
 * seeder à mão. Um preço errado ali não quebra nada e não avisa: ele produz uma conta errada no
 * dashboard, que é pior do que conta nenhuma — quem lê acredita.
 *
 * O que ele devolve são `ModelPriceInput` prontos para o `upsertModelPrice`, chaveados pelo NOME
 * DO MODELO (`gpt-4o-mini`), não pelo `provider/model` pedido. É de propósito: é assim que os
 * provedores publicam o preço, e a resolução do fold (ver `resolveModelPrice`) já sabe chegar do
 * snapshot datado que o provider reporta até esse alias.
 *
 * FALHA ALTO. Um modelo pedido que não existe no catálogo, ou existe sem preço, vira erro — e não
 * uma linha faltando em silêncio, que reapareceria depois como `$0.00` num painel.
 */
async function loadCatalog(options: ModelsDevOptions): Promise<ModelsDevCatalog> {
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('models.dev: nenhum `fetch` disponível — passe `options.fetch`.');
  }
  const url = options.url ?? MODELS_DEV_URL;
  const response = await doFetch(url, options.signal ? { signal: options.signal } : {});
  if (!response.ok) {
    throw new Error(`models.dev: ${url} respondeu ${response.status}`);
  }
  return (await response.json()) as ModelsDevCatalog;
}

/** The price row a catalog entry yields, keyed by the model name — or `undefined` when it has none. */
function priceOf(catalog: ModelsDevCatalog, ref: ModelsDevRef): ModelPriceInput | undefined {
  const { provider, model } = parseRef(ref);
  const cost = catalog[provider]?.models?.[model]?.cost;
  if (cost === undefined || typeof cost.input !== 'number' || typeof cost.output !== 'number') {
    return undefined;
  }
  return {
    modelId: model,
    inputPricePer1m: cost.input,
    outputPricePer1m: cost.output,
    ...(typeof cost.cache_write === 'number' ? { cacheWritePricePer1m: cost.cache_write } : {}),
    ...(typeof cost.cache_read === 'number' ? { cacheReadPricePer1m: cost.cache_read } : {}),
  };
}

/** The result of a lenient lookup: what the catalog priced, and what it did not. */
export interface ModelsDevLookup {
  prices: ModelPriceInput[];
  /** Refs with no entry, or an entry without an input/output price. */
  missing: ModelsDevRef[];
}

/**
 * The lenient twin of {@link fetchModelsDevPrices}, for boot-time seeding: a model the catalog does
 * not price is reported in `missing` instead of failing the whole batch, so one unknown model does
 * not leave every other one unpriced. Throws only when the catalog itself cannot be read.
 *
 * Each ref is a LIST of candidates, tried in order — the first one the catalog prices wins.
 */
export async function lookupModelsDevPrices(
  refs: readonly (readonly ModelsDevRef[])[],
  options: ModelsDevOptions = {},
): Promise<ModelsDevLookup> {
  if (refs.length === 0) return { prices: [], missing: [] };
  const catalog = await loadCatalog(options);
  const prices: ModelPriceInput[] = [];
  const missing: ModelsDevRef[] = [];
  for (const candidates of refs) {
    const price = candidates.map((ref) => priceOf(catalog, ref)).find((p) => p !== undefined);
    if (price !== undefined) prices.push(price);
    else if (candidates[0] !== undefined) missing.push(candidates[0]);
  }
  return { prices, missing };
}

/**
 * The models.dev refs to try for a model, most specific first: `<provider>/<modelId>`, then — for an
 * OpenRouter-style id (`deepseek/deepseek-v4.1-flash`) reached through another SDK — the OpenRouter
 * list price. `provider` is the AI SDK provider family (`openrouter`, `openai`, `vercel`, …).
 */
export function modelsDevRefsFor(modelId: string, provider: string | undefined): ModelsDevRef[] {
  const refs: ModelsDevRef[] = [];
  if (provider !== undefined && provider.length > 0) refs.push(`${provider}/${modelId}`);
  // A gateway id names its own provider (`openai/gpt-4o-mini` through the Vercel AI Gateway).
  if (provider === 'vercel' && modelId.includes('/')) refs.push(modelId);
  if (modelId.includes('/') && provider !== 'openrouter') refs.push(`openrouter/${modelId}`);
  return refs;
}

export async function fetchModelsDevPrices(
  models: readonly ModelsDevRef[],
  options: ModelsDevOptions = {},
): Promise<ModelPriceInput[]> {
  if (models.length === 0) return [];

  const catalog = await loadCatalog(options);

  const prices: ModelPriceInput[] = [];
  for (const ref of models) {
    const { provider, model } = parseRef(ref);
    if (catalog[provider]?.models?.[model] === undefined) {
      throw new Error(`models.dev: não achei "${model}" em "${provider}".`);
    }
    const price = priceOf(catalog, ref);
    if (price === undefined) {
      throw new Error(
        `models.dev: "${ref}" existe no catálogo mas não publica preço de input/output.`,
      );
    }
    prices.push(price);
  }
  return prices;
}

/**
 * Busca no models.dev e grava no store. O atalho de uma linha para um comando de seed.
 *
 * Deliberadamente NÃO tem retry, cache nem modo silencioso: isto é para rodar num comando de
 * operador (ou num passo de deploy), onde uma falha deve aparecer e parar, e não para rodar no
 * caminho de uma request. Preço é dado que muda de mês em mês, não de segundo em segundo — buscar
 * na hora de cobrar seria trocar uma tabela que você controla por uma dependência de rede de
 * terceiro no meio da sua contabilidade.
 */
export async function seedPricesFromModelsDev(
  store: AgentPricingStore,
  models: readonly ModelsDevRef[],
  options: ModelsDevOptions = {},
): Promise<ModelPriceInput[]> {
  const prices = await fetchModelsDevPrices(models, options);
  for (const price of prices) {
    await store.upsertModelPrice(price);
  }
  return prices;
}
