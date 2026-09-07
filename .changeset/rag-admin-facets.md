---
'@adonis-agora/agent': minor
---

Painéis de inspeção do RAG ganham agregação server-side: `facetValues`, `countChunks` e `scrollChunks` no `QdrantStore`

Quem constrói um admin sobre a coleção (`quantos chunks por documento? por tipo? quais chunks deste documento?`) esbarrava num muro: a store só sabia `search` (vetor) e `listDocuments` (colapsado por `documentId`). A alternativa honesta era um scroll da coleção inteira por request — em corpus de dezenas de milhares de pontos isso não é uma listagem, é um hang (foi exatamente o que um painel em produção fez: centenas de round-trips sequenciais de scroll e o browser girando para sempre).

**O que entra:**

- O filtro estrutural cresce para a linguagem que o GROUP BY de cadeia de prioridade precisa: `QdrantCondition` vira união com `is_empty` (campo AUSENTE/null/empty — os buckets de fallback), `QdrantFilter` ganha `must_not` (com `is_empty`, "campo PRESENTE") e `should` (OR — o fallback que é ausente OU o literal).
- `facetValues(field, {filter?, limit?})` — o `POST /facet` do Qdrant: GROUP BY + contagem exata por valor, uma ida de rede. Qdrant exige índice de payload no campo; no primeiro erro o store PROVISIONA o índice `keyword` e repete o facet exatamente uma vez — a primeira chamada numa coleção nova paga o índice, as demais são facet puro. Sem `facet` no client injetado, o erro diz isso nominalmente; sem `createPayloadIndex`, o erro original do server propaga (nada de degradação silenciosa).
- `countChunks({filter?})` — o agregado por trás de linhas como "chunks sem chave nenhuma", sem enumeration.
- `scrollChunks({filter?, payloadKeys?, pageSize?, maxPages?})` — pagina os CHUNKS com o mesmo filtro raw do facet, vetor nunca atravessa o fio. Diferente de `listDocuments`: é por chunk e fala o filtro cru — existe para inspeção/deleção, onde o chamador conhece o payload que ele mesmo gravou.
- `delete` no shim aceita `points` (lista de ids de ponto), como o client real já aceita — apagar "o que a agregação contou" sem reapresentar filtro.

**Não-quebrante por construção:** nada disso toca o `VectorStore` SPI — são capacidades concretas do `QdrantStore` (como `ensureCollection`), e os dois métodos novos do client shim são `OPTIONAL` (o mesmo padrão de `setPayload?`/`count?`), então host com client escrito à mão continua compilando.

**Validado contra Qdrant vivo** (`rag-qdrant-live.spec.ts`, gate `AGENT_QDRANT_URL`): o auto-provisionamento do índice acontece de verdade no server, `is_empty` cobre ausente e null, `must_not: [is_empty]` é presença, e o facet com `filter` honra a prioridade da cadeia (chunk com `numeroProcesso` E `examId` só conta no primeiro). O fake grava as chamadas e cobre as paths de erro (client sem capacidade, erro persistente sem retry infinito, cursor com `maxPages`).
