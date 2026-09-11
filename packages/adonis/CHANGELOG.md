# @adonis-agora/agent

## 0.32.0

### Minor Changes

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `@adonis-agora/agent/evals` — nota de qualidade sobre os runs que já estão gravados.
  
  A biblioteca já sabia dizer quanto um turno custou e se ele terminou; não sabia dizer se ele prestou.
  Entra um SPI `Scorer` (um run gravado entra, um `0..1` mais a frase que o justifica sai), um runner em
  lote retomável, um `ScoreStore` para os vereditos, e os agregadores puros (`summarizeByScorer` /
  `summarizeByAgent` / `bucketScoreTrend` / `worstScoredRuns`) que espelham a aritmética do read-model de
  governança — assim um painel e um gate de CI nunca discordam sobre se a qualidade mexeu.
  
  **Offline por construção.** A leitura é do que o agente já persistiu — a linha do run, a transcrição, as
  tool calls e os desfechos — através do `AgentGovernanceQueries` e de mais nada, então funciona igual nos
  stores Lucid e em memória e **não acrescenta nenhuma tabela de leitura**. Nada roda dentro de um turno:
  um juiz inline dobraria a latência e a conta de toda mensagem que um usuário manda. `runEvaluation` pula
  um par `(run, scorer)` que o store já cobriu, então um backfill interrompido e reiniciado com a mesma
  query não cobra nada de novo.
  
  **Quatro scorers embutidos, um por coisa que esta biblioteca de fato sabe:**
  
  - `RunCompletionScorer` (`rule`) — o turno entregou? Um run que assenta `completed` sem ter respondido
    nada tira 0, que é exatamente o que a taxa de sucesso da governança chama de sucesso; uma resposta
    escrita com uma tool falhando tira 0,5; um run `cancelled` tira 0 com o motivo dizendo isso.
  - `ApprovalOutcomeScorer` (`rule`) — **toda rejeição de HITL é um rótulo negativo de qualidade que um
    humano produziu de graça.** A biblioteca já para uma tool `action` e pergunta a uma pessoa se aquilo
    deve rodar; essa resposta fica gravada na tool call e é a única verdade de referência do sistema que
    ninguém precisou pagar para coletar. A nota é a fração das actions DECIDIDAS do run que um humano
    aprovou. Uma action aprovada que depois explodiu conta como aprovada — a pessoa disse sim.
  - `ApprovalRiskScorer` (`statistical`) — o mesmo corpus virado previsão: taxa de aprovação por tool
    suavizada por um Beta(1,1), então uma tool inédita fica exatamente em 0,5 e um 1-de-1 rejeitado nunca
    lê como certeza. O run vale pela action MAIS arriscada que propôs, não pela média, para que uma caixa
    de aprovações seja drenada da pior para a melhor.
  - `AnswerRelevancyScorer` (`model`) — LLM como juiz sobre qualquer `ModelProvider`, com `discardingSink()`
    e `parseJudgeVerdict()` exportados para escrever o seu.
  
  Um scorer devolve `null` — e não `1` — para um run sobre o qual não tem o que dizer. A maioria dos runs é
  só leitura e não carrega veredito humano nenhum; contar esses como perfeitos enterraria os que carregam
  sob uma média de ~1. Um scorer que LANÇA é coletado como falha daquele run e o lote segue: um juiz que
  respondeu em prosa é uma avaliação quebrada, e gravar isso como 0 poria a culpa no agente.
  
  **Duas coisas ficaram diferentes do porte de referência, e as duas por causa deste read-model.** O
  `runDetail` daqui já devolve as mensagens carimbadas com o `run_id` do próprio run, então
  `GovernanceRunSampleSource` lê pergunta e resposta direto dele — sem juntar a transcrição da thread, sem
  heurística de janela de tempo, e sem depender do `AgentStore`. E como não existe um feed de tool calls
  paginado por tipo, o prior de aprovação vem de `priorFromRuns` (dobra as actions dos runs que o lote já
  carregou, custo zero de leitura) ou de `loadApprovalPrior` sobre o feed de atividade recente, limitado
  por `limit`.
  
  **Scoring ao vivo é opt-in e não consegue derrubar um turno.** `attachLiveScoring` assina
  `agora:agent:run.finished` e pontua DEPOIS que o run assentou e o stream dele fechou, numa promise
  destacada, com assinante protegido e toda falha roteada para `onError`. Não existe caminho de código de
  um scorer de volta para dentro de um turno. Ainda custa trabalho de verdade por run, então o lote segue
  sendo o default e `sampleRate` alivia a carga de qualquer coisa que cobre.

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `HistoryWindow` ganha orçamento de tokens e um caminho de sumarização embutido.
  
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

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - O servidor MCP deixava de fora os dois portões que o loop aplica.
  
  `tools/call` chamava `registry.invoke` direto, e `invoke` não conhece nem a `allowedTools` deste
  servidor nem o `kind` da tool. Três consequências, a primeira séria:
  
  - **Uma tool `action` executava sem aprovação humana.** No loop ela é HITL-gated: alguém aprova
    antes de rodar. Via MCP não há humano nenhum, e o handler rodava assim mesmo. Como o default de
    `roles` é ADMIN-only, a política de papéis era o único gate entre um chamador remoto e qualquer
    efeito colateral registrado.
  - **Tools servidas pelo loop** (`agent`, `ask`, `skill`, `memory`) apareciam na listagem. Uma tool de
    handoff é registrada com handler-stub porque quem delega é o `AgentLoop` — chamá-la responderia
    `{}` e não delegaria a ninguém.
  - **A `allowedTools` só valia na listagem.** Quem adivinhasse um nome alcançava uma tool que a
    implantação tirou da superfície de propósito.
  
  Agora `isExposable` decide igual na listagem e na chamada: `action` fora por default, com
  `actions: 'execute'` como opt-in nomeado — uma implantação dizendo que aceita um ator não aprovado
  rodando toda `action` que os papéis dele alcançam. Kinds servidos pelo loop nunca são expostos, nem
  sob o opt-in. E a allow-list é re-checada na chamada.
  
  `createMcpServer` não tinha teste nenhum, que é como isso passou. Tem agora, contra um `Client` MCP
  real, e cada portão foi revertido para ver o buraco reabrir.

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Memória de trabalho: o que o assistente concluiu sobre uma pessoa e sobre a organização dela,
  atravessando turnos e threads.
  
  Retrieval responde "o que os documentos dizem"; memória responde "o que eu decidi sobre você". Uma
  passagem é conteúdo que alguém escreveu e pode corrigir na fonte, e vai citada. Uma memória não tem
  fonte para consertar: é inferência do próprio agente. Por isso todo registro carrega um
  `MemoryOrigin`, por isso o bloco diz ao modelo que aquilo pode estar errado, e por isso `forget` é
  OBRIGATÓRIO no provider enquanto `write` é opcional — um deployment pode razoavelmente popular
  memória pelo próprio pipeline e não dar tool de escrita ao agente; nenhum pode razoavelmente guardar
  conclusões sobre uma pessoa que a pessoa não consiga apagar.
  
  **Os mesmos tokens de escopo e o MESMO `ScopeResolver` das skills**, para um deployment ter UMA
  resposta a "quais escopos este ator tem". Onde memória difere de skill de verdade, a diferença fica:
  a entrada carrega o VALOR derrotado e não só o escopo dele (um agente que soubesse apenas que existe
  um valor mais amplo não consegue dizer ao usuário qual é a diferença — só escolher, em silêncio, que
  é exatamente o que isto previne), e existe superfície HTTP de leitura e delete: `GET <path>/memories`
  e `DELETE <path>/memories/:id`. O autor de uma skill sabe que ela existe; o sujeito de uma memória
  não sabe. A leitura ignora `maxMemories` de propósito — aquele teto é orçamento de UM turno, e
  aplicá-lo ali significaria que alguém não consegue ver, e portanto apagar, uma crença que o
  assistente está a uma escrita de usar de novo.
  
  **Seleção por relevância (`MemoryProvider.search`).** O orçamento do prompt é limitado; o store não
  é. Escolher o bloco por ESCOPO mata os escopos mais amplos primeiro: a vigésima anotação de uma
  pessoa acaba com toda chance que os fatos da organização dela tinham — em silêncio, atrás de um
  `omitted` diferente de zero. O escopo continua sendo filtro duro que corta ANTES do ranking, e deixa
  de ser o ranking. O host é dono do índice (omita `search` e todo turno é a leitura escopada de
  sempre, sem mudança nenhuma); a lib é dona de resolução, precedência, orçamento e journal. A busca
  roda DENTRO de `memory:digest`, então todo replay lê de volta a seleção que a primeira tentativa fez.
  
  **`pinned` é categórico, não prioridade numérica.** Um número infla, não carrega significado
  revisável e compete com relevância, que já é uma ordenação contínua. Categoria vira orçamento: o
  pinned sai de `maxMemories` primeiro, e o que transborda é reportado como `pinnedOmitted` — porque
  essa omissão é erro de configuração, não o orçamento fazendo o trabalho dele. Um agente não consegue
  pinar as próprias escritas: `StoreMemoryInput` não tem esse campo, a mesma imposição por forma que
  mantém `scope` fora da tool `remember`.
  
  **O bloco é enquadrado por `origin.author`, em duas seções.** Uma memória de escopo amplo
  normalmente foi PUBLICADA por um administrador, não concluída pelo agente. Um enquadramento único
  sobre o bloco inteiro mandava o modelo tratar uma decisão organizacional como palpite próprio e
  "preferir o que o usuário diz agora" a respeito dela — o que entrega a qualquer usuário um override
  da política da empresa por simples afirmação. O que uma pessoa afirmou é instrução; o que o agente
  concluiu é hipótese.
  
  A tool `remember` não é registrada, gasta os checkpoints de um `read` e é autorizada contra os
  escopos que `memory:digest` gravou — nunca contra uma resolução nova. A escrita acontece DENTRO do
  `tool:<callId>`, o que a torna idempotente sob replay e põe no journal o que o modelo foi informado
  sobre ela. Um turno sem `memory` configurado tem sequência de checkpoints idêntica à de um que nunca
  teve a opção.

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `StoredMessage` passa a carregar o `runId` (e a `persona`) que a mensagem foi gravada com.
  
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

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Deixar o agente fazer uma pergunta estruturada ao usuário — e esperar.
  
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

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Processadores de entrada e de saída — um seam de cada lado da chamada de modelo, com custo proporcional.
  
  O `PromptBuilder` conseguia acrescentar ao system prompt e nada conseguia olhar a resposta. Para uma
  aplicação que roda SQL gerado sobre dados sensíveis isso é um buraco no controle, não uma conveniência
  faltando: o único lugar onde a saída do modelo ainda pode ser barrada é entre o provider e o leitor, e
  esse lugar não existia.
  
  `AgentLoopDeps.inputProcessors` / `outputProcessors` criam os dois. Um `InputProcessor` reescreve
  `{ system, messages }` antes de TODA chamada de modelo do turno — toda chamada, não uma por run, porque
  a transcrição cresce entre os passos e um redator que só viu o prompt de abertura deixaria passar o que
  um resultado de tool trouxe de volta. Um `OutputProcessor` vê a resposta de cada passo e devolve `pass`,
  `replace` (uma redação é uma substituição) ou `reject`, que encerra o run com `OutputRejectedError` em vez
  de uma resposta. Os dois são globais do módulo e valem para todo agente e persona: um controle do qual
  uma persona pode sair não é um controle.
  
  **Não são um segundo `HistoryWindow`.** Seleção — quais mensagens da thread entram no turno — continua
  sendo do `historyWindow`, que é puro e roda FORA de qualquer checkpoint. Processadores transformam o que a
  seleção produziu e rodam DENTRO de um, então podem chamar um modelo. A transcrição canônica do loop não é
  tocada: uma redação é o que sai do processo, nunca a memória da thread sobre o que foi dito — e dois
  passos de um mesmo turno nunca compõem a reescrita um do outro.
  
  **Registrar um processador de saída tira a chamada de modelo do sink ao vivo, e o preço disso é
  proporcional ao que a cadeia declara.** Um gate que precisa ler a resposta inteira não pode rodar depois
  que ela já chegou ao leitor, então o turno escreve num buffer e o loop solta o conteúdo — como UM frame
  `text` — quando a cadeia passa. Isso é a resposta certa para uma passada de moderação e caro demais para um
  redator de regex que não precisa da resposta toda:
  
  ```ts
  const redactEmails: OutputProcessor = {
    name: 'redact-emails',
    incremental: { lookbackChars: 320 },
    process: (answer) => ({ action: 'replace', text: answer.text.replace(EMAIL, '[email]') }),
  }
  ```
  
  **Não declarar continua significando resposta inteira**, e uma cadeia só é incremental quando TODO membro
  declara. Quem escreveu `process` contra o texto completo nunca é rebaixado porque um vizinho aderiu.
  Declarar `incremental` é uma promessa sobre todo prefixo: a cadeia vê o PREFIXO que cresce (nunca cada
  frame novo), então sempre recebe texto bem formado; fora dos últimos `lookbackChars` caracteres da própria
  saída, um `replace` não muda mais conforme o prefixo cresce; e uma recusa promete ser decidível a partir de
  um prefixo. `lookbackChars` é por processador (default 64) e o gate usa o maior da cadeia.
  
  A passada de resposta inteira continua AUTORITATIVA para o stream e para o store — a liberação incremental
  só adianta o prefixo. O gate depois confere que a resposta assentada `startsWith` o que já foi liberado e
  levanta `ProcessorFailedError` se não for, de modo que a concordância entre o que foi transmitido e o que
  foi gravado é estrutural, e uma janela curta demais para um padrão falha alto em vez de transmitir
  justamente o texto que ela existia para redigir.
  
  **Determinismo.** `process:input:<step>` e `process:output:<step>` só existem quando configurados, então
  quem não registra nada grava exatamente os mesmos checkpoints de sempre. O buffer, o prefixo já liberado e
  uma recusa vinda de prefixo viajam no CHECKPOINT `llm:<step>`, não numa variável local: um run que suspende
  entre a chamada de modelo e o gate retoma num processo que nunca viu aquele stream, e a liberação é
  calculada a partir do `releasedText` gravado — então a retomada emite só a cauda que ainda deve, em vez de
  despejar a mesma resposta uma segunda vez, mesmo que a cadeia tenha sido redeclarada no meio. Uma recusa só
  é levantada DEPOIS de `persist:usage:<step>` e `quota:bump:<step>`: aqueles tokens foram gastos de verdade, e
  um gate que escondesse o próprio custo deixaria uma cadeia mal calibrada queimar um orçamento invisivelmente.
  
  **Uma diferença estrutural em relação ao porte de referência:** o sink daqui carrega `StreamFrame` tipado,
  não bytes, então não há frame que o gate não consiga classificar — e o buffer viaja num checkpoint como
  está. Em compensação, as tool calls de um passo só são reportadas quando `runTurn` RETORNA, então no caminho
  incremental `ModelAnswer.toolCalls` fica vazio até a passada autoritativa, que sempre as vê.

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Restringir a resposta de um turno a um schema.
  
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

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - O resultado de uma tool passa a chegar em quem reabre a thread.
  
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

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Retrieval em modo inject e a resposta estruturada passam a ser entregues como tool calls comuns.
  
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

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Skills: procedimentos autorais que o modelo busca quando a tarefa pede, escopados por tokens que o
  host define.
  
  Uma skill NÃO é um agente. Um agente é QUEM responde — prompt, tools, janela de histórico, schema de
  saída. Uma skill é COMO uma tarefa específica é feita, e qualquer agente pode puxar uma. Por isso uma
  skill não carrega modelo, nem lista de tools, nem schema: no instante em que carregasse, as duas
  seriam a mesma coisa com nomes diferentes e o consumidor teria que escolher entre elas por razões que
  ninguém saberia enunciar.
  
  **O escopo é um token OPACO, nunca um enum.** `actor:u1`, `tenant:base-7`, `global`, ou o
  `sector:logistics` do próprio host. Um `ScopeResolver` fornecido pelo host diz quais se aplicam, do
  mais específico para o mais amplo, e essa ORDEM é a precedência. Um enum aqui faria de cada eixo novo
  (setor, esquadrão, base, turno) uma migração numa biblioteca que não tem por que saber que eles
  existem; um token é uma string que o host cunha sozinho. Esta biblioteca é dona do contrato (o que um
  escopo significa, como a precedência funciona, o que é journalado); o host é dono das linhas.
  
  **O que custa ao prompt: uma linha por skill.** O bloco `<skills>` carrega nome, escopo e descrição —
  nunca o corpo. O CORPO chega como resultado de tool, na transcrição, onde o `HistoryWindow` já
  governa. Então skills não viram um quarto competidor pelo bloco `system`, e um deployment com
  cinquenta skills paga cinquenta linhas mais os corpos que o turno de fato pediu para ler.
  
  **Os dois valores saem do journal.** Os escopos resolvidos e o catálogo que sobreviveu à precedência
  são UM checkpoint (`skills:catalog`); o corpo carregado sai de dentro do `tool:<callId>`. Um replay
  que relesse o provider comporia um prompt DIFERENTE a partir de uma skill editada no meio, numa
  posição de transcrição que o histórico já guarda. O catálogo journalado também é a fronteira de
  autorização: um nome que o turno não foi oferecido é recusado ali, então um modelo que inventa um
  nome não alcança um corpo por um provider que serviria de bom grado.
  
  A tool `skill` não é registrada — não tem handler, exatamente como `ask` — e gasta os checkpoints de
  um `read`, exatamente: `persist:toolcall`, `tool:<id>`, `persist:toolexec`/`persist:toolfail`. Um
  turno sem `skills` configurado tem sequência de checkpoints idêntica à de um que nunca teve a opção.
  
  `withAskTool` virou `withBuiltInTools({ tools, ask, skills })`, que é onde as duas built-ins entram na
  lista do turno.

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - As tool calls `read` de um mesmo turno passam a rodar em paralelo.
  
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

