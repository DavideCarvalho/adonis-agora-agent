---
'@adonis-agora/agent': patch
---

O docblock de `AgentRunner` descreve a fiação deste pacote, não a da referência Nest.

Três nomes que não existem aqui: `AGENT_RUNNER`, que não é chave de binding nenhuma — o
`agent_provider` constrói o runner direto e registra só o `AgentService`; `@dudousxd/nestjs-durable`,
sendo que o peer durável deste pacote é `@adonis-agora/durable`; e o decorator `@Workflow`, que esta
porta não tem — o turno durável é `class AgentRunWorkflow extends BaseWorkflow`, registrada por
`registerWorkflowClass`.
