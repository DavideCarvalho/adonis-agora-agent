---
'@adonis-agora/agent': minor
---

`@adonis-agora/agent/mcp-client` — tools de um servidor MCP que você não controla.

A direção contrária ao servidor MCP que este pacote já tinha: em vez de expor as tools DESTE
deployment para um cliente externo, importa as tools de um servidor MCP externo para o
`ToolRegistry` deste deployment. Elas entram no MESMO registry que a descoberta de `@aiTool`
alimenta, então passam por todos os gates que uma tool escrita à mão passa — a `RolesPolicy`, o
allow-list de persona/agente, e a validação de input.

```ts
// config/agent.ts
mcpServers: [{ name: 'github', transport: { type: 'stdio', command: 'mcp-github' } }]
```

**Uma tool importada é `action` por padrão**, ou seja, com HITL: ela foi escrita fora deste código e
os efeitos dela não são visíveis daqui. Alargar isso é uma decisão que o host toma em voz alta —
`kind: 'read'` (só para um servidor que você audita), `kind: 'trust-annotations'` (acreditar no
`readOnlyHint`, que é afirmado justamente por quem tem os efeitos que ele descreve, então é uma
declaração de confiança e não uma verificação — e uma tool que declara `readOnlyHint` E
`destructiveHint` está se descrevendo de forma incoerente e continua travada), ou um predicado por
tool.

**Um nome pertence a quem o reivindicou primeiro.** O registry é indexado por nome e nada mais, então
uma importação sem namespace deixaria o `search` de um servidor remoto substituir o `search` do
próprio app — uma troca invisível de todo lugar, porque o modelo continua chamando `search` e o
`search` agora chega no servidor de outra pessoa. Os nomes importados são prefixados com o nome do
servidor por padrão, e um segundo reivindicante é RECUSADO com um aviso nomeando os dois. Vale entre
servidores também, e a resposta é estável: a listagem roda em paralelo porque os servidores são
independentes, mas o registro reexecuta na ORDEM DE CONFIGURAÇÃO, então um nome disputado vai para o
servidor configurado primeiro por mais rápido que o outro responda.

**Duas coisas que um schema remoto pode fazer com este processo**, as duas terminando com a tool
DESCARTADA em vez de importada com um schema permissivo — a alternativa deixaria o modelo mandar
argumentos arbitrários para a tool remota com a aparência de uma chamada validada. Um schema que não
compila. E um `pattern` que backtracka exponencialmente: todo validador do SDK do MCP compila
`pattern` para um `RegExp` nativo, e `(a+)+$` contra 27 `a`s e um final que não casa leva ~1s, 30
~8s, 40 mais do que qualquer um vai esperar — de forma síncrona, na única thread que o processo tem.
O pattern é escrito pelo servidor remoto e a string é escrita pelo modelo, cuja indução a descrição
da mesma tool pode fornecer, então a coisa toda cabe dentro de uma definição de tool.

**A conexão não é estado durável.** Um servidor remoto pode reiniciar, ser redeployado ou cortar uma
conexão ociosa, e o primeiro sintoma é uma tool call que falha. Então uma chamada que falha de forma
transiente descarta o client, e o retry reconecta na próxima tentativa. O retry é o
`invokeWithTransientRetry` que o loop já usa, no lugar e não como novo checkpoint. Uma tool que
respondeu `isError` falhou por mérito próprio e NUNCA é retentada: a mensagem dela é texto que o
servidor remoto escreveu, e casar isso contra marcadores de transiência deixaria a prosa de uma tool
decidir se este lado retenta.

Um servidor fora do ar custa as tools dele e nada mais — o modelo simplesmente nunca é oferecido a
elas — a menos que ele declare `required: true`. E `refresh(name)` é o caminho de volta para um
servidor que estava fora no boot.

Duas coisas do porte de referência ficaram de fora porque o SPI de tools daqui não tem as costuras:
`ToolSpec.enabled` (um servidor dizer se as tools dele existem neste deployment) e
`ToolHandler.canUse` (um gate por ator). As duas são capacidades do SPI de tools, não do cliente MCP.
