---
'@adonis-agora/agent': minor
---

Deixar o agente fazer uma pergunta estruturada ao usuário — e esperar.

A única forma de um run parar por causa de uma pessoa era `awaitApproval`: um sim/não sobre uma tool
call já proposta, no meio do trabalho. A direção contrária não existia — coletar o ESCOPO, antes do
trabalho, enquanto mudar de rumo ainda é barato. Agora duas superfícies fazem isso, e foram construídas
para serem indistinguíveis lá na frente.

**Um intake configurado.** `AgentLoopDeps.intake` declara as perguntas; o turno passa por elas antes da
primeira chamada de modelo. Como as perguntas são AUTORADAS, o intake não custa chamada de modelo
nenhuma e não grava linha de uso — e `questions.length` é conhecido antes do formulário aparecer, que é
a única forma honesta de um cliente renderizar "Pergunta 1 de 3" em vez de descobrir uma quarta no meio
do caminho. `when: 'thread-start'` (default) pergunta uma vez por thread; `'every-turn'`, antes de cada
turno.

**Um `ask` chamável pelo modelo.** `ask: true` oferece ao modelo uma tool embutida `ask` para o caso que
um intake não consegue antecipar. O input schema dela EXIGE um `defaults` já escolhido em toda pergunta:
"eu já escolhi o que eu escolheria, então confirmar basta" é a afirmação em que essa superfície inteira
se apoia, e um schema é o único lugar onde isso vira obrigatório em vez de aspiração. Um conjunto de
perguntas malformado volta como falha de tool comum carregando as issues de validação, então o modelo
conserta o próprio erro em vez de derrubar o run ou estacionar uma pessoa.

**Uma forma só, um caminho de retomada só.** As duas gravam UMA linha de tool call pendente chamada
`ask` (`toolType: 'action'`, `status: 'pending_approval'`, então ela aparece na caixa de aprovações que
já existe), as duas emitem o mesmo frame novo de stream `elicitation`, e as duas estacionam no mesmo
sinal `tool:<runId>:<callId>` em que uma aprovação HITL já espera. `POST /agent/tool-call/answer` e
`/skip` espelham `approve`/`reject`, com a mesma checagem de dono. `AgentLoopHooks` ganha um
`awaitAnswers` opcional; um host que só implementou `awaitApproval` ainda conclui uma elicitation, lendo
approve como "confirmou as respostas pré-escolhidas" e reject como "pulou".

**Uma pergunta omitida assume o próprio default**, resolvido no servidor contra o request que o run já
tem em mãos e não no cliente — então "só apertou enter" e "escolheu exatamente os defaults" persistem
igual, e um cliente que nunca renderizou os defaults não consegue submeter em branco. Um array PRESENTE e
vazio é um "nenhuma dessas" explícito e não cai no default. A linha assentada grava `defaulted: string[]`,
então um auditor ainda enxerga quais perguntas um humano tocou. **Pular não é confirmar:** cai nos mesmos
valores e persiste como `rejected` em vez de `executed`, porque seguir com uma suposição que a pessoa se
recusou a confirmar é um fato diferente de seguir com uma que ela escolheu. Ninguém responder estaciona o
run indefinidamente, exatamente como uma aprovação — não existe timeout de intake, porque um timeout que
aplicasse os defaults fabricaria consentimento a partir do silêncio.

`ToolKind` ganha um quarto membro, `'ask'`. Nenhum `ToolSpec` o carrega: `ask` nunca é registrada, não tem
handler, e é oferecida ao modelo direto da config do módulo — então o branch que decide se uma call
estaciona numa pessoa nunca pode ser resolvido por um lookup de registry local do processo. Como nos
outros kinds, o valor é resolvido DENTRO do checkpoint `persist:toolcall:<callId>` que já existia e é
lido de volta dali em todo replay.

**Checkpoints.** Um intake gasta uma posição para o veredito (`intake:ask`) mais uma nos turnos em que
pergunta (`intake:answers`); um `ask` reusa os nomes do caminho de aprovação e acrescenta um
(`stream:elicitation:<id>`). O veredito do intake é DEVOLVIDO por `intake:ask` em vez de recalculado,
porque quando uma retomada replaya o turno a primeira tentativa já anexou a mensagem do próprio intake na
thread — recalcular "esta thread já foi perguntada?" responderia não na ida e sim na volta, e poria a
chamada de modelo onde o histórico guarda a espera. Nenhum marcador `patched` é gasto por nenhuma das
duas: um intake só é alcançável por config nova e um `ask` só por um kind gravado que nenhum run
existente registrou. Não declarar nenhuma das duas e a sequência de checkpoints do turno fica idêntica.

**Uma diferença estrutural em relação ao porte de referência:** este store não tem
`setMessageToolResults`, então as respostas assentadas ficam na linha da tool call — que é onde este repo
já guarda todo resultado de tool — em vez de também serem anexadas na mensagem. A transcrição que o modelo
lê carrega o round-trip completo de qualquer jeito. `StreamFrame` ganhou uma variante tipada
(`{ t: 'elicitation', id, request }`) e `frameToSse` a serializa como `event: elicitation`; o envelope de
um frame de texto continua byte-idêntico.
