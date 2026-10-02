# Independent action proposals implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. This document is a review proposal; it does not authorize implementation. Track each step with its checkbox and use failing tests before behavior changes.

**Goal:** Permitir continuar a conversa enquanto uma ação aguarda decisão, com propostas persistentes, execução recuperável e sem efeito duplicado nos servidores Aviary/Nest e Agora/Adonis.

**Architecture:** A proposta é um recurso persistente separado do run que a apresentou. Decisão e execução possuem estados distintos; a decisão aceita e seu trabalho persistente de execução são gravados atomicamente. Um worker revalida a ação e admite o resultado na conversa de forma serializada, sem criar mensagens de ferramenta órfãs.

**Tech Stack:** TypeScript, Standard Schema, Vitest, runners inline/durable, Lucid, Drizzle, MikroORM, React compartilhado e testes de contratos em bancos reais.

## Limites e comportamento aprovado para revisão

Este plano cobre propostas independentes. Transporte de texto, interpretação de respostas em linguagem natural e capacidades de clientes são etapas posteriores. Não implementar handlers de canal ou negociar capacidades nesta etapa.

O caminho independente será opt-in por configuração explícita. Runs antigos continuam com `awaitDecision` e seus checkpoints/sinais existentes. Nenhum replay antigo é reinterpretado como proposta independente; o modo escolhido acompanha o journal de runs novos. Ausência das capacidades transacionais exigidas no store impede habilitar esse modo, com erro de configuração claro.

Uma proposta nova informa ao modelo e ao transcript o fato verdadeiro: a ação foi proposta e aguarda decisão. O turno termina normalmente e libera a conversa para mensagens e filas seguintes. Esse fato não é sucesso de execução e não deve ser representado como efeito concluído. Rejeição, expiração e substituição também são fatos de decisão, distintos de falha de execução.

## Contrato de dados e invariantes

Definir os nomes públicos finais na revisão pareada; os tipos abaixo fixam a semântica, não a sintaxe definitiva:

```ts
type ProposalDecision = 'pending' | 'approved' | 'rejected' | 'expired' | 'superseded'
type ProposalExecution = 'queued' | 'executing' | 'succeeded' | 'failed'

interface ProposalScope {
  tenantRef: string | null
  actorRef: string
  threadId: string
}

interface ActionProposal {
  id: string
  scope: ProposalScope
  originRunId: string
  originMessageId: string
  originToolCallId: string
  toolName: string
  input: unknown
  confirmation?: ToolConfirmation
  approver: string
  expiresAt?: string
  decision: ProposalDecision
  // Ausente antes de aprovação; nunca usar queued para uma proposta apenas pending.
  execution?: ProposalExecution
  idempotencyKey: string
  supersessionKey?: string
  supersededBy?: string
}
```

- Uma aprovação muda somente `pending → approved` e cria o trabalho de execução `queued` na mesma transação. Falha entre essas duas escritas não pode deixar uma ação aprovada sem trabalho recuperável.
- Decisão terminal é imutável. CAS usa escopo, id, versão/estado e validade; decisões duplicadas retornam a decisão existente sem produzir outro trabalho. Uma decisão conflitante recebe resposta de conflito explícita.
- Autorizar acesso pelo tenant/ator/thread e autorizar o aprovador antes do CAS. Id isolado nunca concede acesso. A definição de tenant ausente deve preservar isolamento e não permitir colisões por regras de unicidade de `NULL`.
- Relógio e comparação de expiração têm uma regra única no store; o limite é `now >= expiresAt`. CAS de aprovação e expiração competem na mesma autoridade persistente.
- `idempotencyKey` é estável por proposta e permanece igual em retries, recuperação de lease e execução em outra réplica. Não é derivada do run de retomada.
- O worker obtém lease/CAS de trabalho, revalida disponibilidade, roles, `canUse`, allow-lists, schema e preflight `execute` com o contexto atual. `completed` resolve sucesso sem nova escrita; `denied` resolve execução `failed` com motivo de domínio, mantendo decisão `approved`.
- Leases recuperam trabalho abandonado; não garantem exatamente uma escrita. Uma queda após efeito e antes do journal requer idempotência/transação no domínio. Resultados e fatos da conversa têm chave de deduplicação persistente.

## Mapa de arquivos

