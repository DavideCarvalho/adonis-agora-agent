---
'@adonis-agora/agent': minor
---

Nova seam `HistoryWindow` para compactar o histórico de uma thread antes de cada turno

Sem isso, `runAgentLoop` mapeia a thread PERSISTIDA inteira em `ModelMessage[]` a cada turno — uma thread de vida longa acumula mensagens e o custo/latência de input cresce sem limite, até eventualmente estourar a janela de contexto do modelo.

`AgentConfig.historyWindow` (e o equivalente em `AgentLoopDeps`/`AgentDepsFactoryConfig`) aceita qualquer impl de `HistoryWindow` — mesmo padrão seam do `Retriever` já existente. O pacote traz `SlidingWindowHistory`, um truncador simples que mantém só as últimas N mensagens (padrão 40), sem resumo. Quem quiser sumarização (condensar as mensagens descartadas via um modelo) implementa a interface diretamente.

Aplicado dentro de `hooks.step`, então uma retomada durable reaproveita o MESMO resultado — necessário para uma impl que gasta tokens num modelo não pagar duas vezes no replay.

**Não-quebrante**: sem `historyWindow` configurado, o comportamento é idêntico a antes — histórico completo em todo turno.
