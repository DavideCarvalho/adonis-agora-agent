---
'@adonis-agora/agent': minor
---

`@adonis-agora/agent/evals` — nota de qualidade sobre os runs que já estão gravados.

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