| Responsabilidade | Aviary/Nest | Agora/Adonis |
| --- | --- | --- |
| Contratos, contexto e loop | `packages/core/src/spi/agent-store.ts`, `packages/core/src/types.ts`, `packages/core/src/agent-loop.ts`; novo `packages/core/src/spi/action-proposal-store.ts` | `packages/adonis/src/spi/agent-store.ts`, `packages/adonis/src/types.ts`, `packages/adonis/src/agent-loop.ts`; novo `packages/adonis/src/spi/action-proposal-store.ts` |
| Persistência e migração | `packages/store-drizzle/src/`, `packages/store-mikro-orm/src/entities/`, provisionamento existente; novos testes de contrato | `packages/adonis/src/stores/lucid.ts`, `lucid-schema.ts`, stub delegado e testes reais de schema/store |
| Memória para testes | `packages/core/src/in-memory-store.ts` | `packages/adonis/src/testing/in-memory-store.ts` |
| Decisão, workers e filas | `packages/nestjs/src/`, runners inline/durable e rotas existentes; novo serviço de propostas | `packages/adonis/src/agent-service.ts`, runners inline/durable e rotas existentes; novo serviço de propostas |
| Wire e apresentação | eventos core, `packages/react/src/approvals/` e transcript compartilhado | eventos/SSE/client nativo e uso do mesmo React publicado |

Definir módulos pequenos de proposta, claim de trabalho e admissão de resultado. Reusar autorização, preflight, gates e serialização existentes; não duplicar o loop inteiro nem introduzir uma segunda UI React no Agora.

## PR pareado 1 — Contratos e persistência transacional

Pode ser entregue antes de habilitar comportamento novo. Cada par de PRs inclui a mesma API e os mesmos testes de contrato em todos os stores.

- [ ] Escrever testes de contrato que falham para criação escopada, snapshot da confirmação, decisão CAS, trabalho único e listagem/leitura isoladas.
- [ ] Implementar tabelas/entidades de propostas e trabalho/outbox, índices e migrações aditivas. Reusar identificador determinístico para replay de criação; reexecutar criação não duplica proposta/cartão.
- [ ] Implementar aprovação + enqueue persistente na mesma transação e confirmar rollback completo com falha injetada entre as escritas.
- [ ] Implementar rejeição, expiração e leitura da decisão existente; aprovar contra relógio expirado não cria execução.
- [ ] Implementar claim/lease com fencing ou CAS, recuperação de lease e transições de execução sem mudar decisão.
- [ ] Rodar os mesmos contratos em memória, Lucid, Drizzle e MikroORM. Testar instalação vazia, schema antigo e provisionamento repetido.
- [ ] Documentar limitações transacionais e idempotência; adicionar changesets e revisar paridade de tipos/erros. Abrir PRs pareados somente após validação.

## PR pareado 2 — Worker e caminho independente opt-in

Depende dos contratos transacionais do PR 1. Continua desabilitado por padrão.

- [ ] Escrever teste de um turno que apresenta proposta, termina com fato pending e permite uma nova mensagem antes de qualquer decisão.
- [ ] Escrever replay de run antigo com `awaitDecision`, garantindo nomes/posições/sinais idênticos. Testar troca de configuração durante run sem mudar o caminho journaled.
- [ ] Introduzir opt-in validado contra capacidades do store; criar proposta no checkpoint existente apropriado e concluir o turno sem esperar clique.
- [ ] Adaptar rotas de decisão para proposta, preservando autorização e decisão CAS; não confiar em input, confirmação, ator ou tenant fornecidos pelo cliente.
- [ ] Implementar worker recuperável com contexto original escopado e autorização atual. Reusar registry/invoke e impedir retry de recusa de preflight.
- [ ] Testar allow-list/flag/role/`canUse` alterados depois de aprovação, schema inválido, domínio mudado, duplicate completed e idempotencyKey igual após restart.
- [ ] Implementar outbox/admissão de resultado persistente com chave única por proposta e versão de outcome. Não marcar resultado admitido antes de persistir o fato da conversa.
- [ ] Serializar admissão com envio de usuário, fila da conversa e outros resultados por thread. Um worker não sobrescreve turno ativo nem cria duas continuações para o mesmo resultado.
- [ ] Implementar adapter de histórico para providers: toda mensagem `tool` deve corresponder a uma chamada no contexto apresentado. Para conversa que já avançou, usar evento/fato ou continuação com pares válidos, sem inserir resultado órfão de chamada antiga.
- [ ] Testar stop do run original, cancelamento explícito de proposta, restart entre CAS e dispatch, crash após efeito, entrega duplicada e resultado durante turno ativo.
- [ ] Revisar narrativa: pending/queued/executing/succeeded/failed nunca são confundidos. Documentar e abrir o segundo par de PRs após validação.

