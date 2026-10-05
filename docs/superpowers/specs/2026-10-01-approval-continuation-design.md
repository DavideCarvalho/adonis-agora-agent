# Aprovações e catálogo: revisão e proposta de continuação

Estado: desenho aprovado em 2026-10-01, com a exigência adicional de paridade entre Aviary e Agora. Implementar a primeira entrega; detalhar os planos antes das mudanças maiores.

## Regra de paridade

Cada feature deste documento pertence aos dois projetos. Uma entrega só está completa quando o servidor Nest (Aviary) e o servidor Adonis (Agora) têm o mesmo contrato e comportamento, testes equivalentes e documentação de paridade. Cada projeto mantém sua própria implementação, incluindo catálogo e React; adaptar providers, autorização, runners e persistência de cada servidor. Paridade de comportamento e protocolo não cria dependência de pacotes ou ordem de publicação entre Aviary e Agora.

Essa regra inclui a checagem por chamada, a apresentação dinâmica, propostas independentes, substituição, decisão por texto e capacidades do app. Não basta expor uma API no Agora se o loop ou a store dele não a executam. Nenhum dos projetos pode ficar com uma implementação parcial tratada como conclusão da etapa.

Base examinada: `adonis-agora-agent` em `35b0a3f` (origin/master, versão no source 0.60.0), e `nestjs-agent` em `7563245`. A versão instalada no exames-monorepo é 0.33.1; a existência no source atual não comprova integração ou publicação no app.

## O que já existe

| Pedido | Evidência no código atual | Lacuna |
| --- | --- | --- |
| Política por ferramenta e aprovação nesta conversa | `packages/adonis/src/spi/approval-policy.ts`, `claimApproval` em `agent-loop.ts`, `test/approvals-v2.spec.ts`; `rememberedApprovals(threadId)` | Não recebe os dados da chamada e não substitui uma checagem por chamada. |
| Expiração e contagem | `ttlMs`, `expiresAt`, rejeição HTTP 410; React compartilhado à época exportava `useApprovalCountdown`; atualmente o hook é local | O hook é headless; sua existência não comprova contagem visível nos cartões dos apps. |
| Aprovação por canais e auditoria | `AgentService.approve/reject`, `via`, `executedByRef`, histórico `decidedVia` | Não há interpretação de confirmação por texto. `via` não constitui integração pronta de Slack/Teams. |
| Templates do cartão | `tool-presentation.ts`: `confirm.title/verb/detail`, placeholders de input, GET tools | Não há enriquecimento dinâmico por chamada, com dados consultados pela ferramenta antes do cartão. |
| Catálogo | Na base examinada, `/genui` dependia do core Nest; atualmente o Agora implementa o catálogo localmente. Catálogo com schema, versão, `fallbackText`, componentes internos e builtins | Não há declaração de capacidades do cliente propagada ao turno. No React, o fallback padrão é vazio; conversão automática para texto ainda precisa de integração. |
| Mensagem durante ação pendente | `chat-queue-service.ts` aceita mensagens na fila | A fila espera o run terminar. `runClaimedToolCall` continua aguardando `awaitDecision`; a aprovação mantém o turno ocupado. |

Os PRs #201, #202 e #213 já entregaram apresentação, approvals v2 e catálogo. Foram apenas consultados como histórico, não alterados por esta revisão.

## Direção proposta

Reusar as APIs existentes e completar suas fronteiras. Reusar a política e o catálogo existentes de cada projeto; o Agora mantém sua própria camada React. Comparadas as alternativas: ampliar a fila mantém o bloqueio; liberar o run estacionado para escrever junto de novos turnos cria concorrência no histórico; uma ação persistida independente do turno dá uma fronteira explícita para executar e publicar o resultado. Recomendada a terceira, com entrega em PRs sequenciais.

### PR 1 — Checagem por chamada e apresentação dinâmica

Arquivos centrais: `packages/adonis/src/spi/tool.ts`, `ai-tool-ref.ts`, `tool-registry.ts`, `agent-loop.ts`, `spi/agent-store.ts`, `stores/lucid.ts`, `stores/lucid-schema.ts`, `testing/in-memory-store.ts`, `test/approvals-v2.spec.ts` e docs de authoring/tools e streaming.

