---
'@adonis-agora/agent': minor
---

Memória de trabalho: o que o assistente concluiu sobre uma pessoa e sobre a organização dela,
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