## PR pareado 3 — Supersession explícita e UI

Depende dos PRs 1/2. Chave de substituição é declarada pela aplicação, nunca inferida pela biblioteca a partir de similaridade textual.

- [ ] Definir namespace e chave escopados por `(tenant, actor, thread, tool/namespace, supersessionKey)`. Propostas sem chave não substituem outras; chaves iguais em outro escopo não interferem.
- [ ] Escrever testes de criação concorrente com mesma chave, clique no cartão antigo durante substituição, aprovação versus expiração e aprovação versus supersession.
- [ ] Implementar criação + supersession do pending anterior atomicamente. Registrar `supersededBy`, motivo e ordem autoritativa; cartão velho não pode voltar a pending.
- [ ] Definir regra de corrida: se aprovação venceu CAS, a proposta aprovada não é silenciosamente substituída/cancelada; se supersession venceu, aprovação do antigo falha e não enfileira trabalho. Execução iniciada exige cancelamento explícito separado, quando suportado.
- [ ] Expor estados de decisão e execução, validade e nova proposta no wire e histórico. Consumir no React compartilhado e cliente nativo com campos opcionais compatíveis.
- [ ] Renderizar pending com ação clara, approved/queued e executing sem prometer sucesso, rejected/expired/superseded sem botão ativo, failed com motivo e succeeded com resultado confirmado. Nunca executar novo retry automaticamente pela UI.
- [ ] Testar reload, múltiplas abas, stream reconectado, cliques duplicados e atualização de cartão durante outra mensagem. Validar acessibilidade e countdown pelo horário persistido.
- [ ] Documentar API de chave, erros de conflito e regras de cancelamento; adicionar changesets e abrir o terceiro par de PRs após validação.

## Matriz obrigatória de concorrência e recuperação

| Cenário | Evidência esperada |
| --- | --- |
| Dois aprovadores/réplicas simultâneos | Um CAS vencedor e um único trabalho persistido |
| Aprovação versus expiry no limite | Uma decisão terminal, nenhum enqueue tardio |
| Aprovação versus supersession | Regra explícita acima, sem execução de proposta substituída |
| Duas propostas com mesma chave | Ordem determinística no store, no máximo um pending naquele escopo |
| Tenant/ator/thread distintos e ids reutilizados | Nenhuma leitura, decisão ou substituição cruzada |
| Worker cai depois de claim | Lease recuperado com a mesma idempotencyKey |
| Worker cai depois do efeito | Domínio deduplica; biblioteca não promete exatamente uma escrita |
| Stop, restart e processo sem handler local | Proposta/work sobrevivem; worker autorizado executa ou resolve erro sem reabrir decisão |
| Resultado chega durante turno/fila ativos | Admissão serializada, deduplicada e sem perda de mensagem |
| Provider recebe história continuada | Nenhum tool-result órfão; adapter exercitado por contratos de providers |
| Duas réplicas com bancos reais | CAS/uniqueness/leases comprovados em PostgreSQL, MySQL e SQLite suportados |
| Upgrade com runs em `awaitDecision` | Checkpoints antigos continuam válidos e não entram no modo novo |

Usar barreiras controladas em testes de corrida, não apenas sleeps. Exercitar transações reais e conexões/processos independentes; um mutex em memória não comprova segurança entre réplicas.

## Validação e critério para iniciar a implementação

- [ ] Revisar este plano com foco no contrato de opt-in, escopo, CAS transacional, admissão ao transcript e precedência das corridas.
- [ ] Registrar a decisão de revisão; somente depois implementar um PR pareado por vez.
- [ ] Para cada par, mostrar testes falhando antes da alteração, passar testes de contratos e runners, matrix de DBs, typecheck, build, lint e compatibilidade de wire/React.
- [ ] Revisar diffs e documentação nos dois repositórios, abrir e vincular PRs pareados no T3. Não mergear/publicar automaticamente.
- [ ] Propor etapas posteriores de transporte textual e capacidades dos clientes separadamente, após este ciclo.
