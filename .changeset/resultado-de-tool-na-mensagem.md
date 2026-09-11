---
'@adonis-agora/agent': minor
---

O resultado de uma tool passa a chegar em quem reabre a thread.

O loop escrevia a saída de cada tool só na tabela de tool calls. Quem lê uma thread pareia uma call
com o resultado dela pela MENSAGEM em que a call foi feita — então toda tool de todo turno já
encerrado aparecia como uma tool ainda rodando, para sempre, nos dois stores. Nada falhava, nada era
logado: a transcrição simplesmente mentia sobre o estado de um turno que terminou.

`AgentStore.setMessageToolResults(messageId, results)` anexa os resultados já liquidados à mensagem
que fez as calls, substituindo o que ela tinha. É **obrigatório** na SPI, não opcional: um store que
silenciosamente não implementasse isso renderizaria um turno terminado como um turno eternamente em
voo, e um método faltando tem que quebrar a compilação em vez de quebrar a tela. `LucidAgentStore` e
`InMemoryAgentStore` implementam os dois.

Uma escrita, um comportamento, os dois adapters — não duas implementações que por acaso concordam.

O loop escreve num checkpoint próprio (`persist:toolresults:<step>`), depois da última tool do turno.
Isso é uma posição nova no journal, então ela é guardada por `ctx.patched('agent:message-tool-results')`:
um run que suspendeu no meio de um turno sob a forma anterior não tem espaço entre o último
`persist:toolexec` e o `llm:` seguinte, lê o marcador como ausente e continua replayando a forma que o
histórico dele guarda. Todo valor escrito ali já vem de um checkpoint acima, então um replay grava a
mesma lista.

O intake configurado ganha o mesmo tratamento dentro de `intake:answers`: o checkpoint `intake:ask`
agora devolve o id da mensagem que perguntou, e a resposta liquidada (ou o skip) pousa nela. Um
checkpoint que gravou apenas SE o intake rodou não traz id, e só nesse caso a linha de tool call
continua sendo o único registro.
