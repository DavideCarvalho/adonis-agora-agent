---
'@adonis-agora/agent': minor
---

Skills: procedimentos autorais que o modelo busca quando a tarefa pede, escopados por tokens que o
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
