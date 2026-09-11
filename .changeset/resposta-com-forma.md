---
'@adonis-agora/agent': minor
---

Restringir a resposta de um turno a um schema.

Toda resposta que esta biblioteca produzia era texto livre, então a única forma de tirar um valor
tipado de um turno era declarar uma TOOL cujo trabalho inteiro era receber esse valor.

`AgentLoopDeps.outputSchema` aceita qualquer [Standard Schema](https://standardschema.dev) (Zod,
Valibot, ArkType). O valor validado volta como `object` no resultado do run, tipado quando o loop é
chamado direto (`runAgentLoop<T>`), e é gravado na mensagem do assistente como uma tool call sintética
`structured_output` — o mesmo dispositivo que o retrieval em modo inject já usa, então ele persiste e
renderiza sem nenhum store ganhar coluna. É declarado no AGENTE e não por requisição porque um schema é
um objeto vivo e `AgentRunInput` atravessa uma fronteira JSON a caminho de um workflow durable.

**Como compõe com tool calling: como uma passada de formatação separada, sempre.** O turno roda a
iteração modelo→tools exatamente como rodaria sem schema; quando um passo volta sem tool calls, uma
chamada extra não-streamada (`structured:<step>:<attempt>`, `tools: []`, `outputSchema` setado)
reescreve aquela resposta no formato do schema. A maioria dos providers não serve response format e
tool set no mesmo request. Pular a passada para um agente que por acaso não tem tools seria mais barato
e deliberadamente NÃO é feito: essa decisão leria o registry de tools de qualquer processo que estivesse
replayando, que é exatamente como um run retomado acaba pedindo uma posição de checkpoint que o
histórico dele não tem. Então a passada é incondicional, e custa uma chamada de modelo por turno,
faturada na própria linha de uso `structured_output`.

**A passada é uma tradução, então ela recebe o que uma tradução precisa:** a pergunta e a resposta que
sobreviveu ao gate de saída — nunca a transcrição inteira do turno, que seria o prompt do turno de novo
e sem desconto nenhum (a passada troca o bloco `system` pela instrução do schema, e o bloco `system` é o
prefixo do cache). A pergunta sai do prompt PROCESSADO, não de `AgentRunInput.userText`: esta é uma
segunda saída do modelo e tem que ficar atrás da mesma cadeia de `inputProcessors` que o turno
transmitido ficou. `outputFromTranscript` devolve o comportamento antigo para o agente cuja resposta
genuinamente não pode ser reescrita a partir das próprias palavras.

**Uma resposta que falha o schema é um desfecho DEFINIDO.** Até `outputRepairAttempts` chamadas a mais
(default 1) repetem o pedido com as issues de validação da tentativa anterior anexadas; depois disso o
run falha com `StructuredOutputError` carregando as issues, o texto que as violou e a contagem de
tentativas. Limitado porque um modelo que não consegue satisfazer um schema normalmente também não
consegue na quarta tentativa, e toda tentativa é cobrada. `outputRepairAttempts: 0` falha na primeira
resposta inválida.

`ModelTurnArgs` ganha `outputSchema` e `ModelTurnResult` ganha `object`. O adaptador do AI SDK mapeia o
schema em `output: Output.object(...)` do `streamText` para o provider restringir a geração, e devolve o
valor que ele mesmo parseou — mas o loop valida de qualquer jeito. "O provider disse que bate" não é a
mesma afirmação que "bate", e um provider que ignorou o schema tem que falhar onde a falha é reparável,
não lá na frente. Um adaptador que não consegue restringir a geração continua funcionando: o loop lê o
JSON do texto da resposta, cercas e prosa de abertura incluídas.

`UsagePurpose` ganha `'structured_output'`; os dois stores já gravam `purpose` como texto, então não há
mudança de schema. Quem não declara `outputSchema` não vê checkpoint novo, chamada extra nem mudança
nenhuma na sequência de checkpoints do loop.

**Uma diferença estrutural em relação ao porte de referência:** o loop daqui devolve os resultados de
tool ao modelo como uma mensagem `user` VAZIA carregando `toolResults`, então "a última mensagem do
usuário" não serve para achar a pergunta — a passada receberia uma pergunta em branco em todo turno que
chamou uma tool. `restatementPrompt` procura a última mensagem de usuário que de fato diz alguma coisa.
