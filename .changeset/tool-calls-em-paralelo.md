---
'@adonis-agora/agent': minor
---

As tool calls `read` de um mesmo turno passam a rodar em paralelo.

Um modelo rotineiramente pede várias tools de uma vez, e o loop executava uma depois da outra — duas
leituras independentes de três segundos custavam seis. Agora elas se sobrepõem, e o turno custa a
chamada mais lenta em vez da soma.

O que fez disso um problema de determinismo, e não um `Promise.all`, é que o corpo do loop é
replayado pelo engine durable, que distribui posições de checkpoint por um contador monotônico
conforme o corpo roda. Intercalar blocos inteiros por chamada ordenaria essas posições por quem
terminasse primeiro, o que difere entre um run e seu replay.

Então só as INVOCAÇÕES se sobrepõem. Os `persist:toolcall` antes delas e os
`persist:toolexec`/`persist:toolfail` depois continuam estritamente sequenciais, em ordem de
chamada, e as invocações são todas lançadas no mesmo tick — `ctx.localStep` pega sua posição na
CHAMADA, antes do primeiro `await`, então o bloco fica fixado em ordem de chamada independentemente
de como as tools terminem. Um turno só é elegível quando o kind journalado de TODA chamada é `read`:
uma `action` suspende numa aprovação humana (paralelismo não compra nada, e reservar uma posição de
invocação para uma chamada que pode ser REJEITADA gasta uma posição que o branch rejeitado nunca
preenche), e uma delegação `agent` é `ctx.child`, cuja forma paralela é o `ctx.all` do próprio
runtime.

Dois `AgentLoopHooks` opcionais novos:

- `parallel(tasks)` — roda as tasks concorrentemente e resolve quando TODAS assentaram, resultados em
  ordem de entrada. Ausente, o loop segue sequencial, que é a resposta honesta para um runner que
  atribui posições em qualquer outro momento que não a chamada. `settleAll` é a implementação que os
  dois runners embarcados passam. Esperar todas é carga estrutural: um runner durable desenrola um
  turno lançando, e uma irmã abandonada no meio do próprio step é uma tool que ninguém roda.
- `patched(id)` — o portão de versão do runner (`ctx.patched`). O batching move os `persist:toolcall`
  para antes da primeira execução, então um run que suspendeu no meio de um turno sob a forma antiga
  continua replayando contra ela.

Um turno com menos de duas chamadas, ou de um runner que não optou por isso, grava exatamente a
sequência de checkpoints que sempre gravou.

Uma falha de controle de fluxo do runner (`hooks.isControlFlowError`) também deixou de virar
`persist:toolfail`: como uma recusa de integridade de replay, ela sobe intacta, antes de qualquer
persistência.