Adicionar um hook opcional de preparação da ação, com input validado e contexto autenticado. Seu resultado discriminado permite continuar, recusar com motivo, ou informar que o efeito já existe com resultado do domínio. Esse hook também pode fornecer dados e texto de confirmação por chamada, sobre os templates já existentes. Não chamar `execute` nessa fase e não autorizar input inválido.

Ordem: disponibilidade e autorização → validação de input → checagem por chamada → política por ferramenta → aprovação lembrada ou cartão → revalidação imediatamente antes do efeito. A aprovação automática ou lembrada nunca pula a checagem. Falha na checagem não executa nem gera um cartão enganoso; vira resultado compreensível para o modelo. A preparação apresentada é persistida e journaled para que replay e histórico mantenham o cartão original. Quando um processo pode perder a execução antes do primeiro claim, a preparação acompanha o resultado do checkpoint de modelo que originou a chamada; o claim consome esse resultado confiável. Não recalcular contra uma registry vazia na retomada nem adicionar uma posição incondicional ao journal de runs antigos.

Uma recusa do domínio é resultado definitivo da checagem, mesmo que seu motivo contenha palavras como deadlock; não passa por retries transientes ou pelo classificador customizado. Uma recusa depois do clique mantém o fato de que a pessoa aprovou, e informa separadamente que o domínio impediu o efeito. Envelopes internos de resultado devem escapar saídas comuns com os mesmos marcadores: um efeito que rodou não pode aparecer no histórico como se não tivesse rodado.

A ferramenta conhece o que é duplicado; a biblioteca não deduz equivalência por nome ou hash dos argumentos. A checagem inicial evita um cartão desnecessário, mas não elimina a corrida entre checar e gravar: o efeito continua exigindo idempotência ou uma restrição atômica no domínio. Reusar `ctx.idempotencyKey`.

Aceitação: duplicado não gera cartão nem efeito; aprovação lembrada continua checando; input inválido não chama o hook; replay mantém a apresentação; mudança do recurso entre cartão e clique recusa o efeito; ferramenta sem hook mantém o comportamento atual. Testar inline e durable, e persistência Lucid/memória.

### PR 2 — Ação pendente independente e substituição

Parte maior: apresentar e revisar o plano detalhado antes de implementar.

Arquivos centrais: `agent-loop.ts`, `agent-service.ts`, `chat-queue-service.ts`, `spi/agent-store.ts`, `spi/agent-runner.ts`, runners inline/durable, schema e store Lucid, store de testes, protocolo de eventos e testes durable/queue. Mudanças no React e no vocabulário do protocolo são implementadas e testadas localmente em cada projeto; não há peers Aviary nem dependência de publicação no Adonis.

Persistir a proposta antes de encerrar o turno com o fato de que a ação aguarda decisão; liberar o dono da conversa para iniciar outro turno. A proposta carrega identificador estável, actor/tenant, ferramenta, input validado, cartão, origem, prazo e política aplicável. A decisão inicia uma execução independente, sem retomar o run antigo para escrever sobre o histórico de turnos novos. Publicar resultado associado à proposta e preservado no histórico; serializar sua inserção com novos turnos usando o mecanismo de admissão da conversa.

Estados de proposta: pending → approved, rejected, expired ou superseded. Estado de execução separado: queued → executing → succeeded ou failed. Transições por compare-and-set/transaction; uma única decisão ganha. A validade é verificada no servidor mesmo antes de um timer efetivamente marcar expired. Cancelar/Stop um turno posterior não cancela silenciosamente uma proposta anterior.

Substituir somente propostas ainda pending, com chave de substituição explicitamente fornecida pela ferramenta e escopada à identidade e conversa. Não substituir toda chamada da mesma ferramenta: duas ações podem ser independentes. A substituição e a decisão disputam a mesma transição atômica; uma proposta aprovada não é substituída retroativamente. Cartão antigo mostra a substituição e recusa clique tardio. Na execução, reavaliar acesso atual e a checagem por chamada.

Aceitação: fazer outra pergunta e receber resposta com cartão ainda aberto; aprovar a proposta depois; restart e múltiplas réplicas; decisão simultânea por dois canais; aprovação versus expiry/substituição; histórico sem sobrescrever turnos; resultado associado à proposta correta; regressão de fila, Stop, regenerate e detached agents.

