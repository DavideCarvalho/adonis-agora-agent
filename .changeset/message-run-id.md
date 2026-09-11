---
'@adonis-agora/agent': minor
---

`StoredMessage` passa a carregar o `runId` (e a `persona`) que a mensagem foi gravada com.

`AppendMessageInput.runId` já existia e os dois stores já gravavam a coluna `run_id`, mas nada
devolvia o valor: `getThread` não trazia o campo e o store em memória guardava a correlação num mapa
lateral `messageId → runId`. Ou seja, quem lê uma thread só conseguia adivinhar a que turno cada
mensagem pertence comparando timestamps contra o `startedAt` do run — e essa comparação quebra no
momento em que um turno é regerado: a regeneração trunca a resposta substituída e responde de novo à
mensagem de usuário SOBREVIVENTE, sem acrescentar uma nova, então andar para a frente no tempo
entrega ao run antigo o texto da substituição.

Junto veio uma auditoria do contrato inteiro: **tudo que `appendMessage` aceita tem que voltar em
`getThread`**. Um campo que o adapter aceita e nunca devolve é invisível até alguém reabrir a thread e
não achar mais o anexo — nada falha, nada é logado. `attachments` já fazia o round-trip nos dois
stores daqui; `persona` não fazia em nenhum dos dois, e agora faz. O teste novo é tipado
`Required<Omit<AppendMessageInput, …>>`, então um campo opcional novo no input não compila até ser
listado ali.

Nenhuma mudança de schema: as colunas `run_id` e `persona` de `agent_message` já existiam.
