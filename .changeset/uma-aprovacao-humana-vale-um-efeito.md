---
'@adonis-agora/agent': minor
---

Uma aprovação humana vale UM efeito, e uma rejeição registrada foi alguém que a fez.

Quatro defeitos no mesmo eixo: o que a biblioteca grava como decisão de uma pessoa, e quantas vezes
um efeito remoto acontece por causa dela. Os dois primeiros **fabricam ou duplicam** uma decisão
humana, que é a classe de falha que nada na frente denuncia.

## Um retry não re-emite uma ação aprovada

`McpToolSource.callTool` envolvia TODA chamada em `invokeWithTransientRetry`. Um timeout, uma conexão
derrubada, um reset no meio do voo, um 500/502/503 — cada um deles é também exatamente como um tool
remoto que **rodou** aparece quando a resposta se perde. Re-emitir em cima disso gasta uma única
aprovação humana em dois efeitos remotos, e nada deste lado fica sabendo: os efeitos de um tool
importado acontecem na máquina de outra pessoa, que é justamente o motivo de ele ser `action` por
padrão.

Agora o classificador depende do `kind`:

| `kind` | Tenta de novo em |
| --- | --- |
| `read` | `isTransientMcpError` — conexão derrubada, timeout, status HTTP retentável, erro de socket |
| `action` | `isPreExecutionMcpError` — só falhas que **provam** que nada rodou: conexão recusada, host nunca resolvido ou alcançado, ou nenhum transporte para enviar |

Passar o próprio `classify` assume esse juízo para todo `kind`, `action` incluído. `isPreExecutionMcpError`
é exportado de `@adonis-agora/agent/mcp-client`.

## Respostas não se tornam uma rejeição

Um conjunto de perguntas estaciona como uma call `action` em `pending_approval` — é o que o põe na
caixa de aprovações que o deployment já tem. O custo é que um canal carrega duas formas, então um
cliente consegue endereçar `POST /agent/tool-call/answer` a uma call que na verdade espera um
approve/reject. `ElicitationReply` não carrega `approved`, e `!undefined` é `true`: a linha virava
`rejected`, uma decisão que o operador nunca tomou e que nada depois distingue de uma que ele tomou.

A redução vale em UM sentido só. Um sim/não pode ser lido como "confirmou as respostas pré-marcadas";
um conjunto de respostas não diz nada sobre se o trabalho proposto deve seguir. Então é **recusado**,
nunca registrado:

- o runner inline sabe em qual espera o run está parado e responde `409` (`HumanReplyMismatchError`);
- sob o runner durável um sinal não carrega essa pista, então o loop descarta a resposta e o run
  continua parado na aprovação que sempre esperou. Esperar de novo gasta outra posição, e um replay
  se alinha porque a resposta descartada está ela mesma no journal na posição em que chegou.

De qualquer um dos lados a linha segue `pending_approval`, e a aprovação de verdade ainda a assenta.

## Um run delegado não estaciona onde ninguém pode responder

Um sub-agente roda atrás da chamada de tool de outro agente. Ninguém está olhando: o runId dele não é
o stream a que alguém assinou, e os frames que ele escreve chegam no stream do PAI, sob um turno que o
leitor acha que é do agente que ele pediu. O runner inline já decidia isso — declinava e seguia nos
defaults — mas o durável suspendia num `tool:<childRunId>:<id>`, e o frame de elicitation encaminhado
pro stream do pai não carrega run id nenhum pra responder contra. A suspensão não tinha volta, e os
docs em três lugares afirmavam o comportamento do inline como se valesse para os dois.

Um `delegatedRunHooks()` só, instalado pelo loop aninhado do inline e por um `AgentRunWorkflow` filho
igualmente: `action` é declinado (`a delegated sub-agent has no human to ask`), e o hook deliberadamente
NÃO fornece `awaitAnswers`, então um conjunto de perguntas lê aquele declínio como skip e segue nos
próprios defaults. Um comportamento, nos dois runners, para as duas formas de espera.

Um filho que suspendeu numa espera sob o shape antigo continua replayando contra o histórico que tem:
a mudança é guardada por `ctx.patched('agent:delegated-runs-settle-hitl')`, pedido só num filho, então
a sequência de checkpoints de um run de topo é byte-idêntica.

## Um refresh de MCP remove, não só acrescenta

`McpToolImporter.refresh` só somava. Um servidor que remove ou renomeia um tool deixava o spec e o
handler antigos registrados, e o modelo seguia recebendo a oferta de um tool cuja próxima chamada
falha remotamente — segundos depois, na máquina de outra pessoa.

`refresh()` passa a ser a resposta ATUAL do servidor a `tools/list`: o que desapareceu é desregistrado
via o novo `ToolRegistry.unregister(name)`, então chamar aquilo é um `ToolNotFoundError` aqui. Só
nomes que este importer registrou para AQUELE servidor entram — nunca os do app, nunca de outro
servidor — e um nome liberado é reivindicável pelo próximo servidor em ordem de configuração no mesmo
refresh. Um servidor que não pôde ser **alcançado** não poda nada: seus tools são desconhecidos, não
desaparecidos, e uma oscilação de rede não é motivo para retirar do modelo um tool que funciona.

`refresh(name)` para um nome que nenhum servidor aberto casa avisa e retorna `0`, em vez de deixar um
`0` que se lê igual a um servidor que respondeu sem tools.