### PR 3 — Texto como canal de decisão

Depende do PR 2. Arquivos centrais: `agent-service.ts`, serviço dedicado de resolução de decisões de texto, consulta de propostas na store, rotas/protocolo e testes funcionais. O cliente envia texto pelo chat normal.

Resolver confirmações explícitas no servidor antes de pedir resposta ao modelo, sempre sobre propostas reais da conversa e usando a mesma checagem de identidade, autorização, prazo e transição atômica dos botões. Registrar `via: 'text'`. Uma confirmação curta inequívoca com uma única proposta elegível pode decidir; com várias, pedir identificação. Referência explícita ao cartão seleciona a proposta. Texto citado, negação, perguntas ou pedidos condicionais não autorizam um efeito. Não converter “sim” em aprovação permanente: lembrar exige intenção explícita e identificada.

Aceitação: confirmar e rejeitar por texto; ambiguidade entre cartões; nenhum cartão elegível; cartão expirado/substituído; outro actor/tenant; nenhuma chamada executada por decisão inventada pelo modelo; botão e texto simultâneos resultam em um efeito.

### PR 4 — Capacidades do app e fallback textual

Parte maior: apresentar e revisar o plano detalhado antes de implementar. Pode ser desenvolvida separadamente do PR 2 após estabilizar os contratos do PR 1.

Fonte comum: `nestjs-agent/packages/core/src/genui/{catalog,tools,text}.ts` e `packages/react/src/genui/`; Adonis: `packages/adonis/src/genui/index.ts`, `spi/tool.ts`, `agent-deps-factory.ts`, tipos de input, validação HTTP, fila, adapters AG-UI e testes `genui.spec.ts`.

O app declara nomes e versões renderizáveis por envio. Essa declaração restringe capacidades de apresentação e nunca concede permissões. O servidor intersecta o catálogo permitido para actor/tenant com as capacidades declaradas; o modelo só recebe ferramentas e schemas desse resultado. Componentes incompatíveis não continuam aparecendo como ferramentas com uma descrição “não use”. Capturar as capacidades no input persistido para fila e replay; um envio posterior de outro canal pode declarar capacidades diferentes.

Reusar `componentToText` e `fallbackText` quando um componente emitido por ferramenta não puder ser desenhado. Persistir uma representação textual junto da UI para histórico, reconexão e cliente com versão diferente. Se renderer faltar ou falhar no cliente, mostrar esse texto sem gerar duas respostas. Para cliente sem declaração, adotar texto como comportamento conservador; documentar a migração dos clientes antigos que dependem de UI.

Um único catálogo serve servidor, web e React Native. Renderers continuam específicos de plataforma. Não importar dependências DOM no catálogo isomórfico. Catálogos resolvidos por tenant continuam sendo a fronteira de acesso e não podem ser ampliados por nomes enviados pelo app.

Aceitação: web anuncia tabela/gráfico e mobile só indicadores; o modelo vê exatamente cada interseção; versões incompatíveis; canal textual; renderer desconhecido ou com erro; fallback de árvore; componente internal; fila e replay preservam capacidades; nenhuma duplicação em reconexão. Validar os três modos per-component/tree/show.

## Entrega e limites

- Cada PR inclui testes de comportamento, documentação, changeset e compatibilidade com runs persistidos em versões anteriores.
- Não atualizar o meuprontoo de 0.33.1 para 0.60.0 incidentalmente: houve mudanças de contrato no intervalo. A integração web/mobile exige etapa própria com revisão de migração e contagem visível no cartão.
- Revisar o uso do botão “aprovar sempre” e do countdown nos apps na etapa de integração; APIs headless não comprovam a experiência na tela.
- Aviary e Agora mantêm implementações e releases independentes. Verificar paridade de comportamento e compatibilidade de protocolo, sem dependências de publicação entre projetos.
- Esta revisão inicial não executou a suíte e não afirma testes passando. Antes da entrega, executar os checks em cada repo e revisar paridade. Antes dos PRs 2 e 4, mostrar os planos de estados, persistência, protocolo e migração nos dois projetos.
