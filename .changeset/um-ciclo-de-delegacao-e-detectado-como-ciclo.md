---
'@adonis-agora/agent': minor
---

Um ciclo de delegação é detectado como ciclo — e nada antes disso parava um handoff mútuo.

`delegatesTo` é um grafo, e o modelo não o vê. Num handoff mútuo (alpha entrega pra beta, beta entrega
de volta pra alpha) cada agente faz uma chamada razoável e a recursão é da fiação. O
`delegationDepth` que o runner durável já carregava tinha um comentário dizendo "carregado para um
guard futuro" — ou seja, **não existia guard algum**: o runner inline nem contava, e a única coisa que
terminava uma cadeia cíclica era o `maxSteps` de cada turno somado ao acaso.

Entra `AgentRunInput.delegationPath`, a cadeia de nomes de agente que chegou até este run, com os DOIS
runners acrescentando o próprio agente para cada filho que começam. O loop compara o alvo da
delegação contra essa cadeia mais o próprio agente: uma repetição É o ciclo, nomeada na recusa com
quantas vezes aquele agente já esteve nela.

```
delegation cycle: alpha → beta → alpha — alpha 2 times on one chain
```

`maxAgentAppearances` (padrão 1) conta APARIÇÕES, então 2 admite exatamente um retorno deliberado — o
que um supervisor que de fato devolve trabalho precisa. `maxDelegationDepth` (padrão 5) entra como
backstop para uma cadeia que é longa sem repetir, e é reportado só quando nada é circular. Os dois são
declarados por agente, ao lado do `maxSteps`.

**Por que não bastava contar.** Uma contagem só sabe dizer que a cadeia é LONGA. Ela não sabe dizer
que está andando em círculo, e confundir as duas coisas errava os dois casos: um handoff mútuo
queimava o teto inteiro em turnos de agente antes de reportar uma profundidade que o leitor ainda
tinha que interpretar, e uma cadeia legítima de seis agentes DISTINTOS era recusada por parecer um
ciclo que não era. A cadeia de nomes custa exatamente o que o contador custava para carregar.

A recusa é resolvida dentro do mesmo checkpoint que assenta o kind da call (`persist:toolcall:<id>`),
então o veredito é o que um replay relê — e não algo que cada processo re-deriva a partir de config
local.

Uma diferença deliberada em relação ao porte de referência: a ancestralidade inclui o agente do
PRÓPRIO run. Sem isso, um handoff mútuo de verdade é recusado com `alpha → alpha`, uma aresta que
nenhum deployment declara, porque o salto que fechou o círculo fica de fora da mensagem. Com isso,
uma auto-delegação também passa a ser ciclo na hora, em vez de um salto depois.