### Patch Changes

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - O `kind` de uma tool call passa a ser resolvido dentro do checkpoint `persist:toolcall`, não no corpo do loop.
  
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

## 0.31.0

### Minor Changes

- [#111](https://github.com/DavideCarvalho/adonis-agora-agent/pull/111) [`4c9bfe2`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/4c9bfe2cae0e750d778dfaffd95118df122b6afc) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **BREAKING** — pagination agora fala a MESMA interface de cursor de `@adonis-agora/filter`, em todo o ecossistema Agora
  
  Cada `@adonis-agora/*` paginava do seu jeito. Agora todos falam o `CursorParams`/`CursorPage` do
  `@adonis-agora/filter`: `{ after?, first? }` entra, `{ items, nextCursor, prevCursor, hasNext, hasPrev }`
  sai. Um consumidor que aprende a paginar uma lib paginou todas.
  
  Os tipos vivem em `@adonis-agora/agent` (`CursorPage`, `CursorParams`, exportados da raiz) e espelham os do
  `@adonis-agora/filter` **estruturalmente** — sem dependência entre os pacotes, por convenção do
  ecossistema. O `-dashboard` carrega a mesma declaração no seu `client/types.ts`, como já fazia com todas as
  outras wire shapes.
  
  **Forward-only, e isso está no tipo.** Os dois backends aqui só sabem avançar — o `scroll` do Qdrant
  devolve um `next_page_offset` opaco e nenhum token de volta, e o read-model de runs pagina com um cursor
  opaco pra frente. Então `CursorParams` NÃO tem `before`/`last` (um parâmetro que compila e não faz nada é
  pior que um que não existe), e todo `CursorPage` daqui sai com `prevCursor: null` / `hasPrev: false`. Esses
  dois campos ficam porque o ponto é ser a MESMA forma do `@adonis-agora/filter`: quem escreveu contra um
  renderiza o outro sem condicional, e uma superfície que ganhar paginação pra trás preenche os campos sem
  quebrar ninguém. São constantes, não bug.
  
  Como é 0.x, o breaking sai como **minor** (convenção semver de 0.x).
  
  ### 1. `QdrantStore.scrollChunks` — uma PÁGINA por chamada, não a coleção inteira
  
  `scrollChunks` drenava o cursor até o fim e devolvia um array. Agora é uma superfície paginada de verdade:
  uma ida de rede, `first` é o `limit` do scroll, `nextCursor` embrulha o `next_page_offset` do Qdrant em
  base64url — **opaco**, justamente pra ninguém passar a depender de ele ser um id de ponto. Devolver esse
  cursor adulterado agora falha com erro nomeado em vez de rebobinar em silêncio pra primeira página (um
  scroll que rebobina reprocessa chunks que um painel de deleção já tratou).
  
  `pageSize` virou `first` (mesmo default, 256) e `maxPages` sumiu: com uma página por chamada, o teto de
  páginas é o laço de quem chama. O `MAX_SCROLL_PAGES` interno segue guardando os scrolls que a store ainda
  drena sozinha (`listDocuments`, `listDocumentIds`, `updateMetadata`).
  
  ```ts
  // antes — drenava tudo, guardado por maxPages
  const payloads = await store.scrollChunks({ filter, payloadKeys: ['id'], pageSize: 256 });
  
  // depois — uma página; drenar é um laço seu sobre nextCursor
  const page = await store.scrollChunks({ filter, payloadKeys: ['id'], first: 256 });
  page.items; // Record<string, unknown>[]
  
  const all: Record<string, unknown>[] = [];
  let after: string | undefined;
  do {
    const p = await store.scrollChunks({ filter, ...(after ? { after } : {}) });
    all.push(...p.items);
    after = p.nextCursor ?? undefined;
  } while (after !== undefined);
  ```
  
  `facetValues(field, { limit })` virou `facetValues(field, { first })` — mesmo default (200), só o nome do
  tamanho de página alinhado ao `CursorParams`. Ele **não** virou `CursorPage`, de propósito: o endpoint
  `/facet` do Qdrant devolve os top-`first` valores de uma vez e não emite token de continuação nenhum, então
  um envelope de página aqui anunciaria um `nextCursor` que só poderia ser `null` pra sempre. Facet é
  agregado com teto; `scrollChunks` é a superfície paginada. `countChunks` (um número) segue igual.
  
  `PgVectorStore`/`MemoryVectorStore` não precisaram mudar: `scrollChunks`/`facetValues`/`countChunks` são
  capacidades do Qdrant, não estão na interface `VectorStore` que as três stores implementam, então não há
  como as duas formas divergirem.
  
  ### 2. `AgentGovernanceQueries.listRuns` — mesmos cursores, nomes do ecossistema
  
  Já era baseado em cursor, só com nomes próprios. `ListRunsResult` agora é literalmente
  `CursorPage<RunSummaryRow>`: as linhas saem em **`items`** (não `runs`), com `prevCursor`/`hasPrev`
  constantes.
  
  ```ts
  // antes
  const page = await gov.listRuns({ status: 'failed', limit: 50, cursor: prev });
  page.runs;
  page.nextCursor;
  
  // depois
  const page = await gov.listRuns({ status: 'failed', first: 50, after: prev });
  page.items;
  page.nextCursor; // + prevCursor: null, hasNext, hasPrev: false
  ```
  
  Quem implementa `AgentGovernanceQueries` por fora precisa renomear `runs` → `items` e devolver os três
  campos novos. As duas implementações que este pacote traz (`LucidGovernanceQueries` e a
  `InMemoryGovernanceQueries` de teste) já vieram atualizadas.
  
  **Rota HTTP** — `GET /agent/governance/runs` troca a query string e o corpo:
  
  ```diff
  - GET /agent/governance/runs?limit=50&cursor=<opaco>
  - { "runs": [...], "nextCursor": "<opaco>" }
  + GET /agent/governance/runs?first=50&after=<opaco>
  + { "items": [...], "nextCursor": "<opaco>", "prevCursor": null, "hasNext": true, "hasPrev": false }
  ```
  
  O `?limit=` continua existindo — só nas listas com TETO, que não são paginadas por cursor
  (`recentToolCalls`, `recentThreads`, a caixa de aprovações). A regra é essa: superfície com cursor fala
  `after`/`first`; top-N com teto fala `limit`.
  
  **Cliente do console** — `AgentClient.listRuns({ cursor, limit })` virou `listRuns({ after, first })` e
  devolve `CursorPage`. O provider do Telescope (`agent.runs.recent`) e o hook `useRuns` da SPA já
  acompanham; a UI do console não muda.

- [#112](https://github.com/DavideCarvalho/adonis-agora-agent/pull/112) [`3b7c240`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3b7c2403d6ee37555e40e18d02c0114962f90e95) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Require zod 4: the optional `zod` peer narrows from `^3.23.0 || ^4.0.0` to `^4.0.0`.
  
  The zod 3 half was a promise this package could not keep. `@adonis-agora/durable` — which agent
  peers on — types its public step API with zod 4 (`import type { z } from 'zod'`), and a zod 3 schema
  does **not** satisfy zod 4's `ZodType`: an app on zod 3 was already broken against the published
  ecosystem, it just failed later and less clearly. Narrowing makes the manifest honest.
  
  The peer stays **optional** — nothing changes for an app that never passes a zod schema. If you are
  still on zod 3, upgrade to zod 4 (`z.object`/`z.string()`/`z.infer`, the surface agent uses, is
  unchanged across the major).

## 0.30.2

### Patch Changes

- [#108](https://github.com/DavideCarvalho/adonis-agora-agent/pull/108) [`a99256b`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/a99256b185ce1f4d653476d5b5d0fc675ad25c57) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Corrige `AuthzActorResolver` para ler `userRef`/`tenantId` do `@agora/context` como MÉTODOS, não como valores — bug que derrubava com 401 toda rota do agente atrás de authz
  
  `@adonis-agora/context@0.6.1` publica no slot global `Symbol.for('@agora/context:accessor')` um accessor cujos campos são funções (`packages/core/src/accessor.ts`): `{ traceId(), tenantId(), userRef(), get() }`. `packages/adonis/src/authz/agora-context.ts` declarava `userRef`/`tenantId` como propriedades diretas, e `AuthzActorResolver.resolve()` lia `accessor?.userRef` como VALOR — contra o accessor real, isso é a própria função, `ref.id` é sempre `undefined`, e o resolver caía no ramo fail-closed ("no authenticated identity in @agora/context") em toda chamada. `tenantId` errava do outro lado, mais silenciosamente: uma função é truthy, então o escopo passado ao authz virava `{ tenantId: <function> }`.
  
  Isso passou despercebido porque o spec do resolver montava um dublê com `userRef`/`tenantId` como valor — a forma que o resolver assumia, não a que `@adonis-agora/context` produz. Um dublê que não respeita o contrato do original testa uma fantasia.
  
  **O que muda:**
  
  - `AgoraContextAccessor` (em `agora-context.ts`) agora tipa `tenantId`/`userRef` como métodos (`() => T | undefined`), espelhando o contrato real do accessor.
  - Duas novas funções, `userRefFromContext()` e `tenantIdFromContext()`, chamam esses métodos com segurança: toleram o campo não ser uma função (accessor parcial/mockado) e toleram o método lançar (fora de um contexto ativo) — em qualquer um dos dois casos degradam para `undefined` em vez de propagar, mantendo a postura fail-closed do chamador (`AuthzActorResolver` nunca fabrica identidade).
  - `AuthzActorResolver.resolve()` passa a usar essas duas funções em vez de ler `accessor.userRef`/`accessor.tenantId` como propriedade.
  - Specs de `authz-actor-resolver.spec.ts` e `agora-context.spec.ts` reescritos para mockar o accessor na forma real (métodos), com casos novos cobrindo: método ausente, método que lança, e `userRef()`/`tenantId()` retornando `undefined` fora de um contexto ativo.
  
  Não há mudança de assinatura pública — `AuthzActorResolverConfig`, `authzActorResolver()` e o formato do `Actor` resolvido continuam os mesmos. Consumidores que hoje contornam este bug manualmente (lendo o accessor tolerando as duas formas) podem remover o contorno depois de atualizar.

## 0.30.1

### Patch Changes

- [#104](https://github.com/DavideCarvalho/adonis-agora-agent/pull/104) [`0b7fe31`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/0b7fe3146ec33502bb09340cfa45002d002bd7e3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `facetValues`/`countChunks` param de enviar `exact: true` — a contagem exata era o hang que restou
  
  Medido contra o corpus real de produção (572 mil pontos, índices keyword já provisionados): um `facet` **exato** custou **23,5s** no server; o mesmo facet no default aproximado, **0,05s** (470× mais rápido) e o total veio idêntico. Como a agregação de um painel faz um facet por campo × tipo (~10 chamadas), `exact: true` como default somava minutos de request — exatamente o sintoma do painel "carregando para sempre" que a capacidade veio curar.
  
  Agora `exact` é **opt-in** nas duas capacidades ( `{ exact: true } ` quando a contagem exata for o objetivo — reconciliação, diff), e o default herda o default rápido do server. `removeWhere` mantém contagem exata de propósito: lá ela é a afirmação "quantos chunks este delete removeu", atada ao retorno da escrita, não um número de painel.

## 0.30.0

### Minor Changes

- [#102](https://github.com/DavideCarvalho/adonis-agora-agent/pull/102) [`4e95eeb`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/4e95eeb730feb944198a42d29bfc168b511868f4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Nova seam `HistoryWindow` para compactar o histórico de uma thread antes de cada turno
  
  Sem isso, `runAgentLoop` mapeia a thread PERSISTIDA inteira em `ModelMessage[]` a cada turno — uma thread de vida longa acumula mensagens e o custo/latência de input cresce sem limite, até eventualmente estourar a janela de contexto do modelo.
  
  `AgentConfig.historyWindow` (e o equivalente em `AgentLoopDeps`/`AgentDepsFactoryConfig`) aceita qualquer impl de `HistoryWindow` — mesmo padrão seam do `Retriever` já existente. O pacote traz `SlidingWindowHistory`, um truncador simples que mantém só as últimas N mensagens (padrão 40), sem resumo. Quem quiser sumarização (condensar as mensagens descartadas via um modelo) implementa a interface diretamente.
  
  Aplicado dentro de `hooks.step`, então uma retomada durable reaproveita o MESMO resultado — necessário para uma impl que gasta tokens num modelo não pagar duas vezes no replay.
  
  **Não-quebrante**: sem `historyWindow` configurado, o comportamento é idêntico a antes — histórico completo em todo turno.

- [#102](https://github.com/DavideCarvalho/adonis-agora-agent/pull/102) [`4e95eeb`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/4e95eeb730feb944198a42d29bfc168b511868f4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Painéis de inspeção do RAG ganham agregação server-side: `facetValues`, `countChunks` e `scrollChunks` no `QdrantStore`
  
  Quem constrói um admin sobre a coleção (`quantos chunks por documento? por tipo? quais chunks deste documento?`) esbarrava num muro: a store só sabia `search` (vetor) e `listDocuments` (colapsado por `documentId`). A alternativa honesta era um scroll da coleção inteira por request — em corpus de dezenas de milhares de pontos isso não é uma listagem, é um hang (foi exatamente o que um painel em produção fez: centenas de round-trips sequenciais de scroll e o browser girando para sempre).
  
  **O que entra:**
  
  - O filtro estrutural cresce para a linguagem que o GROUP BY de cadeia de prioridade precisa: `QdrantCondition` vira união com `is_empty` (campo AUSENTE/null/empty — os buckets de fallback), `QdrantFilter` ganha `must_not` (com `is_empty`, "campo PRESENTE") e `should` (OR — o fallback que é ausente OU o literal).
  - `facetValues(field, {filter?, limit?})` — o `POST /facet` do Qdrant: GROUP BY + contagem exata por valor, uma ida de rede. Qdrant exige índice de payload no campo; no primeiro erro o store PROVISIONA o índice `keyword` e repete o facet exatamente uma vez — a primeira chamada numa coleção nova paga o índice, as demais são facet puro. Sem `facet` no client injetado, o erro diz isso nominalmente; sem `createPayloadIndex`, o erro original do server propaga (nada de degradação silenciosa).
  - `countChunks({filter?})` — o agregado por trás de linhas como "chunks sem chave nenhuma", sem enumeration.
  - `scrollChunks({filter?, payloadKeys?, pageSize?, maxPages?})` — pagina os CHUNKS com o mesmo filtro raw do facet, vetor nunca atravessa o fio. Diferente de `listDocuments`: é por chunk e fala o filtro cru — existe para inspeção/deleção, onde o chamador conhece o payload que ele mesmo gravou.
  - `delete` no shim aceita `points` (lista de ids de ponto), como o client real já aceita — apagar "o que a agregação contou" sem reapresentar filtro.
  
  **Não-quebrante por construção:** nada disso toca o `VectorStore` SPI — são capacidades concretas do `QdrantStore` (como `ensureCollection`), e os dois métodos novos do client shim são `OPTIONAL` (o mesmo padrão de `setPayload?`/`count?`), então host com client escrito à mão continua compilando.
  
  **Validado contra Qdrant vivo** (`rag-qdrant-live.spec.ts`, gate `AGENT_QDRANT_URL`): o auto-provisionamento do índice acontece de verdade no server, `is_empty` cobre ausente e null, `must_not: [is_empty]` é presença, e o facet com `filter` honra a prioridade da cadeia (chunk com `numeroProcesso` E `examId` só conta no primeiro). O fake grava as chamadas e cobre as paths de erro (client sem capacidade, erro persistente sem retry infinito, cursor com `maxPages`).

- [#102](https://github.com/DavideCarvalho/adonis-agora-agent/pull/102) [`4e95eeb`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/4e95eeb730feb944198a42d29bfc168b511868f4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Alarga o peer `@adonisjs/redis` para aceitar `^11.0.0`
  
  `@adonisjs/redis` era um peer opcional em `^9.2.0 || ^10.0.0`. O sink Redis (`tokenSinks.redis()`) nunca importou tipos do driver — ele resolve `redis` pelo container do Adonis e duck-tipa a conexão (`RedisManagerLike`/`IoRedisLike`), então não há superfície de tipos ou API própria deste pacote presa à versão do driver.
  
  **Nota**: `@adonis-agora/durable` e `@adonis-agora/diagnostics` (peers próprios deste pacote, usados quando o durable/telescope estão habilitados) ainda declaram `^9.2.0 || ^10.0.0` nas suas versões publicadas atuais — um consumidor rodando `@adonisjs/redis@11` com esses dois habilitados verá um aviso de peer não satisfeito do gerenciador de pacotes até esses pacotes alargarem o próprio range. É só aviso; não é erro de instalação nem quebra em runtime.

## 0.29.0

### Minor Changes

- [#100](https://github.com/DavideCarvalho/adonis-agora-agent/pull/100) [`a4088f0`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/a4088f0cff6320e5ca86a4eb09c595b587df7f91) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Painéis de inspeção do RAG ganham agregação server-side: `facetValues`, `countChunks` e `scrollChunks` no `QdrantStore`
  
  Quem constrói um admin sobre a coleção (`quantos chunks por documento? por tipo? quais chunks deste documento?`) esbarrava num muro: a store só sabia `search` (vetor) e `listDocuments` (colapsado por `documentId`). A alternativa honesta era um scroll da coleção inteira por request — em corpus de dezenas de milhares de pontos isso não é uma listagem, é um hang (foi exatamente o que um painel em produção fez: centenas de round-trips sequenciais de scroll e o browser girando para sempre).
  
  **O que entra:**
  
  - O filtro estrutural cresce para a linguagem que o GROUP BY de cadeia de prioridade precisa: `QdrantCondition` vira união com `is_empty` (campo AUSENTE/null/empty — os buckets de fallback), `QdrantFilter` ganha `must_not` (com `is_empty`, "campo PRESENTE") e `should` (OR — o fallback que é ausente OU o literal).
  - `facetValues(field, {filter?, limit?})` — o `POST /facet` do Qdrant: GROUP BY + contagem exata por valor, uma ida de rede. Qdrant exige índice de payload no campo; no primeiro erro o store PROVISIONA o índice `keyword` e repete o facet exatamente uma vez — a primeira chamada numa coleção nova paga o índice, as demais são facet puro. Sem `facet` no client injetado, o erro diz isso nominalmente; sem `createPayloadIndex`, o erro original do server propaga (nada de degradação silenciosa).
  - `countChunks({filter?})` — o agregado por trás de linhas como "chunks sem chave nenhuma", sem enumeration.
  - `scrollChunks({filter?, payloadKeys?, pageSize?, maxPages?})` — pagina os CHUNKS com o mesmo filtro raw do facet, vetor nunca atravessa o fio. Diferente de `listDocuments`: é por chunk e fala o filtro cru — existe para inspeção/deleção, onde o chamador conhece o payload que ele mesmo gravou.
  - `delete` no shim aceita `points` (lista de ids de ponto), como o client real já aceita — apagar "o que a agregação contou" sem reapresentar filtro.
  
  **Não-quebrante por construção:** nada disso toca o `VectorStore` SPI — são capacidades concretas do `QdrantStore` (como `ensureCollection`), e os dois métodos novos do client shim são `OPTIONAL` (o mesmo padrão de `setPayload?`/`count?`), então host com client escrito à mão continua compilando.
  
  **Validado contra Qdrant vivo** (`rag-qdrant-live.spec.ts`, gate `AGENT_QDRANT_URL`): o auto-provisionamento do índice acontece de verdade no server, `is_empty` cobre ausente e null, `must_not: [is_empty]` é presença, e o facet com `filter` honra a prioridade da cadeia (chunk com `numeroProcesso` E `examId` só conta no primeiro). O fake grava as chamadas e cobre as paths de erro (client sem capacidade, erro persistente sem retry infinito, cursor com `maxPages`).

## 0.28.0

### Minor Changes

- [#98](https://github.com/DavideCarvalho/adonis-agora-agent/pull/98) [`252527a`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/252527a930817dd29a811e240add144d71d0daf9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - O gasto de embedding (RAG) passa a chegar ao ledger e à cota
  
  Era o único gasto que este pacote não conseguia enxergar. `EmbeddingProvider.embed` devolvia só vetores — sem contagem de tokens, sem `recordUsage` —, então nada de RAG chegava ao ledger. E como a cota diária SOMA o ledger sem filtrar propósito, também não chegava à cota.
  
  O efeito prático: um agente com retrieval em modo inject embeda a pergunta do usuário em TODA pergunta, gastando tokens que o painel jurava não existir. Isso é pior do que não medir — é medir para baixo, justamente na conta que decide quando barrar alguém.
  
  Agora o loop grava uma linha com `purpose: 'embedding'` para o embedding da consulta, dentro de um `hooks.step` (uma retomada durable não pode cobrar duas vezes pelo mesmo embedding).
  
  **A capacidade é OPCIONAL nos dois níveis, e isso é o que mantém a mudança não-quebrante:**
  
  - `EmbeddingProvider` ganha `embedWithUsage?`, ao lado do `embed` de sempre;
  - `Retriever` ganha `retrieveWithUsage?`, que o loop prefere quando existe.
  
  Um provider ou retriever escrito antes disto continua funcionando sem mudar uma linha — simplesmente não produz linha de embedding. O runtime NUNCA inventa uma contagem que não recebeu, pelo mesmo motivo que não inventa custo: um número fabricado é pior que um ausente.
  
  **Ingestão é outro caso, e ficou de fora de propósito.** Indexação em lote não acontece dentro de conversa nenhuma, e `agent_token_usage.thread_id` é NOT NULL com FK para as threads — gravar exigiria afrouxar essa FK, que é decisão de esquema e não cabe num callback de ingestão. Então `ingestChunks` expõe o consumo do lote por um `onUsage`, para o host contabilizar como preferir. Observável em vez de invisível, que é o meio-passo honesto.
  
  **ATENÇÃO ao subir:** quem usa retrieval em modo inject vai ver os atores baterem na cota mais cedo. Nada ficou mais caro — o gasto sempre existiu e agora é contado. Se isso derrubar usuário real, o certo é subir o limite deliberadamente, e não tratar o número antigo (menor) como se fosse o verdadeiro.

## 0.27.0

### Minor Changes

- [#96](https://github.com/DavideCarvalho/adonis-agora-agent/pull/96) [`8974b25`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/8974b2526b19b1efe1b6d824d34d180bee1169cc) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - O custo volta a aparecer quando o provider reporta um snapshot datado, e os preços podem vir do models.dev
  
  O ledger guarda o modelo que o PROVIDER reporta e a tabela de preço guarda o que o OPERADOR digitou. A OpenAI responde um pedido de `gpt-4o-mini` com `gpt-4o-mini-2024-07-18`, e toda tabela de preço publicada — e todo exemplo desta doc — usa o alias. Casados por igualdade crua num `Map.get`, os dois nunca se encontravam: o fold errava nos DOIS lados (`agent-loop` gravando `costUsd: null`, e o read-model devolvendo `0`), e o dashboard imprimia `$0.00` ao lado de um consumo real de tokens.
  
  Pior num deploy sem gateway: `agent_token_usage.cost_usd` só é preenchido a partir de custo reportado por gateway, então quem fala direto com a OpenAI não tinha nenhum valor persistido de reserva — o casamento em tempo de leitura era a resposta inteira, e ele falhava para zero.
  
  `resolveModelPrice` resolve o id reportado até o alias: id exato primeiro, depois sem o prefixo de rota (`openai/`, `bedrock/us.anthropic.`), depois sem o sufixo de data (`-2024-07-18`, `-20241022`). Só sufixos com FORMA DE DATA são descascados — um `-002` pode ser outro modelo com outro preço, e precificar errado em silêncio é pior do que não precificar. O id exato sempre ganha, então quem precifica um snapshot de propósito mantém isso.
  
  `seedPricesFromModelsDev(store, ['openai/gpt-4o-mini'])` preenche a tabela a partir do catálogo aberto do [models.dev](https://models.dev), em vez de números copiados à mão de uma tabela de preços. O prefixo `<provider>/` é obrigatório: o mesmo nome de modelo existe em provedores diferentes com preços diferentes, e adivinhar ali seria adivinhar uma conta. Modelo ausente do catálogo, ou sem preço publicado, é ERRO — nada é gravado se algum não resolveu, porque um seed parcial deixaria metade da conta certa e metade zerada.
  
  Nenhuma mudança de comportamento para quem já casava exato.

## 0.26.1

### Patch Changes

- [#94](https://github.com/DavideCarvalho/adonis-agora-agent/pull/94) [`d44a94e`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/d44a94e9c6fc0221450649c56970a83306b8c78f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - As ferramentas de delegação (`ask_<agente>`) falhavam 100% das vezes.
  
  O `delegateInputSchema` é um Standard Schema escrito à mão, sem a extensão
  `jsonSchema`. O bridge do SDK só deriva a forma dos parâmetros de um Zod ou dessa
  extensão — qualquer outra coisa degrada para `{ type: 'object', properties: {} }`, que
  diz ao modelo que **a ferramenta não tem argumentos**.
  
  O laço era imperdível: o modelo via uma ferramenta sem parâmetros, mandava `{}`
  (corretamente, dado o que lhe informaram) e a chamada era recusada contra um `validate`
  que exige `{ task: string }`. Numa instalação real, quatro ferramentas de delegação com
  **121 chamadas e 121 falhas cada** — queimando a cota diária inteira do usuário em
  retentativas de algo que ele não tinha como acertar. O `QuotaExceededError` que aparecia
  no fim era a consequência, não a causa.
  
  Agora o schema publica `jsonSchema.input` com `task` obrigatório. O `validate` segue sendo
  a autoridade; a extensão é o mesmo contrato na única forma que o modelo enxerga.

## 0.26.0

### Minor Changes

- [#90](https://github.com/DavideCarvalho/adonis-agora-agent/pull/90) [`c540ed5`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/c540ed5884d8dc2ad4a22c0f29f9ec9c68ace6be) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Governance console: a refused request now gets a real page instead of `{"error":"forbidden"}`.
  
  Opening the console without permission used to answer the browser with JSON. Both providers
  (the embedded `@adonis-agora/agent/dashboard_provider` and the standalone
  `@adonis-agora/agent-dashboard`) now serve a built-in access-denied page in the console's own
  visual language — the status, a sentence explaining the refusal and a "Back to app" link.
  Statuses are unchanged (`401` when no actor resolves, `403` when `authorize` denies), and a
  redirect written by `onUnauthenticated`/`authorize` still wins.
  
  The page carries no inline `<script>`, so a nonce'd `script-src` CSP cannot break it; its inline
  `<style>` takes `@adonisjs/shield`'s request nonce when one exists.
  
  New `dashboard.accessDenied` option on `config/agent.ts` to customise it — an object (`brand`,
  `title`, `message`, `homeHref`, `accent`, labels) to tweak the built-in page, or a function
  `(info, ctx) => html | void` to render it yourself or redirect. `@adonis-agora/agent/dashboard`
  exports the shared `answerDashboardDenial` + `renderAccessDeniedPage`.

## 0.25.5

### Patch Changes

- [#86](https://github.com/DavideCarvalho/adonis-agora-agent/pull/86) [`98b9c4f`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/98b9c4f97c1a04dd58bde67346cc194ef07a8e5f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Dashboard: every API request 404 under a nonce CSP — fixed.
  
  The providers used to hand the SPA the agent API base as an inline `<script>` setting
  `window.__AGENT_DASHBOARD_BASE__`. A host with `script-src 'self' 'nonce-…'` (`@adonisjs/shield`'s
  `@nonce`, the recommended setup) drops that script silently; the SPA then derived a base from its
  own URL, which is right only for the default `<agent>/dashboard` mount, and on any other every
  request from a console that rendered perfectly well answered 404. `injectApiBase` now emits a
  `<script type="application/json">` data block, which is never executed and so cannot be refused,
  and `resolveApiBase` reads it first (the global is still honoured after it). Nothing to change on
  the host.

## 0.25.4

### Patch Changes

- [#84](https://github.com/DavideCarvalho/adonis-agora-agent/pull/84) [`1f71789`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/1f71789d1d6d6a0e15f6c67ca0b51dc375de79a0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Accept `@adonisjs/redis` 10 as a peer (`^9.2 || ^10`) for the redis stream client and token
  sink. Nothing narrows; the suite runs against the new major.

## 0.25.3

### Patch Changes

- [#82](https://github.com/DavideCarvalho/adonis-agora-agent/pull/82) [`59be4e9`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/59be4e9943b47d79ce5f006c1d24b9b39e052f84) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add TanStack Intent agent skills. Both packages now ship a `skills/` directory
  (five skills under @adonis-agora/agent: setup, tools, governance, personas &
  multi-agent delegation, offline testing; one under @adonis-agora/agent-dashboard:
  the governance console client) that coding agents can load as structured,
  verified documentation. The directories are included in each package's `files`
  allowlist, and `@tanstack/intent` is added as a devDependency so CI can enforce
  skill validity via `intent validate`.

## 0.25.2

### Patch Changes

- [#79](https://github.com/DavideCarvalho/adonis-agora-agent/pull/79) [`88018eb`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/88018ebfeef32be65c464b075d692b62a369d3fd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix `node ace configure @adonis-agora/agent`, which was broken in every published version.

  The configure codemod runs each stub through Tempura, which compiles the stub **body** into a JavaScript
  template literal. A bare backtick in the body closes that literal; a bare `${` opens an interpolation.
  All four published stubs were full of both, in ordinary JSDoc prose — `` `lucid` ``, `` `model` ``,
  `` `${documentId}#<n>` `` — so every one of them threw at render time.

  `configure` therefore aborted on the very first stub, _after_ `updateRcFile` had already succeeded. The
  result was worse than nothing happening: `adonisrc.ts` came out referencing the agent and dashboard
  providers while `config/agent.ts` was never written, leaving an app that could not boot.

  Both constructs are now backslash-escaped in the stub bodies (`` \` ``, `\${`). This is a render-time
  concern only — the generated files are **byte-identical** to what the stubs always intended, backticked
  prose and all, which was verified against the pre-fix sources.

  The reason no gate caught this: every stub harness here rendered by stripping the `{{{ }}}` header with a
  regex and using the remainder, which is not what the generator does. A gate that renders differently from
  the generator is not testing the generator. All of them now render through the real engine
  (`app.stubs.create().build().prepare()`), and a new `stub-render.spec.ts` asserts that every stub
  `configure.ts` publishes actually renders — including the two config stubs, which no test had touched.

  Users on an earlier version who ran `configure` and saw it fail should re-run it after upgrading; if
  `adonisrc.ts` already lists the providers, the codemod is idempotent and only the missing files are written.

## 0.25.1

### Patch Changes

- [#77](https://github.com/DavideCarvalho/adonis-agora-agent/pull/77) [`4647d45`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/4647d45db1e23416a96e971de5c7ce6eda239558) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix the published migration, which did not type-check in a consumer app.

  `create_agent_tables` passes `db.connection(this.db.connectionName)` — a `QueryClientContract` — into
  `createAgentTables`, whose parameter was typed `LucidDatabaseLike`. That interface declared
  `rawQuery(sql, bindings?: unknown[])`, and `unknown[]` is assignable in **neither** direction to
  Lucid's `RawQueryBindings` (`StrictValues[] | { [key: string]: StrictValues }`): not inward, because
  `unknown` is not a `StrictValues`; not outward, because the named-bindings object is not an array. A
  method parameter is checked bivariantly, so failing both directions failed the check outright. Only
  the `Database` manager satisfied the interface, since its own `bindings` is `any`.

  So `node ace configure @adonis-agora/agent` produced a migration that threw `TS2345` under an app's
  `tsc`. `create_agent_rag_chunks` broke identically.

  The bindings type is now `readonly unknown[] | Record<string, unknown>` — a supertype of
  `RawQueryBindings`, so every real Lucid client matches while the interface stays structural and
  `@adonisjs/lucid` stays an optional peer. The schema helpers, `PgVectorStore`, and the SQL data
  satellite now take a new, narrower `LucidRawRunner` (just `rawQuery`), which is all any of them
  actually use — asking for less is what lets a per-connection client qualify at all.

  This keeps `migration:run --connection=x` working. The workaround of passing the bare `Database`
  manager compiles but always provisions the default connection.

  New exported types: `LucidRawRunner`, `LucidRawBindings`. `LucidDatabaseLike` is unchanged in
  capability (it now extends `LucidRawRunner`) and still exported.

## 0.25.0

### Minor Changes

- [#74](https://github.com/DavideCarvalho/adonis-agora-agent/pull/74) [`9776fdc`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/9776fdce96ab283f76bb24c6a31610e9ea91e17d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix the published migration, which threw against any database the library had already provisioned.

  `node ace configure @adonis-agora/agent` published `create_agent_tables` as raw DDL —
  `this.schema.createTable('agent_thread', ...)` with no existence guard. But `autoCreateTables`
  defaults to `true`, and the first use of any of the three stores that share those tables (the agent
  store, the pricing store, the governance read-model) provisions them. So in any app that had run the
  agent even once before migrating, `node ace migration:run` died with `table "agent_thread" already
exists`. Reported from a real consumer upgrade.

  The stub now delegates to `createAgentTables` / `dropAgentTables` instead of reproducing the DDL, with
  `disableTransactions = true` (the helper takes its own pooled connection, which would otherwise
  deadlock against `pool: { max: 1 }`). Drift stops being something to test for and becomes impossible:
  the migration and the auto-created schema are the same code.

  The separate `create_agent_run_tracking` stub is gone — one schema, one migration. Its `run_id` columns
  were already inline in the table DDL for a fresh database, and `createAgentTables` now also ALTERs them
  into a database provisioned before run tracking shipped, so collapsing the two loses no upgrade path.
  That repair also fixes `autoCreateTables` on such a database, where the missing columns were previously
  never added at all.

  `create_agent_rag_chunks` had the same unguarded `createTable`; it now provisions through
  `PgVectorStore.ensureSchema()`.

  `createAgentTables` now resolves to the list of repairs it applied (it returned nothing before). Callers that only `await` it are unaffected.

  **No action needed.** Migrations you have already run stay applied; this only changes what `configure`
  generates from here on. If your `migration:run` was failing, re-run `node ace configure` and delete the
  old `create_agent_tables` / `create_agent_run_tracking` files it had published.

## 0.24.0

### Minor Changes

- [#71](https://github.com/DavideCarvalho/adonis-agora-agent/pull/71) [`24c8d6f`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/24c8d6f81da6fc335ec96e4154f36a22ad762a8a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Delegation is authorizable, the actor directory is consumed, and `dashboard` is part of the typed config.

  - **`delegatesTo` accepts an object edge.** A synthesized `ask_<target>` tool goes through the same
    `RolesPolicy` gate as any other tool, and a bare-string edge carries neither `roles` nor `ability` —
    which is ADMIN-only under `DefaultToolAuthorizer` and an outright deny under `authzToolAuthorizer`,
    so delegation was unreachable under authz with no way to open it. `delegatesTo` now also takes
    `{ agent, roles?, ability? }` (`DelegateEdge`), whose annotation lands on the synthesized spec. Bare
    strings keep their existing fail-closed behaviour.
  - **`ActorDirectory.resolveDisplay` is now called.** `actorDirectory` resolved into a provider field
    that was never read, so governance surfaces always rendered raw refs. Every governance route
    returning an `actorRef` now carries an optional `actorLabel`, filled from one batched directory
    lookup per page and omitted for unknown refs. Fail-soft: an unbound or throwing directory leaves the
    rows exactly as the read-model produced them.
  - **`AgentConfig.dashboard` is typed.** The console's config block was read through an untyped
    `config.get('agent.dashboard')` string path, so writing it inside `defineConfig({ ... })` was an
    excess-property error. It is now a declared `AgentConfig` field and the provider reads it off the
    typed config.
  - **`engines.node` is a range again.** Both packages published an exact version (`v22.23.2` /
    `v26.7.0`), which warns on install for every consumer on any other Node and hard-fails under
    `engine-strict`. Renovate's global `rangeStrategy: "pin"` had rewritten the ranges; `engines` is now
    excluded from pinning so it cannot happen again.
  - JSDoc: the published source carried Portuguese doc comments (`sse.ts`, `spi/tool.ts`, `base-tool.ts`,
    `stores/factory.ts`, `rag/qdrant-store.ts`, `ai-tool-ref.ts`) — translated to English. Corrected the
    stale cost formula on `AgentGovernanceQueries` (it omitted the cache-token split), the attachment
    allow-list default (an exact-match list of 7 types, not `text/*`), and two NestJS-era references.

## 0.23.0

### Minor Changes

- [`3504f37`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3504f37de4e063b5839388b684c63a0ab2ff5efa) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The dashboard gate now honors a redirect the host already wrote to the response instead of always overwriting it with the default `401`/`403 { error }` JSON — mirrors `@adonis-agora/durable`'s dashboard guard, and `@adonis-agora/telescope`'s guard gains the same escape hatch in a companion release.

  - **`authorize` denies (403)**: redirect from inside `authorize` (e.g. `ctx.response.redirect('/acesso-negado')`) and return `false` — the gate detects the `location` header and skips its own JSON write. No API change; this always worked as a predicate, only the response-writing layer changed.
  - **The actor resolver itself rejects the caller (401)** — no resolver configured, or `resolve(ctx)` threw (e.g. `AuthActorResolver` on an anonymous request) — is a case `authorize` never sees, since there's no resolved actor to hand it. New optional `dashboard.onUnauthenticated?: (ctx) => void | Promise<void>` runs there instead, ctx-only (never a fabricated actor, preserving the resolver's "no identity is invented" contract): redirect inside it the same way to replace the default JSON, or leave the response untouched to keep it.

  ```ts
  // config/agent.ts
  dashboard: {
    authorize: (actor, ctx) => {
      if (isAdmin(actor)) return true
      ctx.response.redirect('/acesso-negado')
      return false
    },
    onUnauthenticated: (ctx) => {
      ctx.response.redirect('/login')
    },
  }
  ```

## 0.22.2

### Patch Changes

- [`a1fd42f`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/a1fd42f2cf6d4fd206ea99f195202a85618295f9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stops leaking internal exception messages (`AuthActorResolver`'s "no authenticated user on ctx.auth.user...", or whatever `authorize`/`governanceAuthorize` happens to throw) to the client on the dashboard's `401`/`403` responses and on the `/agent/governance/*` and per-actor route `401`s — they now reply with a generic `'unauthorized'`/`'forbidden'`, matching `@adonis-agora/durable`'s dashboard convention of a uniform message on every credential failure, instead of exposing detail meant for the developer wiring the config to an untrusted, possibly anonymous caller.

  The detail isn't gone — `evaluateDashboardGate`/`evaluateGovernanceGate` gained a `debug` parameter (default `false`), and the providers pass `!app.inProduction`, so local/dev boots keep seeing the real message while diagnosing a misconfiguration.

  `evaluateDashboardGate`'s "no actor resolver configured" `401` is unaffected — that's a static config error, identical for every caller and not per-request, so it stays visible even in production.

## 0.22.1

### Patch Changes

- [`f0a622a`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/f0a622aeadec938355f9b5f5f515e335b406e712) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Republishes with the updated `agent-dashboard` embed (`packages/adonis/dist/assets/spa`, copied at build time from `@adonis-agora/agent-dashboard`'s own `dist/spa`) — the console's visual-identity fix from `ce1d08f` (dark-by-default, Aviary token/font/radius parity) has no effect on hosts until this package is rebuilt and republished, since it embeds the dashboard's built assets rather than depending on it at runtime. No source change in `packages/adonis` itself.

## 0.22.0

### Minor Changes

- [`079da35`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/079da35e91f1eab93020212bb93686eaa8dd9bee) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ported the Nest ("Aviary") telescope extension's governance and RAG coverage onto `@adonis-agora/agent/telescope`, alongside the existing entry-backed providers:

  - **Governance-backed providers** (`agent-governance-providers.ts`): spend by model/actor, usage trend, run reliability (total/success-rate/failed/avg-duration/by-agent/trend), recent runs/tool-calls/threads, and the pending-approvals inbox — reading the SAME `AgentGovernanceQueries` read-model the `/agent/governance/*` routes and the standalone dashboard SPA already use, via a new package-internal registry `AgentProvider#boot()` populates (`src/telescope/governance-registry.ts`). Several Nest-reference panels have no equivalent on this SPI and are deliberately not ported — top-threads-by-cost, run retries, run duration percentiles, error-code breakdowns, and paged tool-calls/threads/runs tables — see that file's header for the full list and why.
  - **RAG providers** (`rag-data-providers.ts`): retrieval count, zero-hit rate, mean chunk count, and a retrievals/zero-hits trend, read off the `retrieved` diagnostic event `agent-loop.ts`'s inject-mode retrieval already publishes. Latency, score distribution, and store/collection breakdowns are NOT ported — the recorded event carries none of that data today; see that file's header for what widening the instrumentation would need.
  - **Host extensibility**: `agentTelescopeExtension({ providers, sections })` lets a host app append its own data providers and dashboard sections, mirroring the Nest reference (with the same `agent.`-prefix reservation on host providers).
  - The "Agent" dashboard gained four new sections (Spend & usage, Spend detail, Run reliability, Governance activity, RAG) binding to the above.

  No watcher and no dedicated `agent`/`agent-rag` entry types are contributed — confirmed against `@adonis-agora/telescope`'s current `TelescopeExtension` contract, which has no `watchers` hook and gives every `agora:agent:*` event the same generic `diagnostic` entry type. That's a real, documented SDK constraint (see `extension.ts`'s header), not an oversight: RAG and every other agent event share one capped `lib:agent` window as a result.

## 0.21.0

### Minor Changes

- [`58783fb`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/58783fb433fd3c641dc9a42b80eaba09f2c9a62b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `@adonis-agora/agent` now ships its own governance dashboard — `node ace configure @adonis-agora/agent` registers an embedded `dashboard_provider` that serves the `@adonis-agora/agent-dashboard` SPA straight out of `@adonis-agora/agent`'s own build (`../dashboard/dist/spa` is copied into `dist/assets/spa` at build time), so a new app needs no separate install or provider registration to get the console. Configure it via the same optional `config('agent').dashboard` block as before.

  This is purely additive: the standalone `@adonis-agora/agent-dashboard` package and its own `agent_dashboard_provider` keep working exactly as before for apps that already install and register it directly — both providers now share one implementation (`@adonis-agora/agent/dashboard`, a new subpath export) so their behavior is byte-for-byte identical. Register only one of the two in a given app; mounting both at the same path throws AdonisJS's "duplicate route" error at boot.

  `@adonis-agora/agent-dashboard`'s peer dependency floor on `@adonis-agora/agent` moves to `>=0.21.0` (the version that introduces the shared `@adonis-agora/agent/dashboard` export its provider now imports from); already-published `agent-dashboard` versions are unaffected.

## 0.20.0

### Minor Changes

- [`4e3a372`](https://github.com/DavideCarvalho/adonis-agent/commit/4e3a372e9ecf53ec4c34bbe31ab6177262b0dcd5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `GET`/`POST /agent/governance/pricing` and a Pricing panel in the console.

  The `pricingStore` bound to the agent (default-mirrored from a Lucid `store`, or opt-in for other
  backends) was already driving cost accounting for runs, but had no read/write surface of its own —
  operators had to reach for the database directly to see or change a model's per-1M-token rates. The
  two new routes expose `AgentPricingStore.listCurrentPrices()`/`upsertModelPrice()` behind the same
  authenticated + authorized governance gate as every other `/agent/governance/*` route, mounted only
  when a pricing store is bound. The dashboard's new "Pricing" section reads and edits rates through
  them.

- [`4e3a372`](https://github.com/DavideCarvalho/adonis-agent/commit/4e3a372e9ecf53ec4c34bbe31ab6177262b0dcd5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add a thread governance drill-down: `GET /agent/governance/threads/:id` and a `ThreadDetailView` you
  reach by clicking a row in the console's Recent threads table.

  `AgentGovernanceQueries` gets a new optional `threadDetail(threadId)` method returning the thread's
  metadata plus a lifetime usage rollup (total tokens, cost, run/message counts) and its most recent
  runs/messages — implemented in both `LucidGovernanceQueries` and `InMemoryGovernanceQueries`. It's
  optional so a third-party or pre-existing adapter that predates it doesn't break: the route responds
  `501` instead of the dashboard hitting a missing endpoint.

  The Recent threads and Tool calls panels also gain "Load more" pagination instead of a fixed row cap.

- [`4e3a372`](https://github.com/DavideCarvalho/adonis-agent/commit/4e3a372e9ecf53ec4c34bbe31ab6177262b0dcd5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `RunReliability` (from `GET /agent/governance/reliability`) gains two optional fields: `byAgent` (run
  and failure counts per agent, highest call count first) and `trend` (daily run/failure counts over the
  same range, oldest first) — implemented in both `LucidGovernanceQueries` and
  `InMemoryGovernanceQueries`. Both are optional so an adapter that predates them can keep returning the
  existing shape; the dashboard's Reliability section renders a trend chart and a by-agent breakdown when
  present and stays as before when absent.

## 0.19.1

### Patch Changes

- [`3377419`](https://github.com/DavideCarvalho/adonis-agent/commit/3377419676511876522258d6156ccf79a7b302a0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Type the MCP actor on `AuthInfo.extra`: the `authKitAuth()`/`apiKeyAuth()` strategies now return a typed `McpAuthInfo` (`extra: { actor: Actor }`), and `actorFromAuthInfo`/`isActor` are exported from `@adonis-agora/agent/mcp` so consumers no longer hand-roll a runtime guard. The MCP provider reuses the promoted helpers instead of its module-local copies.

## 0.19.0

### Minor Changes

- [`9a91190`](https://github.com/DavideCarvalho/adonis-agent/commit/9a91190936f24f912ccb756c58f490381f2b13c7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add an MCP (Model Context Protocol) endpoint that exposes the agent's ToolRegistry over Streamable
  HTTP.

  - New `./mcp` subpath: `defineMcpConfig`, `createMcpServer`, and two auth strategies — `authKitAuth()`
    (OAuth OIDC via `@adonis-agora/authkit-server`, resolved lazily) and `apiKeyAuth()` (constant-time
    key compare). The acting `Actor` resolves from the verified auth and gates `tools/list` /
    `tools/call` through the same role-checked registry the agent loop uses (fail-closed).
  - New `./mcp_provider` subpath: an Adonis provider that mounts `POST|GET|DELETE /mcp` plus
    `GET /.well-known/oauth-protected-resource/mcp` (RFC 9728 metadata when OAuth is configured), with
    per-session Streamable HTTP transports.
  - `configure` publishes `config/mcp.ts` via the new `config/mcp.stub`.

  The published `dist` ships `./mcp` and `./mcp_provider` export maps (mirroring `./agent_provider`).

## 0.18.0

### Minor Changes

- [`634c2df`](https://github.com/DavideCarvalho/adonis-agent/commit/634c2df384e90df85014d0ddb8e9c2215bb4c7b1) - **Security fix**: the cross-actor `/agent/governance/*` read-model is no longer mounted when no `governanceAuthorize` gate is configured.

  Previously these routes mounted whenever the governance read-model resolved — which happens **by default** whenever the main store is Lucid — and the `governanceAuthorize` gate was optional. With no gate, the gate evaluated to "allow", so **every authenticated actor could read the platform-wide governance data: every actor's spend, token usage, thread activity, run traces and pending HITL approvals.** Apps that never configured a gate got this by taking the default; the library only printed a boot warning, which is not a control. If your app has ordinary end users (not just trusted staff) as resolved actors, assume this data was readable by any of them.

  The cross-actor routes now mount **only when `governanceAuthorize` is set**. Without a gate they do not exist and return `404`. Affected routes:

  `GET /agent/governance/spend/model`, `spend/actor`, `usage/trend`, `tool-calls/recent`, `threads/recent`, `runs`, `runs/:id`, `approvals/pending`, `tools/stats`, `reliability`.

  **`GET /agent/approvals/mine` is unaffected.** It keeps mounting whenever the governance read-model resolves, gate or no gate — it is always scoped to the calling actor's own pending approvals, and non-admin surfaces (e.g. a chat page polling for its own suspended tool calls) depend on it.

  Two migration paths, both in `config/agent.ts`:

  ```ts
  // 1. The intended fix — mount the routes gated (typically an ADMIN check):
  governanceAuthorize: (actor) => actor.roles?.includes('ADMIN') ?? false,

  // 2. Deliberately keep the old open behaviour — explicit, greppable, reviewable:
  governanceAuthorize: () => true,
  ```

  Boot still succeeds without a gate: the provider warns (it does not throw) and names both paths.

- [`38106a9`](https://github.com/DavideCarvalho/adonis-agent/commit/38106a9d981b770dd755a2779810e27aa2a890f6) Thanks [@claude](https://github.com/claude)! - Three RAG capabilities: metadata that can be corrected without re-embedding, enumeration and bulk deletion that don't walk the corpus document-by-document, and a chunker that can be told where the records are.

  **`updateMetadata(documentId, patch)` — change a document's metadata without paying to re-embed it.** Optional on `VectorStore`, implemented by all three shipped stores, resolving to the number of chunks written. Until now the only way to change a chunk's metadata was `upsert`, which needs the text and a fresh embedding — so a consumer whose documents get re-classified had to choose between re-embedding a whole document to change one label, or not stamping the mutable dimension onto chunks at all and resolving it at query time instead, which turns a filter the index could apply into a join the caller has to do. The second is the one people actually pick, and it is what makes an actor-derived retrieval filter unaffordable: such a filter only pays off if the dimensions it filters on are _on_ the chunks and can be corrected when they change. `patch` is a **shallow JSON Merge Patch** — `null` deletes a key (said in those words on `MetadataPatch`, because "patch" alone does not tell you whether `null` deletes or stores a null), values replaced wholesale, `undefined` ignored, absent keys left alone. Text and embeddings are untouched; on pgvector the merge happens in SQL so `SET` structurally cannot name the embedding column, and on Qdrant it goes through `set_payload`, which has no vector field at all. Verified against Postgres 17 + pgvector 0.8.5 and Qdrant 1.18 asserting the stored vector is byte-identical afterwards.

  **`listDocumentIds(filter?)` and `removeWhere(filter)` — enumerate and drop in bulk, without a document-by-document walk.** Both optional on `VectorStore`, both on all three stores. Dropping a collection used to mean `listDocuments()` — which fetches and JSON-parses a metadata blob _per chunk_ only to collapse it to one entry per document — followed by one `remove()` per document: N+1 round trips where one filtered delete would do. (The Qdrant adapter had already grown a defensive page cap on that `listDocuments` scroll, which is the tell that an enumeration API was carrying work it is not shaped for.) `listDocumentIds` skips the per-chunk metadata entirely — a `SELECT DISTINCT` on pgvector, a one-key scroll on Qdrant. `removeWhere` deletes in one filtered statement and reports how many chunks went.

  Because `removeWhere` is the only call here that destroys data, it removes **exactly what a `search` carrying the same filter could reach, and never more**: every store builds the delete predicate with the very same filter builder its `search` uses, so the two cannot drift. The empty-array deny is honoured and means "delete nothing", not "no filter". And `removeWhere({})` throws `UnsafeRemovalError` instead of wiping the store, because an empty object is far more likely to be a filter that got built wrong than a deliberate request to delete everything — deliberate mass deletion stays explicit via `remove` over `listDocumentIds()`.

  **`chunkText(text, { separator })` — cut on the record boundary instead of guessing one.** The chunker breaks on the latest paragraph/sentence/word boundary in its window, which is right for prose and wrong for text whose boundaries _mean_ something: a spreadsheet flattened to one field-labelled record per line gets cut mid-record, so the half holding the row identifier lands in a different chunk from the half holding the value and neither can answer a question about that row. Pass `separator` and it becomes the only boundary the chunker may cut on. Two consequences, documented on the option: a record longer than `chunkSize` is emitted **whole** as its own over-size chunk rather than being cut (`chunkSize` becomes a target, not a cap — falling back to a mid-record cut would defeat the point, and an over-size chunk is visible where a mangled record is not), and `overlap` becomes a character _budget_ spent on whole trailing records, never a partial one. Reaches `ingestDocuments` for free.

  Nothing changes for existing callers: omit `separator` and the prose path is byte-for-byte what it was — guarded by frozen boundary cases and confirmed by a differential run over 20,000 random input × option combinations, because a shifted chunk boundary silently invalidates stored embeddings and is not something a minor release may do. All three store operations are **optional** on the `VectorStore` interface, so a host-written store that implements none of them still compiles.

- [`6d0d746`](https://github.com/DavideCarvalho/adonis-agent/commit/6d0d746ebe88da5f7931059ea544a5d2b63b7679) - **Security-relevant feature**: inject-mode RAG retrieval can now be scoped per actor via the new `retrievalFilter` config option — and **without it, retrieval remains unscoped**.

  Inject-mode RAG (setting `retriever` in `config/agent.ts`) retrieves passages for the user's message and folds them into the system prompt on every turn, but had no seam through which a host could supply a filter: `retriever.retrieve(text, { topK })` was called with no `filter` and no actor, so a host could not scope it even by wrapping the retriever. Any deployment that turns on `retriever` and shares one corpus across tenants was leaking passages across tenants into the system prompt, on every turn, for every user — the write side (`rag-media` ingestion tagging `tenantRef`/`ownerId`) and the store-level `filter` support (`pgvector`/Qdrant, both correct) already existed; nothing ever populated `filter`.

  `retrievalFilter?: (actor: Actor) => Record<string, unknown>` closes that gap: it derives the same `audience`-style ACL filter documented for manual/agentic retrieval, but from the run's actor, and applies it automatically inside the existing `hooks.step('retrieve', …)` (so durable replay determinism is unaffected). With no hook configured, the retriever receives options with no `filter` key at all (not `filter: undefined`) — existing single-tenant deployments are byte-identical. A hook that throws fails the turn rather than falling back to unfiltered retrieval.

  **Action for existing multi-tenant deployments using inject mode**: set `retrievalFilter` in `config/agent.ts`. Without it, you may have been retrieving across your entire corpus regardless of who is asking. See `docs/retrieval/rag.mdx`.

  Deliberately out of scope: the `Retriever` SPI is unchanged (third-party retrievers still satisfy it unmodified), and retrieved passages are still folded into the system prompt without fencing as untrusted data — the second half of this finding, tracked separately.

### Patch Changes

- [`63b9b08`](https://github.com/DavideCarvalho/adonis-agent/commit/63b9b08caa19a092965a465612215254fbb14997) - **No published version of either package is affected.** This is a repo-tooling fix with no runtime change — nothing in `src/` moved. Checked rather than assumed: the live tarballs for `@adonis-agora/agent@0.17.0` and `@adonis-agora/agent-dashboard@0.3.2` contain 105 and 13 `.js` files respectively, exactly what a full local build emits. The release workflow publishes from a cold `actions/checkout`, which has no `dist/` and no `.tsbuildinfo` to go stale, so the defect below could not reach npm. It could reach a contributor's working copy, and did.

  `pnpm build` could exit `0` having emitted no JavaScript. `tsc` ran with `incremental: true` against a `.tsbuildinfo` that records what it already wrote to `dist/`; delete `dist/` and leave the buildinfo behind and `tsc` concludes every output is current and emits nothing. In `@adonis-agora/agent`, `copy:stubs` is a plain `cp` and ran anyway, so `dist/` came out holding four stub files and zero `.js`. Turbo then cached that empty directory as a _successful_ `build` and replayed it onto clean trees — a later `pnpm build` on a freshly wiped checkout restored the vacuum as `FULL TURBO` in 32ms. Downstream, `packages/dashboard` failed with `TS2307: Cannot find module '@adonis-agora/agent'` against the package that had just "built".

  Both packages are fixed the same way:

  - `build` removes `dist/` up front and compiles through a new `tsconfig.build.json` with `incremental: false`, so an emit is always a full emit and no state survives to disagree with `dist/`.
  - A new `scripts/assert-build-output.mjs` runs as the last step of `build` and fails it if `dist/` holds no JavaScript or is missing the package entrypoint. It runs inside the build, so it also covers `prepack` — which never goes through turbo, and is the path a manual `pnpm publish` would take.
  - `build` and `typecheck` no longer share a buildinfo. `typecheck` keeps `.typecheck.tsbuildinfo`; `build` keeps none at all. `turbo.json` is unchanged.

  If you have a checkout in the broken state, the guard now prints the way out — and the command it prints works, which took a second pass to get right: the buildinfo files are dotfiles and a shell `*` does not match those.

  ```
  rm -rf dist .*tsbuildinfo *.tsbuildinfo
  pnpm run build
  ```

  The dashboard's exposure needed a different guard. Its `build` is `vite build && tsc`, and vite keeps populating `dist/spa/` whatever `tsc` does — a `dist/` with no provider in it still holds a dozen `.js` files. Counting JavaScript would have passed it, so `check:dist` there asserts the entrypoint by name.

  Neither a count nor a named entrypoint is enough on its own. A _partial_ emit was observed during this fix: `dist/` came out holding exactly one `.js`, `src/index.js`, which satisfies both checks — and because `index.d.ts` was there too, the dashboard compiled against it without a single `TS2307`. Every subpath export (`@adonis-agora/agent/rag-media`, `/durable`, `/testing`, …) pointed at a file that did not exist, and the first thing to notice would have been a consumer's failed import. So the guard also walks `package.json`'s `exports` and requires every target it declares. That list is the package's real publish contract, and it maintains itself — adding an export adds a post-condition, with nobody having to remember. It also covers `@adonis-agora/agent-dashboard/client`, which the by-name check never looked at.

- [`fa39b5f`](https://github.com/DavideCarvalho/adonis-agent/commit/fa39b5faef317fb47cf1fbb8fe29cec448270d21) - **If your governance console suddenly 404s, or every panel in it is failing: set `governanceAuthorize` in `config/agent.ts`.**

  ```ts
  // config/agent.ts
  export default defineConfig({
    // ...
    governanceAuthorize: (actor) => actor.roles?.includes("ADMIN") ?? false,
  });
  ```

  That one line brings both the console and its data back. If you deliberately want the old behaviour where any authenticated actor could read the platform-wide governance data, say so explicitly with `governanceAuthorize: () => true` — same effect, but greppable and reviewable.

  **Why.** The cross-actor `/agent/governance/*` read routes stopped mounting without a `governanceAuthorize` gate (see the previous `@adonis-agora/agent` release). Ten of the console's eleven read endpoints are those routes, and the SPA calls them **from the browser** — so an app with the dashboard installed and no gate got a console that loaded fine and then failed on every panel except Quota, with nothing in the logs explaining it.

  **What changed.** `@adonis-agora/agent-dashboard` now refuses to mount when the agent config has no `governanceAuthorize`, and logs a boot warning naming both fixes above. The console URL returns `404` instead of serving a shell that cannot work. Nothing that still worked is broken by this: every affected app already had a console dead in six of its seven views.

  Unaffected:

  - Apps that already set `governanceAuthorize` — no change whatsoever.
  - `dashboard: { enabled: false }` — still off, still silent, no warning.
  - `dashboard.authorize` — still an optional EXTRA gate on the SPA shell, unchanged. It is deliberately not what decides whether the console mounts: it gates the shell, not the data, so an app could set it and still have a console with nothing to render.
  - `GET /agent/approvals/mine` — never behind the governance gate; still mounted and still scoped to the calling actor.

  The `@adonis-agora/agent` half of this release is documentation only: the `governanceAuthorize` JSDoc and the `governance-gate.ts` comments still described the old open-by-default behaviour they no longer have. `evaluateGovernanceGate`'s behaviour is unchanged.

- [`58177f7`](https://github.com/DavideCarvalho/adonis-agent/commit/58177f718477ecdda362b6870b25225cff391759) - **Security fix**: `agent`-kind delegate tool calls now go through the same role/ability check and allow-list filter as every other tool call, instead of executing unconditionally.

  Previously, when the model emitted a tool call for an `agent`-kind (delegation) tool, the loop called `hooks.runAgent` directly at the loop level — it never went through `ToolRegistry.invoke`, so the `policy.can(actor, spec)` re-check, the Zod input validation, and the persona/agent allow-list filter (only applied when building the offered-tools set) were all skipped. A model steered by injected content — delegate tool names are advertised in sibling delegate descriptions — could name a delegate tool it was never offered and run it regardless of the actor's role or the agent's configured allow-list. The synthesized delegate specs carry no `roles` and no `ability`, so they were meant to be unreachable by a non-privileged actor; the loop ran them anyway.

  The delegation branch now: (1) fails closed if the delegate's spec cannot be resolved; (2) verifies the tool name is in the set actually offered to the model (the same persona/agent allow-list intersection used to build the offer); (3) re-checks `rolesPolicy.can(actor, spec)`. All three checks run _before_ the tool call is persisted and before the `agent.delegated` event is published, so a denied delegation is recorded `failed` — never `auto_executed`, even transiently.

  **Behaviour change for hosts using `AuthzToolAuthorizer`**: delegate tools carry no `ability` by design. Under an authz posture, a tool with no `ability` is _always_ denied — so after this fix, delegation will be denied for any actor unless the host explicitly declares an `ability` on its delegate tools. This is not a regression: it is what an authz-backed configuration with no `ability` on these tools always meant. Hosts that rely on delegation under `AuthzToolAuthorizer` need to declare an `ability` for their delegate tools (or otherwise grant it through their policy) to keep delegation working.

- [`3627aec`](https://github.com/DavideCarvalho/adonis-agent/commit/3627aece5817f93518154133b07a29fb4068e1ff) - `node ace add @adonis-agora/agent` now actually registers the provider and publishes the config and migration stubs, instead of silently warning "the module does not export the configure hook" and doing nothing. AdonisJS resolves the configure hook by importing the package's main entry and reading `configure` off the module namespace — it never reads the `./configure` subpath. The package main now re-exports `configure` from the package root so `node ace configure` finds it.

- [`f4f3fb1`](https://github.com/DavideCarvalho/adonis-agent/commit/f4f3fb1cdd0117f5a748a3088d4fdc032d6fa7fc) - **Security fix**: `dataTool`'s tenant scoping no longer treats a tenant predicate found under an `OR` as coverage.

  `TenantScopeRewriter.collectTenantPredicates` recursed into `OR` branches exactly as it did into `AND` branches, with no record of which boolean context it was in. Any tenant predicate found anywhere in a query's `WHERE` tree — including inside an `OR` — marked that table's alias "already scoped", so the rewriter added no constraint at all. A model-authored query of the form `... WHERE base_id = '<own tenant>' OR 1 = 1` (or any other disjunctive shape naming the caller's own tenant) passed through unconstrained and returned every tenant's rows from an allow-listed table.

  Coverage is now computed from the top-level `AND` spine only (`collectConjunctiveTenantPredicates`): a predicate under an `OR`, `NOT`, or any non-conjunctive operator no longer suppresses the AND-ed tenant constraint. The **mismatch rejection** is unchanged and deliberately still walks the _whole_ tree (`collectAllTenantPredicates`): a query naming a foreign tenant anywhere — even inside an `OR` — still throws `tenant scope: tenant mismatch`, rather than being silently AND-ed down to zero rows.

  **Behaviour change**: queries that previously passed through unconstrained because of an `OR`-side tenant predicate (e.g. `WHERE base_id = 'mine' OR 1 = 1`, `WHERE (base_id = 'mine' AND x) OR y`) are now correctly constrained — the emitted SQL gains an additional `AND <tenantColumn> = '<tenantRef>'`. A query whose tenant predicate is already on the top-level `AND` spine is unaffected (no duplicate predicate is added).

  A second, adjacent bug was found and fixed while implementing this: `andCondition` built the AND-tenant-predicate AST node without marking the pre-existing (possibly `OR`-rooted) `WHERE` as parenthesized. `node-sql-parser`'s printer only wraps a subexpression in `(...)` when a `parentheses` flag is explicitly set on it — without it, `AND`/`OR` print at the same precedence, left-to-right, so a real database (which applies standard SQL precedence, `AND` binding tighter than `OR`) would have misread the emitted text and applied the tenant constraint to only the last disjunct, silently re-opening the same bypass this fix closes. `andCondition` now always parenthesizes the existing WHERE before AND-ing.

- [`258e322`](https://github.com/DavideCarvalho/adonis-agent/commit/258e322c8454020f52d110b328514ff5478c1a60) - Delegation now applies the input-schema gate, closing the last of the three gates `ToolRegistry.invoke` applies.

  `invoke` gates every tool call on (1) the role/ability check, (2) input validation against `spec.inputSchema`, then (3) execution. `agent`-kind (delegate) calls are handled at the loop level and deliberately bypass `invoke` — the durable runner maps them to `ctx.child`, a ctx-level suspend point. The previous fix re-applied the role and allow-list gates to that branch but not the input gate, so a malformed delegate input was silently coerced instead of rejected: `extractTask` fell back to `JSON.stringify(input)`, and a model emitting `{ task: { nested: 1 } }` or `{ tsak: '...' }` delegated a JSON blob as the task string. Every other tool kind rejects that with `ToolInputInvalidError`.

  The delegation branch now validates `call.input` against the delegate spec's `inputSchema` and throws the same `ToolInputInvalidError`, after the role and allow-list checks so the ordering matches `invoke` (authorization first, then shape). The task handed to the target agent is derived from the validated value rather than the raw input. A rejected input lands in the existing `try/catch`, so it is recorded `failed` and never emits `agent.delegated`.

  This only rejects inputs that were previously mis-coerced; no public signature changes.

- [`c78c0f4`](https://github.com/DavideCarvalho/adonis-agent/commit/c78c0f4a1897f7aab5caf3ceb7857927dde934a6) - The optional `@adonis-agora/*` peer ranges (`authz`, `diagnostics`, `durable`, `telescope`) no longer point at a single already-superseded minor. On a `0.x` package `^0.x.y` means "this exact minor only," so every sibling minor bump silently made these ranges unsatisfiable against what's published on npm — a consumer installing any current sibling version got an `ERESOLVE`/warning wall. Ranges now use `>=<floor> <1.0.0`, matching the pattern already used by `agent-dashboard`'s peer on `agent` and `authz-react`'s peer on `authz`. The floor for each is the version this package was actually verified against (the one the dev install had resolved), not the current published version:

  - `@adonis-agora/authz`: `>=0.4.2 <1.0.0`
  - `@adonis-agora/diagnostics`: `>=0.1.0 <1.0.0`
  - `@adonis-agora/durable`: `>=0.8.0 <1.0.0`
  - `@adonis-agora/telescope`: `>=0.4.0 <1.0.0`

  The matching devDependencies were bumped to the current published versions (durable 0.20.0, telescope 0.6.0, authz 0.10.1, diagnostics 0.2.5) so this repo's typecheck and test suite actually run against current sibling APIs instead of many minors behind. No source changes were required — the integration code under `durable/`, `telescope/`, `authz/` and `diagnostics.ts` typechecked and passed its tests unchanged against the newer siblings.

## 0.17.0

### Minor Changes

- [#36](https://github.com/DavideCarvalho/adonis-agent/pull/36) [`0c3c1c0`](https://github.com/DavideCarvalho/adonis-agent/commit/0c3c1c01e52d588c9aaaae8d2467999937233687) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `QdrantStore.upsert` agora fatia os pontos em lotes (novo `upsertBatchSize`, default 100) em vez de um único request. Fontes grandes viram muitos chunks (ex.: PDF de ~200 páginas → ~700 pontos); enviar tudo num request só estourava o timeout default de 300s do `@qdrant/js-client-rest` (`QdrantClientTimeoutError: This operation was aborted`). Batchar mantém cada request pequeno e previsível — ingestão robusta pra qualquer tamanho de fonte.

## 0.16.0

### Minor Changes

- [#34](https://github.com/DavideCarvalho/adonis-agent/pull/34) [`5afc7e5`](https://github.com/DavideCarvalho/adonis-agent/commit/5afc7e5cab6de57abc8662e70fc4c72476015c96) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Adiciona um backend Qdrant (`QdrantStore implements VectorStore`) ao lado do pgvector, com a factory `retrievers.qdrant({ embedder, url, apiKey, collection, dimension, metric })`. O `@qdrant/js-client-rest` é peer dependency opcional (import lazy). Contratos `Passage`/`VectorStore` inalterados; uma collection só com filtro de payload (a mesma semântica de ACL por token do pgvector), id de chunk mapeado para UUIDv5 no ponto.

## 0.15.0

### Minor Changes

- Tool discovery now runs after `app.booted()` instead of during the provider's `boot()`. This lets `app/agent_tools` files use ordinary top-level imports of Adonis service singletons (e.g. `@adonisjs/lucid/services/db`) without the import throwing during boot (which, in a pruned production build, surfaced as `Cannot read properties of undefined (reading 'booted')` and left the tool missing). The tool registry is populated before the HTTP server accepts traffic, so no behavior changes for consumers.

## 0.14.0

### Minor Changes

- Add `RetrieveOptions.minScore` — a relevance floor applied to vector-store retrieval (passages with `score < minScore` are dropped before the top-K cut), enabling strict-grounding RAG. Also add per-agent `AgentDefinition.actorResolver`, letting an individual agent resolve its request actor differently from the global `config.actorResolver` (the per-agent resolver is preferred when present, falling back to the global otherwise).

## 0.13.3

### Patch Changes

- [`22b207e`](https://github.com/DavideCarvalho/adonis-agent/commit/22b207ed263192e8a34922b08d04821f3fa61d8d) - Tool discovery no longer aborts the whole scan when one tool file fails to import.

  The `app/agent_tools` readdir scan imported each file with no per-file guard, so a single tool whose module throws at import time (e.g. a top-level `@adonisjs/*/services/*` singleton resolving `app` as `undefined` during boot) took down the entire scan and left the agent with ZERO tools — which surfaces as the model "narrating" tool calls as text (it was never given any tools) rather than any visible error. Each import is now wrapped: a failing file is logged loudly (`app.logger`, else `console.error`) and skipped, so the other tools still register and the failure is diagnosable.

## 0.13.2

### Patch Changes

- [`88f70d8`](https://github.com/DavideCarvalho/adonis-agent/commit/88f70d851070767a70b1b1c7278a1a1e01f578f2) - Fix `tokenSinks.redis()` crashing at boot with "Cannot read properties of undefined (reading 'booted')".

  The Redis sink factory built its client by importing `@adonisjs/redis/services/main`, whose module-level `app` is `undefined` when the sink is resolved during `AgentProvider.boot` — so the sink threw at boot and, under `durable: true`, the first frame write hung (runs stuck at step 0). The sink factory now receives the app context (like store/quota factories) and resolves Redis via `app.container.make('redis')` with the live application, so it builds correctly. `SinkFactory` / `TokenSinkFactory` now take a `{ app }` context argument (a no-arg factory stays assignable, so existing custom sink factories keep working).

## 0.13.1

### Patch Changes

- [`293843c`](https://github.com/DavideCarvalho/adonis-agent/commit/293843c7fc6082453b80ab4b5272ca3cd31da887) - Redis token-stream sink: expire a run's replay keys instead of leaking them.

  The framework never calls the sink's `close()`, so the Redis multi-replica sink's per-run `chunks`/`state` keys accumulated forever. They now get a TTL (default **1h**, sliding window refreshed on every write — so a long run stays alive and a crashed run that never `end`s still expires). Configurable via `tokenSinks.redis({ ttlSeconds })`; set `0` to keep the previous retain-forever behaviour. Adds an optional `expire(key, seconds)` to the `RedisStreamClient` interface (the `@adonisjs/redis` adapter implements it; a bring-your-own client that omits it keeps working, just without the TTL).

## 0.13.0

### Minor Changes

- [`b684986`](https://github.com/DavideCarvalho/adonis-agent/commit/b68498606a02e82dc92d01a7aa139eb6ba752bee) - Add a framework-agnostic browser client and a React hook for the chat SSE endpoints.

  Consuming the agent's SSE envelope (`POST /agent/chat` → `event: meta` / `data: {delta}` / `event: component` / `event: done`) and reconnecting a dropped stream used to be re-implemented by hand in every app. Two new entry points move that logic into the package, next to the server that emits the envelope:

  - **`@adonis-agora/agent/client`** — zero-dependency, isomorphic. `createAgentChatClient({ basePath, fetch, getHeaders, resume })` returns `send()` / `resume()` that post a turn, parse the envelope, capture the run id, and — when the connection drops before `done` — re-attach to `GET /agent/chat/:runId/stream` (which replays the whole stream from the start and follows live) with backoff, until the run finishes or the retry budget is exhausted. The run is durable and keeps executing server-side across the drop, so no tokens are lost. Also exports the parsing primitives (`parseSseEvent`, `decodeFrame`, `foldPart`, `readSseStream`) and `AgentChatDisconnectedError` (which carries the partial parts).
  - **`@adonis-agora/agent/react`** — `useAgentChat({ ...clientOptions, buildBody })` returning `{ messages, status, error, send, cancel }`, a thin state wrapper over the client. `react` is a new optional peer dependency.

## 0.12.0

### Minor Changes

- [`0998975`](https://github.com/DavideCarvalho/adonis-agent/commit/0998975ca76b88c84b5e428139af0f363f28abbb) - Generative UI: typed stream frames (`text`|`component`), `AiToolCtx.emitComponent`, and `event: component` in the SSE provider. Backward compatible for text-only consumers.

### Patch Changes

- [#29](https://github.com/DavideCarvalho/adonis-agent/pull/29) [`fd77544`](https://github.com/DavideCarvalho/adonis-agent/commit/fd77544040bdf8d95c532f3f70c6bd7673cec4ca) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix agent tool-loop dropping tool results. `mapMessages` in the AI SDK adapter skipped `toolResults` on `role: 'user'` messages (early `continue`), but `agent-loop` feeds tool output back as a synthetic `{ role: 'user', content: '', toolResults }` carrier — so the results were silently dropped and the follow-up model call threw `AI_MissingToolResultsError`. The user branch now emits the `tool` result message (via a shared `pushToolResults` helper) and skips the empty user turn so the tool result stays adjacent to the assistant tool-call. Multi-step tool-calling now completes for OpenAI-compatible providers.

## 0.11.0

### Minor Changes

- [#31](https://github.com/DavideCarvalho/adonis-agent/pull/31) [`315eb41`](https://github.com/DavideCarvalho/adonis-agent/commit/315eb41839bff2903e96481e7ca98881accdd8cd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Tools de classe agora são instanciados pelo **container do Adonis**, então `@inject` no construtor funciona — o app deixa de fazer service-locator (`app.container.make(...)`) dentro do `execute()`.

  ```ts
  @inject()
  export default class ReatribuirPesquisa extends ActionTool<Input, Result> {
    constructor(private allocation: CoordinatorAllocationService) {
      super();
    }
    static tool = {
      name: "reatribuir_pesquisa",
      description: "…",
      input,
      ability,
    };
    async execute(input, ctx) {
      return this.allocation.reassign({
        ...input,
        coordinatorId: ctx.actor.id,
      });
    }
  }
  ```

  A resolução é **lazy** (no primeiro `execute`) e cacheada: a descoberta roda no `boot()` do provider, antes do app estar totalmente booted, então um `container.make()` eager poderia falhar resolvendo um peer service — o mesmo motivo pelo qual a store factory do Lucid resolve lazy. Tools sem dependências continuam funcionando iguais.

  `discoverTools`, `registerToolsFromBarrel` e `registerToolExport` aceitam um `app?: ApplicationService` opcional (o provider passa `this.app`); sem ele, o comportamento pré-DI (`new Ctor()`) é preservado. `registerToolExport` continua síncrono.

## 0.10.1

### Patch Changes

- [#29](https://github.com/DavideCarvalho/adonis-agent/pull/29) [`6f0465d`](https://github.com/DavideCarvalho/adonis-agent/commit/6f0465d0fcedd3f826687154f60317d180e56651) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix agent tool-loop dropping tool results. `mapMessages` in the AI SDK adapter skipped `toolResults` on `role: 'user'` messages (early `continue`), but `agent-loop` feeds tool output back as a synthetic `{ role: 'user', content: '', toolResults }` carrier — so the results were silently dropped and the follow-up model call threw `AI_MissingToolResultsError`. The user branch now emits the `tool` result message (via a shared `pushToolResults` helper) and skips the empty user turn so the tool result stays adjacent to the assistant tool-call. Multi-step tool-calling now completes for OpenAI-compatible providers.

## 0.10.0

### Minor Changes

- [#27](https://github.com/DavideCarvalho/adonis-agent/pull/27) [`426b504`](https://github.com/DavideCarvalho/adonis-agent/commit/426b5040203fae41bb6a6fcc79ac5dbc0e9bc0ad) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Novas bases kind-específicas `ReadTool` e `ActionTool` (além do `BaseTool`): fixam o `kind` no base, então a subclasse escreve `static tool = { name, description, input, ability }` **truly bare** — sem `satisfies AiToolOptions` e sem a anotação `: AiToolOptions`. Antes o `kind: 'read' | 'action'` do `BaseTool`/`AiToolOptions` forçava um dos dois (a estática herdada não dá contextual-typing, então o literal alargaria `kind` para `string`). A descoberta lê o `kind` da estática do base. Exporta também `BaseToolOptions` (= `Omit<AiToolOptions, 'kind'>`).

## 0.9.0

### Minor Changes

- [#25](https://github.com/DavideCarvalho/adonis-agent/pull/25) [`e726f1f`](https://github.com/DavideCarvalho/adonis-agent/commit/e726f1fdcc13e479ffc10c150dc4148bc18efdfb) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Novo `BaseTool` (classe base opcional para a forma de classe de um tool) — o análogo do `BaseWorkflow` do durable. Declarar `static tool = { … }` numa subclasse de `BaseTool` é type-checado pela estática herdada (`static tool?: AiToolOptions`), sem precisar de `satisfies AiToolOptions`. `ToolHandler<I, O = unknown>` e `defineTool<I, O>` passam a tipar o retorno do `execute` (antes `Promise<unknown>`), então o compilador confere o corpo contra o que o tool promete. Ambos non-breaking (defaults preservam o comportamento anterior).

## 0.8.0

### Minor Changes

- [#23](https://github.com/DavideCarvalho/adonis-agent/pull/23) [`19c9ffd`](https://github.com/DavideCarvalho/adonis-agent/commit/19c9ffd9c285c7cab4e487c8bda73f7ce668be9e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `authzActorResolver` (exported from `@adonis-agora/agent/authz`) — resolve the agent `Actor` from the Agora context populated by authkit (`userRef`, `tenantId`) plus authz `effectiveRoles` (the union global ∪ app ∪ store). Structural, zero hard dependency; authkit+authz apps can drop hand-written actor resolvers. Fail-closed: no identity in context → 401.

## 0.7.1

### Patch Changes

- [#21](https://github.com/DavideCarvalho/adonis-agent/pull/21) [`d02b26b`](https://github.com/DavideCarvalho/adonis-agent/commit/d02b26bea2acd8d6f7daac166116a6813d321a02) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Internal: simplify `readAiToolMeta` metadata resolution

  Refactor the tool-metadata lookup so the two authoring mechanisms (`@AiTool`
  decorator and `static tool`) and the two subjects (the value, its constructor)
  are composed explicitly — `metaOn(target) ?? metaOn(ctor)` — instead of a flat
  four-way fallback chain. No behavior or API change; discovery of both forms is
  unchanged (mutation-proven).

## 0.7.0

### Minor Changes

- [#19](https://github.com/DavideCarvalho/adonis-agent/pull/19) [`c3d7b14`](https://github.com/DavideCarvalho/adonis-agent/commit/c3d7b140cdf32ef4324e18d84a13860ff0eb1a7c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add a decorator-free `static tool` authoring form for class tools

  A tool class can now declare its metadata with a `static tool = { name, kind, description, input, … }`
  config instead of the `@AiTool({ … })` decorator — the same shape, mirroring
  `@adonis-agora/durable`'s `static workflow`. Discovery, registration, and execution are identical;
  `readAiToolMeta` now reads the static config when no decorator is present.

  ```ts
  import type {
    AiToolCtx,
    AiToolOptions,
    ToolHandler,
  } from "@adonis-agora/agent";
  import { z } from "zod";

  export default class GetWeather implements ToolHandler<{ city: string }> {
    static tool = {
      name: "getWeather",
      kind: "read",
      description: "Get the weather",
      input: z.object({ city: z.string() }),
    } satisfies AiToolOptions;

    async execute(input: { city: string }, ctx: AiToolCtx) {
      return { tempC: 21 };
    }
  }
  ```

  The `@AiTool` decorator and the functional `defineTool(...)` forms are unchanged.

## 0.6.0

### Minor Changes

- [#17](https://github.com/DavideCarvalho/adonis-agent/pull/17) [`ea6122f`](https://github.com/DavideCarvalho/adonis-agent/commit/ea6122f468f5308d3506461fb2bd2d7fc3159ef5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Owner-scope the per-actor run/thread routes (object-level authorization)

  Follows up `0.5.0` (which authenticated these routes) by adding the ownership check: authentication
  alone let any authenticated caller act on ANOTHER actor's run/thread by id. Now a caller may act only
  on runs/threads it OWNS, unless it is governance-privileged.

  - **Run routes** — `GET /agent/chat/:runId/stream`, `POST /agent/chat/:runId/cancel`,
    `POST /agent/tool-call/approve`, `POST /agent/tool-call/reject` — now assert the resolved actor owns
    the run (the run's `actor_ref`, recorded as the loop's first step). A non-owner gets `403`; an
    unknown run gets `404` (so an id the caller doesn't own is never confirmed).
  - **Thread routes** — `GET /agent/threads/:id`, `DELETE /agent/threads/:id`,
    `POST /agent/threads/:id/fork-from/:messageId`, and `POST /agent/chat` when it continues an existing
    thread (`body.threadId`) — now assert the actor owns the thread. The chat case is the important one:
    without it an authenticated caller could pass another actor's `threadId` to load that thread's full
    history into the model (and read it back over SSE) and append its own turn into the victim's thread.
  - **Cross-actor override.** A caller that passes `governanceAuthorize` (the app's "may act across
    actors" seam, typically an ADMIN check) may act on any run/thread. With no `governanceAuthorize`
    configured, ownership is strict — no cross-actor access.

  New `AgentStore` SPI methods back the checks: **`getRunActorRef(runId)`** and
  **`getThreadActorRef(threadId)`** (both return the owning `actor_ref` or `null`), implemented on the
  Lucid and in-memory stores. A custom `AgentStore` implementation must add them. Also exposes the
  router-free `evaluateOwnership` helper and the `OwnershipVerdict` type, and `AgentService.runOwner` /
  `AgentService.threadOwner` passthroughs.

## 0.5.0

### Minor Changes

- [#14](https://github.com/DavideCarvalho/adonis-agent/pull/14) [`5de6247`](https://github.com/DavideCarvalho/adonis-agent/commit/5de6247c95a1f92fc92ba89bd1eaa2e89d0ba4ba) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Authenticate the mutation/lifecycle routes and gate the cross-actor governance read-model

  Closes a privilege gap surfaced the first time the routes were mounted behind a real app's
  auth. Previously several `/agent/*` routes were reachable without resolving an actor, and the
  `/agent/governance/*` read-model was readable by any authenticated caller regardless of role.

  - **Every `/agent/*` route now resolves the actor (401 on failure).** `chat/:runId/stream`,
    `chat/:runId/cancel`, `tool-call/approve`, `tool-call/reject`, `threads/personas/catalog`,
    `threads/:id` (GET/DELETE), and `threads/:id/fork-from/:messageId` previously ran with no
    actor resolution — an anonymous same-origin request could re-attach a run's token stream,
    cancel a run, or deliver a HITL approve/reject decision. They now go through the same resolver
    (and 401) as `chat`/`threads`/`quota`. The stream route authenticates via the request's
    session/cookies, so an `EventSource` re-attach still works. Apps that configured an
    `actorResolver` (the norm) are unaffected on legitimate calls; an app with no resolver now
    correctly 401s these routes instead of serving them anonymously.

  - **New `governanceAuthorize?: (actor, ctx) => boolean | Promise<boolean>` config option.** When
    set, each `/agent/governance/*` route runs it after resolving the actor and replies `403` on
    deny (fail-closed if it throws) — so the platform-wide spend/usage/threads/approvals read-model
    can be restricted (typically ADMIN-only). Omitted, governance stays readable by any resolved
    actor (the historical behavior). Mirrors `@adonis-agora/agent-dashboard`'s `authorize` hook so
    the JSON routes and the console SPA can be gated with the same predicate. Exposed as
    `evaluateGovernanceGate` (a router-free, unit-tested helper) and the `AgentGovernanceAuthorize`
    / `GovernanceGateVerdict` types.

  - **New `GET /agent/approvals/mine` route.** Returns the calling actor's OWN pending HITL
    approvals (`pendingApprovals({ actor })`, filtered by the owning run's `actor_ref`). It is
    mounted with the governance read-model but is NOT behind `governanceAuthorize`, so a non-admin
    surface (e.g. a coordinator's chat) can poll its own suspended tool calls even while the
    cross-actor `governance/approvals/pending` inbox is ADMIN-only.

## 0.4.1

### Patch Changes

- [#8](https://github.com/DavideCarvalho/adonis-agent/pull/8) [`8763c29`](https://github.com/DavideCarvalho/adonis-agent/commit/8763c29c43c4f766bc3f80e25d6e19f4e0c8aa6e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix `app/agent_tools` discovery registering nothing in a dev/TypeScript app

  The `app/agent_tools` scanner picked which module extension to import from
  `extname(import.meta.url)` — the extension of the SCANNER's own file. Since the
  package ships compiled (`.js`), that was always `.js`, so an app running from
  TypeScript source under a loader (`app/agent_tools/*.ts`, no build barrel wired)
  had its directory scanned for `.js` files, matched none, and registered zero
  tools — the agent silently ran with an empty `ToolRegistry`.

  The extension is now derived from what the scanned directory actually holds
  (`.ts` when it has any non-declaration `.ts` file, else `.js`). At runtime an app
  runs from EITHER its source or its build — never both in one directory — so this
  still guarantees a built `.js` and a dev `.ts` of the same module never
  double-register. `.d.ts` declarations are still skipped.

## 0.4.0

### Minor Changes

- [#6](https://github.com/DavideCarvalho/adonis-agent/pull/6) [`363382b`](https://github.com/DavideCarvalho/adonis-agent/commit/363382b5bd182f8de6184cd1c509209113710111) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `pricingStore` and `governanceQueries` now default to mirroring the main `store`.

  When `store` is a `stores.lucid()` store, the agent now defaults the pricing store and the governance read-model to a Lucid store on the **same connection** (tables auto-created) with no extra config — so cost tracking and the `/agent/governance/*` routes work out of the box. Previously both were opt-in and omitting them left cost `null` and the governance routes unmounted.

  - Override by passing a factory/instance as before (e.g. a different connection, or `pricingStores.memory()` for tests).
  - Set `pricingStore: false` / `governanceQueries: false` to disable (cost stays `null`; governance routes not mounted).
  - When the main store is not Lucid, both stay off unless set explicitly.

  Adds `lucidStoreConnection(factory)` to read a `stores.lucid()` factory's connection (used internally for the mirroring). The `@adonis-agora/agent` peer range on `@adonis-agora/agent-dashboard` widens to `^0.4.0`.

## 0.3.1

### Patch Changes

- [#4](https://github.com/DavideCarvalho/adonis-agent/pull/4) [`487ad72`](https://github.com/DavideCarvalho/adonis-agent/commit/487ad7265d512ab27b67a5b25802591f8719923c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix an app-boot crash when configuring the Lucid store, pricing store, or governance read-model via the factory helpers.

  `stores.lucid()`, `pricingStores.lucid()`, `governanceQueries.lucid()`, and the pgvector retriever resolved the Lucid `Database` from `@adonisjs/lucid/services/db`'s default export. AdonisJS assigns that default only inside `app.booted()` — after every provider's `boot()` — but the agent provider builds these stores eagerly during its own `boot()`, so the default was still `undefined` and `db.connection(...)` threw a `TypeError`, failing the whole app boot. They now resolve the `Database` from the container via the `'lucid.db'` alias (registered in the database provider's `register()`, so it is available during boot) — the same binding `services/db` itself resolves. No public API change.

## 0.3.0

### Minor Changes

- [#2](https://github.com/DavideCarvalho/adonis-agent/pull/2) [`3ed796f`](https://github.com/DavideCarvalho/adonis-agent/commit/3ed796f5106416726526651088fb98c1d2495172) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `autoCreateTables` now defaults to **`true`** for the Lucid stores — the agent lib manages its own
  schema by default, completing the ecosystem convention (mirrors `@adonis-agora/durable` and
  `@adonis-agora/authz`). On first use a store provisions the six shared agent tables with `CREATE
TABLE IF NOT EXISTS`; set `autoCreateTables: false` (on `stores.lucid`, `pricingStores.lucid`, or
  `governanceQueries.lucid`) to opt out and run the published migration instead.

  Crucially, provisioning is no longer the agent store's job alone: the **pricing store** and the
  **governance read-model** also auto-provision on first use, sharing one memoized `CREATE TABLE` pass
  per db client (new exported `ensureAgentTables`). This closes two real gaps — seeding model prices
  before the first agent run, and opening the governance dashboard on a fresh deploy — that the
  store-only auto-create left broken.

  The dashboard's peer range is bumped to `@adonis-agora/agent@^0.3.0`.

## 0.2.0

### Minor Changes

- [`f1fea00`](https://github.com/DavideCarvalho/adonis-agent/commit/f1fea00e165ef6d106fa67ed9ceda6e03ddbca3b) - Suporta `@adonis-agora/durable` 0.8.x (o peer passa de `^0.7.0` para `^0.8.0`).

  O durable 0.8.0 removeu o decorator `@Workflow`, que o `AgentRunWorkflow` usava, em favor de
  `BaseWorkflow` + `static workflow = { name, version }`. Instalar agent 0.1.0 ao lado de durable
  0.8.0 derrubava o modo durable inteiro — `TypeError: (0 , Workflow) is not a function` ao carregar
  o módulo, com o provider caindo silenciosamente no runner inline. O `^0.7.0` barrava a combinação,
  então ninguém instalou os dois juntos; o preço era ficar preso ao durable 0.7.

  O `AgentRunWorkflow` agora estende `BaseWorkflow` e declara `static workflow`. O resto da
  integração (`WorkflowEngine.start/signal/cancel`, `registerWorkflowClass`, `WorkflowSuspended`,
  `ContinueAsNew`, `WorkflowCtx`) não mudou.

  O bug nasceu de um vão de teste: o `durable` não era devDependency, então o lockfile resolvia
  0.7.0 e a suíte exercitava o runner durable contra a versão antiga — verde e cega para o 0.8.0.
  Agora é devDependency em `^0.8.0`, e os testes rodam contra a mesma versão que o peer promete.
