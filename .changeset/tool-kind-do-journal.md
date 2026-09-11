---
'@adonis-agora/agent': patch
---

O `kind` de uma tool call passa a ser resolvido dentro do checkpoint `persist:toolcall`, não no corpo do loop.

O kind decide o fluxo da call — uma `action` suspende o run num sinal de aprovação
(`tool:<runId>:<callId>`), uma `agent` delega, o resto grava um step — e era lido de
`deps.registry` no corpo do workflow, ou seja, o branch dependia do registry do processo que por
acaso rodasse aquele corpo. Um processo cujo registry não tem a tool (um módulo que nunca a
declarou, uma superfície que não monta tools, uma instância ainda subindo) lia `undefined`, caía
no default `'read'` e pedia um checkpoint `tool:` onde o histórico guardava o sinal de aprovação —
recusa de não-determinismo no resume, e uma action gated rodando sem a aprovação de ninguém.

A resolução — e os gates de delegação que dependem dela — agora acontece dentro do step
`persist:toolcall:<callId>` e é retornada dele, então o replay lê o kind gravado em vez de
perguntar ao próprio registry. Mesmo nome de step na mesma posição do journal, então runs em voo
continuam replayando; um checkpoint anterior ao valor retornado não traz nada, e só nesse caso o
registry local volta a ser consultado.

Recusas de integridade de replay agora sobem intactas pelo loop e pelo workflow `agora.agent.run`.
Os dois `catch` reagiam a uma delas escrevendo MAIS checkpoints — um `persist:toolfail`, um
`persist:run:fail` — e num journal que já divergiu cada um deles pede uma posição que o histórico
não tem, então a tentativa de recuperação levantava a própria recusa e era ESSA que aparecia: uma
mensagem apontando o seq errado e nomeando checkpoints do caminho de recuperação, não os dois que
de fato discordaram. O workflow ainda fecha o stream, para o subscriber não ficar pendurado num run
que o engine está prestes a falhar. `isReplayIntegrityError` é exportado do pacote.
