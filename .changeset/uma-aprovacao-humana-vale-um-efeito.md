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

## Um run delegado pode ser respondido

Um sub-agente estaciona numa espera real — `tool:<childRunId>:<callId>` — e a linha pendente que ele
escreve carrega esse runId, então a caixa de aprovações sempre soube respondê-la. O que faltava não
era o caminho de volta: era o **id**. Quem olha assiste ao stream de TOPO, porque é o único stream a
que alguém assina; o filho encaminha os frames pra lá (é para isso que `sinkRunId` existe), e um
formulário sem run id é um formulário que quem olha vê e não consegue responder.

Então o id passa a viajar NO frame. Os dois frames de trabalho estacionado o carregam:

| Evento SSE | Payload | Responde com |
| --- | --- | --- |
| `event: approval` | `{runId, id, toolName, input}` | `POST /agent/tool-call/approve` \| `/reject` |
| `event: elicitation` | `{runId, id, request}` | `POST /agent/tool-call/answer` \| `/skip` |

`event: approval` é novo: uma `action` estacionada não tinha frame nenhum, só a linha
`pending_approval`. É escrito de DENTRO do checkpoint `persist:toolcall:<callId>`, então não gasta
posição própria e um replay — que devolve aquele checkpoint memoizado — nunca re-posta um formulário
para uma decisão já tomada. E `runId` é o run ESTACIONADO, não o stream em que o frame chegou: ler o
run do frame `meta` sinalizaria o ancestral e deixaria o filho suspenso. `decodeFrame` no cliente
aprendeu os dois eventos — antes ele descartava `elicitation` inteiro — e descarta um frame sem
`runId` em vez de entregar um que não dá para acionar.

O runner inline passa a espelhar isso: o loop aninhado escreve no sink do ancestral via
`childSinkWriter` e estaciona em `${childRunId}:${toolCallId}`, em vez de auto-declinar. Um
comportamento, nos dois runners — e um sub-agente cujas aprovações ninguém vai responder **fica
pendurado**, exatamente como um agente de topo. Se um job delega, mantenha tools de aprovação fora do
sub-agente (`tools:` na definição dele).

Os docs afirmavam o auto-declínio em três lugares (`docs/programmatic-api.mdx`,
`docs/concepts/agent-loop.mdx`, `docs/authoring/personas-and-agents.mdx`) — era essa afirmação que
estava errada, não o comportamento do durável. Nenhum marcador `patched` é gasto: a forma do journal
do filho não muda.

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
