---
'@adonis-agora/agent': minor
---

`HistoryWindow` ganha orçamento de tokens e um caminho de sumarização embutido.

`SlidingWindowHistory` só sabia contar mensagens, e resumir era explicitamente problema do consumidor.
Agora ela aceita `maxMessages`, `maxTokens` ou os dois (vence quem corta mais), com `estimate` para
trocar a heurística de ~4 caracteres por token por um tokenizer de verdade, e `summarize` para dobrar
o que a janela deixou de fora numa mensagem `system` inicial. `summarizeWithModel(model)` é o
sumarizador embutido: uma chamada extra, não-streamada (escreve num sink que descarta, então os
tokens do resumo nunca chegam ao stream do usuário), registrada como uma linha de uso `summary` — a
cota soma o ledger inteiro sem filtrar propósito, então limitar o custo de contexto não vira gasto
que ninguém contabiliza. `estimateMessageTokens` e `DEFAULT_HISTORY_SUMMARY_INSTRUCTION` são
exportados para compor a sua própria.

O seam mudou de forma, e a razão é determinismo. `apply(messages, ctx) => ModelMessage[]`, rodado
inteiro dentro de um checkpoint `history:window`, virou duas metades que rodam em lugares
deliberadamente diferentes:

- `select(messages, ctx) => { keep, drop }` é PURA e roda FORA de qualquer checkpoint. Seguro porque
  a entrada dela já É um checkpoint (o resultado cacheado de `load:thread`), então um replay chega ao
  mesmo corte sem gastar posição nenhuma — é isso que permite existir uma janela sem mexer em uma
  única posição do loop.
- `summarize(dropped, ctx)` chama um modelo, então roda DENTRO de `history:summarize`: um run
  retomado lê de volta o resumo que a tentativa suspensa produziu, em vez de gerar outro (e de pagar
  duas vezes por ele).

Para quem não configura janela nenhuma, o loop grava exatamente os mesmos checkpoints de sempre: o
bloco inteiro é pulado. Para quem configura, um run já em voo continua replayando contra o
`history:window` que o histórico dele guarda — a decisão de qual forma seguir sai do journal
(`ctx.patched('agent:history-select')`), nunca da versão do código do processo que está replayando.
