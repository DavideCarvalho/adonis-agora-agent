---
'@adonis-agora/agent': minor
---

Um run filho grava qual run o delegou.

A aresta pai→filho de uma delegação existia no journal do runtime durável e em nenhum outro lugar.
Toda superfície de confiabilidade e de custo — e todas elas leem LINHAS de run — via o gasto de uma
delegação como um turno órfão: ninguém conseguia somar o que um turno custou de verdade, porque a
parte que ele pediu a outro agente aparecia como um run que ninguém começou. E o journal durável não
é joinable com a tabela de runs, então não havia como recompor a árvore depois.

Entra `RecordRunStartInput.parentRunId` e `AgentRunInput.parentRunId`, preenchido pelos DOIS runners
(o inline em `runNested`, o durável no `ctx.child`), persistido como `agent_run.parent_run_id` pelo
`LucidAgentStore` e pelo store em memória, e devolvido como `RunSummaryRow.parentRunId` —
`null` para um turno que uma pessoa começou.

`createAgentTables` repara a coluna aditivamente num banco que já tem `agent_run`: um
`CREATE TABLE IF NOT EXISTS` não alcança coluna nova em tabela que já existe, e o `ALTER` entra pelo
mesmo caminho que já conserta as colunas `run_id`, com o reparo reportado por nome.

O teste que pega a classe de bug que isto é: a fixture é tipada `Required<RecordRunStartInput>`, então
um campo novo no input FALHA A COMPILAR até que a linha de cada adapter saiba nomeá-lo. E o
threading — a metade que pode estar morta sem falhar nada, porque um store com a coluna e um runner
que nunca a preenche é indistinguível de um deployment em que ninguém delega — é coberto por uma
delegação de verdade pelo `InlineAgentRunner`, perguntando ao read-model qual turno pagou pelo filho.
