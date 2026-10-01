# ActionProposalStore: contrato da entrega de persistência

O usuário autorizou continuar o plano de propostas independentes em 2026-10-01. Esta entrega implementa seu primeiro par: contratos e persistência, sem ativar a execução independente no loop.

`ActionProposalStore` é uma capacidade adicional dos stores de memória, Lucid, Drizzle e MikroORM; `AgentStore` não ganha métodos obrigatórios. Todas as operações recebem escopo completo (`tenantRef`, `actorRef`, `threadId`). O produtor confiável escolhe um id determinístico global e uma chave de idempotência estável. Identidades têm até 255 unidades UTF-16; campos JSON preservam strings, inclusive Unicode e valores escapados.

Criação repetida devolve a proposta original somente quando o snapshot imutável coincide, independentemente da ordem das chaves. Mudança de dados causa conflito, e conflito com outro escopo não divulga a proposta. Leituras/listas devolvem snapshots independentes; listas têm limite padrão 100 e máximo 1000, ordenadas por data e id lógico.

Decisões são primeiras a ganhar: `pending` vira `approved`, `rejected` ou `expired`. `superseded` está reservado para a etapa posterior. Aprovar cria trabalho `queued` no mesmo snapshot, por uma atualização atômica com versão. Decisão final e seu ator/canal/horário/motivo são imutáveis. O relógio é configurado no servidor; em `now >= expiresAt` não se aprova nem rejeita uma proposta pendente.

Claim muda trabalho para `executing`, com token, geração, worker e prazo. Só token/geração atuais e lease válido renovam ou finalizam. Recuperar lease vencido avança a geração e preserva a chave de idempotência. Uma queda depois do efeito pode causar nova entrega: o domínio deve honrar essa chave; a biblioteca não promete exatamente uma escrita.

Nos bancos, snapshot JSON é texto canônico, e hashes de identidades exatas evitam equivalências de collation e espaço final. Índices, filtro de decisão e chave de ordenação permitem consultas limitadas no SQL. Aprovação e trabalho na mesma linha eliminam uma segunda escrita vulnerável a crash; falha de UPDATE deixa ambos ausentes. Criação usa conflito sem abortar transações de PostgreSQL e identifica o criador sem depender de affectedRows do MySQL.

Migração aditiva cria `agent_action_proposal`; preserva tabelas, histórico e propostas existentes. Aplicações que desabilitam provisionamento automático precisam executar sua migração antes de usar a nova capacidade. Não existe ainda endpoint, worker agendado ou opt-in que libere a conversa nesta entrega.

Próximo par: produção de proposta, worker recuperável e admissão de resultado no histórico. Depois: substituição/UI, texto como canal e capacidades dos clientes.
