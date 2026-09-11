---
'@adonis-agora/agent': minor
---

Processadores de entrada e de saída — um seam de cada lado da chamada de modelo, com custo proporcional.

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
