# Action preflight parity implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Antes de pedir aprovação ou executar uma ação, validar seus dados no domínio e apresentar uma confirmação específica da chamada, com a mesma API e comportamento na Aviary e no Agora.

**Architecture:** Hook opcional de ferramenta, validado pelas mesmas gates de invoke, com resultado discriminado. A preparação acompanha um checkpoint já existente de modelo/claim, escolhido conforme a fronteira de processo do runner; a segunda checagem vive no checkpoint de execução. A UI e o wire têm um único contrato compartilhado; cada backend persiste os mesmos dados.

**Tech Stack:** TypeScript, Standard Schema, Vitest, runners inline/durable, Lucid, Drizzle, MikroORM, React compartilhado.

## Contrato público

```ts
export type ToolPreflightResult<O = unknown> =
  | { status: 'ready'; confirmation?: ToolConfirmation }
  | { status: 'denied'; reason: string }
  | { status: 'completed'; output: O }

export interface ToolPreflightOptions {
  phase: 'prepare' | 'execute'
}

// ToolHandler<I, O>
preflight?(
  input: I,
  ctx: AiToolCtx,
  options: ToolPreflightOptions,
): ToolPreflightResult<O> | Promise<ToolPreflightResult<O>>
```

`confirmation` usa `ToolConfirmation` existente, com strings já resolvidas. Ela substitui os templates estáticos somente para a chamada; não altera a apresentação da ferramenta no catálogo. `completed` informa um efeito que o domínio confirmou existir; não significa que a biblioteca executou uma nova escrita. Hooks só se aplicam a actions.

## Task 1 — Aviary: contrato, gates e ciclo da ação

**Files:** `packages/core/src/spi/tool.ts`, `tool-registry.ts`, `agent-loop.ts`, authoring de ferramenta funcional, exports e testes de registry/loop.

- [x] Executar baseline focal de approvals e registry.
- [x] Escrever os cenários abaixo antes da implementação e verificar que falham pelo comportamento ausente.

```ts
// Cenário principal: o domínio já tem o reembolso.
const handler = {
  preflight: () => ({ status: 'completed' as const, output: { refunded: true } }),
  execute: () => { throw new Error('duplicate effect') },
}
// Usar o harness existente para registrar refund/action e rodar um turno.
// Assert: resultado refunded:true, nenhum approval-requested, execute nunca chamado.
```

- [x] Expor o contrato acima para classes e ferramentas funcionais.
- [x] Executar gates e parsing antes de `prepare`; retornar denied/completed sem cartão.
- [x] Journalizar preparação no checkpoint existente de modelo/claim; quando o worker que ofereceu a ferramenta difere do coordenador, enviar o resultado confiável no retorno journaled do modelo e consumi-lo no claim. Sobrescrever qualquer stamp vindo do provider. Não inserir checkpoint incondicional em runs antigos.
- [x] Checar `execute` após autorização e parsing atuais, dentro da invocação, também em chamada direta/MCP.
- [x] Testar aprovação automática e lembrada, input inválido, gates recusadas, hook que lança, domínio mudado entre cartão e clique e replay.
- [x] Recusa do domínio nunca faz retry, mesmo com motivo contendo deadlock ou classificador customizado aceitando todos os erros. Escapar outputs comuns com marcadores internos; replays de journals antigos continuam legíveis.

## Task 2 — Aviary: cartão, persistência e React

**Files:** protocolo/eventos/tipos core, store SPI, packages/store-drizzle e packages/store-mikro-orm, React transcript/approvals/presentation, testes de store e durable.

- [x] Teste inicial: preparar confirmação `Refund order 7?`; stream e histórico preservam o texto, inclusive após replay/reload.
- [x] Adicionar `confirmation?: ToolConfirmation` ao pedido de aprovação e à leitura persistida.
- [x] Persistir confirmation no registro da chamada sem quebrar linhas antigas (campo nullable).
- [x] Consumir o override no React, com fallback aos templates estáticos para cartões sem override.
- [x] Validar paridade de stores, testes de renderer e persistência de confirmação.
- [x] Documentar API, adicionar changesets e passar checks focais, typecheck e lint dos arquivos alterados.

## Task 3 — Agora: mesma API e comportamentos

**Files:** `packages/adonis/src/spi/tool.ts`, `ai-tool-ref.ts`, `tool-registry.ts`, `agent-loop.ts`, `spi/agent-store.ts`, `spi/approval-policy.ts`, `types.ts`, `stream-events.ts`, `spi/token-stream-sink.ts`, `stores/lucid{,-schema}.ts`, `testing/in-memory-store.ts`, migration stub, testes approvals/registry/durable/store e docs.

- [x] Executar baseline focal de approvals e registry.
- [x] Repetir os cenários de falha antes da implementação.
- [x] Adaptar o mesmo contrato às gates e checkpoints do Agora, preservando variantes de persona e retry. Preparar na origem do resultado journaled de modelo para preservar a retomada por um processo sem ferramenta registrada antes do primeiro claim; não adicionar transporte remoto onde o runner não o tem.
- [x] Acrescentar confirmation ao wire e histórico, com coluna nullable e provisionamento/migração consistente.
- [x] Usar a camada React compartilhada; verificar com build local da Aviary sem gravar paths locais nas dependências publicadas.
- [x] O cliente nativo sem React preserva confirmação, aprovador, validade e motivo. Ferramentas sem hook e frames antigos mantêm campos opcionais ausentes quando não fornecidos.
- [x] Documentar, adicionar changeset e passar checks focais, typecheck e lint dos arquivos alterados.

## Task 4 — Revisão e entrega pareada

- [x] Revisão de requisitos: nenhuma action automática/lembrada pula preflight; replay não recalcula cartão; denied/completed não criam efeito; gates atuais continuam aplicadas.
- [x] Revisão de qualidade: tipos equivalentes nos dois repos, sem `as any`, sem duplicar React/catalog, sem checkpoints incompatíveis e sem prometer exatamente uma escrita sob crash.
- [x] Rodar testes focais finais e checks completos apropriados em cada repo. Registrar comandos e resultados reais.
- [x] Criar PRs pareados e registrar ambos no T3. Não mergear nem publicar automaticamente.
- [x] Mostrar plano detalhado da próxima etapa: propostas independentes, estados e corridas nos dois servidores.

## Evidência da entrega — 2026-10-01

- Aviary/Nest: suíte completa final com 2818 testes passando; typechecks e build finais passaram.
- Agora/Adonis: suíte completa final com 1776 testes passando e 89 skipped; typecheck e build finais passaram. Os três failures encontrados na primeira rodada foram corrigidos e a suíte completa foi reexecutada.
- PRs pareados abertos e vinculados no T3: [Nest #283](https://github.com/DavideCarvalho/nestjs-agent/pull/283) e [Agora #274](https://github.com/DavideCarvalho/adonis-agora-agent/pull/274). Sem merge/publicação automática.
- Próxima etapa documentada em [independent-proposals](2026-10-01-independent-proposals.md), somente para revisão; implementação ainda não iniciada.
