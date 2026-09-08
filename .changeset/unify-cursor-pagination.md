---
'@adonis-agora/agent': minor
'@adonis-agora/agent-dashboard': minor
---

**BREAKING** — pagination agora fala a MESMA interface de cursor de `@adonis-agora/filter`, em todo o ecossistema Agora

Cada `@adonis-agora/*` paginava do seu jeito. Agora todos falam o `CursorParams`/`CursorPage` do
`@adonis-agora/filter`: `{ after?, first? }` entra, `{ items, nextCursor, prevCursor, hasNext, hasPrev }`
sai. Um consumidor que aprende a paginar uma lib paginou todas.

Os tipos vivem em `@adonis-agora/agent` (`CursorPage`, `CursorParams`, exportados da raiz) e espelham os do
`@adonis-agora/filter` **estruturalmente** — sem dependência entre os pacotes, por convenção do
ecossistema. O `-dashboard` carrega a mesma declaração no seu `client/types.ts`, como já fazia com todas as
outras wire shapes.

**Forward-only, e isso está no tipo.** Os dois backends aqui só sabem avançar — o `scroll` do Qdrant
devolve um `next_page_offset` opaco e nenhum token de volta, e o read-model de runs pagina com um cursor
opaco pra frente. Então `CursorParams` NÃO tem `before`/`last` (um parâmetro que compila e não faz nada é
pior que um que não existe), e todo `CursorPage` daqui sai com `prevCursor: null` / `hasPrev: false`. Esses
dois campos ficam porque o ponto é ser a MESMA forma do `@adonis-agora/filter`: quem escreveu contra um
renderiza o outro sem condicional, e uma superfície que ganhar paginação pra trás preenche os campos sem
quebrar ninguém. São constantes, não bug.

Como é 0.x, o breaking sai como **minor** (convenção semver de 0.x).

### 1. `QdrantStore.scrollChunks` — uma PÁGINA por chamada, não a coleção inteira

`scrollChunks` drenava o cursor até o fim e devolvia um array. Agora é uma superfície paginada de verdade:
uma ida de rede, `first` é o `limit` do scroll, `nextCursor` embrulha o `next_page_offset` do Qdrant em
base64url — **opaco**, justamente pra ninguém passar a depender de ele ser um id de ponto. Devolver esse
cursor adulterado agora falha com erro nomeado em vez de rebobinar em silêncio pra primeira página (um
scroll que rebobina reprocessa chunks que um painel de deleção já tratou).

`pageSize` virou `first` (mesmo default, 256) e `maxPages` sumiu: com uma página por chamada, o teto de
páginas é o laço de quem chama. O `MAX_SCROLL_PAGES` interno segue guardando os scrolls que a store ainda
drena sozinha (`listDocuments`, `listDocumentIds`, `updateMetadata`).

```ts
// antes — drenava tudo, guardado por maxPages
const payloads = await store.scrollChunks({ filter, payloadKeys: ['id'], pageSize: 256 });

// depois — uma página; drenar é um laço seu sobre nextCursor
const page = await store.scrollChunks({ filter, payloadKeys: ['id'], first: 256 });
page.items; // Record<string, unknown>[]

const all: Record<string, unknown>[] = [];
let after: string | undefined;
do {
  const p = await store.scrollChunks({ filter, ...(after ? { after } : {}) });
  all.push(...p.items);
  after = p.nextCursor ?? undefined;
} while (after !== undefined);
```

`facetValues(field, { limit })` virou `facetValues(field, { first })` — mesmo default (200), só o nome do
tamanho de página alinhado ao `CursorParams`. Ele **não** virou `CursorPage`, de propósito: o endpoint
`/facet` do Qdrant devolve os top-`first` valores de uma vez e não emite token de continuação nenhum, então
um envelope de página aqui anunciaria um `nextCursor` que só poderia ser `null` pra sempre. Facet é
agregado com teto; `scrollChunks` é a superfície paginada. `countChunks` (um número) segue igual.

`PgVectorStore`/`MemoryVectorStore` não precisaram mudar: `scrollChunks`/`facetValues`/`countChunks` são
capacidades do Qdrant, não estão na interface `VectorStore` que as três stores implementam, então não há
como as duas formas divergirem.

### 2. `AgentGovernanceQueries.listRuns` — mesmos cursores, nomes do ecossistema

Já era baseado em cursor, só com nomes próprios. `ListRunsResult` agora é literalmente
`CursorPage<RunSummaryRow>`: as linhas saem em **`items`** (não `runs`), com `prevCursor`/`hasPrev`
constantes.

```ts
// antes
const page = await gov.listRuns({ status: 'failed', limit: 50, cursor: prev });
page.runs;
page.nextCursor;

// depois
const page = await gov.listRuns({ status: 'failed', first: 50, after: prev });
page.items;
page.nextCursor; // + prevCursor: null, hasNext, hasPrev: false
```

Quem implementa `AgentGovernanceQueries` por fora precisa renomear `runs` → `items` e devolver os três
campos novos. As duas implementações que este pacote traz (`LucidGovernanceQueries` e a
`InMemoryGovernanceQueries` de teste) já vieram atualizadas.

**Rota HTTP** — `GET /agent/governance/runs` troca a query string e o corpo:

```diff
- GET /agent/governance/runs?limit=50&cursor=<opaco>
- { "runs": [...], "nextCursor": "<opaco>" }
+ GET /agent/governance/runs?first=50&after=<opaco>
+ { "items": [...], "nextCursor": "<opaco>", "prevCursor": null, "hasNext": true, "hasPrev": false }
```

O `?limit=` continua existindo — só nas listas com TETO, que não são paginadas por cursor
(`recentToolCalls`, `recentThreads`, a caixa de aprovações). A regra é essa: superfície com cursor fala
`after`/`first`; top-N com teto fala `limit`.

**Cliente do console** — `AgentClient.listRuns({ cursor, limit })` virou `listRuns({ after, first })` e
devolve `CursorPage`. O provider do Telescope (`agent.runs.recent`) e o hook `useRuns` da SPA já
acompanham; a UI do console não muda.
