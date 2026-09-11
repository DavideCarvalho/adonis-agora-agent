---
'@adonis-agora/agent': minor
---

Retrieval em modo inject e a resposta estruturada passam a ser entregues como tool calls comuns.

As duas já eram gravadas como tool calls sintéticas, mas só como LINHA na tabela de tool calls: a
call não estava na mensagem e o resultado não estava em lugar nenhum dela. Como um leitor de thread
pareia call e resultado pela mensagem, nenhuma das duas aparecia para nenhum cliente — nem ao vivo,
nem ao reabrir a conversa. Citações de um retrieval injetado e o valor validado de um `outputSchema`
existiam no banco e não existiam na tela.

Agora as duas sobem na mensagem do assistente a que pertencem, com a call em `toolCalls` e o
resultado em `toolResults`, exatamente como uma tool `read` que o modelo tivesse pedido. Um cliente
que já renderiza tool call renderiza essas duas sem mudança nenhuma.

O id de cada uma sai do RUN (`retrieve-<runId>`, `structured-<runId>`) e não da mensagem: a mensagem
ainda não existe quando o par é montado, e as duas precisam estar no append — uma call anexada
depois renderiza como tool ainda rodando, que é o problema que isto resolve. Os checkpoints
(`persist:retrieval:<messageId>`, `persist:structured:<messageId>`) mantêm nome e posição, e todo
valor gravado ali já vem de um checkpoint anterior do mesmo turno, então um replay remonta o mesmo
par em vez de cunhar um novo.
