---
'@adonis-agora/agent': minor
---

O gasto de embedding (RAG) passa a chegar ao ledger e à cota

Era o único gasto que este pacote não conseguia enxergar. `EmbeddingProvider.embed` devolvia só vetores — sem contagem de tokens, sem `recordUsage` —, então nada de RAG chegava ao ledger. E como a cota diária SOMA o ledger sem filtrar propósito, também não chegava à cota.

O efeito prático: um agente com retrieval em modo inject embeda a pergunta do usuário em TODA pergunta, gastando tokens que o painel jurava não existir. Isso é pior do que não medir — é medir para baixo, justamente na conta que decide quando barrar alguém.

Agora o loop grava uma linha com `purpose: 'embedding'` para o embedding da consulta, dentro de um `hooks.step` (uma retomada durable não pode cobrar duas vezes pelo mesmo embedding).

**A capacidade é OPCIONAL nos dois níveis, e isso é o que mantém a mudança não-quebrante:**

- `EmbeddingProvider` ganha `embedWithUsage?`, ao lado do `embed` de sempre;
- `Retriever` ganha `retrieveWithUsage?`, que o loop prefere quando existe.

Um provider ou retriever escrito antes disto continua funcionando sem mudar uma linha — simplesmente não produz linha de embedding. O runtime NUNCA inventa uma contagem que não recebeu, pelo mesmo motivo que não inventa custo: um número fabricado é pior que um ausente.

**Ingestão é outro caso, e ficou de fora de propósito.** Indexação em lote não acontece dentro de conversa nenhuma, e `agent_token_usage.thread_id` é NOT NULL com FK para as threads — gravar exigiria afrouxar essa FK, que é decisão de esquema e não cabe num callback de ingestão. Então `ingestChunks` expõe o consumo do lote por um `onUsage`, para o host contabilizar como preferir. Observável em vez de invisível, que é o meio-passo honesto.

**ATENÇÃO ao subir:** quem usa retrieval em modo inject vai ver os atores baterem na cota mais cedo. Nada ficou mais caro — o gasto sempre existiu e agora é contado. Se isso derrubar usuário real, o certo é subir o limite deliberadamente, e não tratar o número antigo (menor) como se fosse o verdadeiro.
