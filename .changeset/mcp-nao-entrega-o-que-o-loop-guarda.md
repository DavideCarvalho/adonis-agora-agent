---
'@adonis-agora/agent': minor
---

O servidor MCP deixava de fora os dois portões que o loop aplica.

`tools/call` chamava `registry.invoke` direto, e `invoke` não conhece nem a `allowedTools` deste
servidor nem o `kind` da tool. Três consequências, a primeira séria:

- **Uma tool `action` executava sem aprovação humana.** No loop ela é HITL-gated: alguém aprova
  antes de rodar. Via MCP não há humano nenhum, e o handler rodava assim mesmo. Como o default de
  `roles` é ADMIN-only, a política de papéis era o único gate entre um chamador remoto e qualquer
  efeito colateral registrado.
- **Tools servidas pelo loop** (`agent`, `ask`, `skill`, `memory`) apareciam na listagem. Uma tool de
  handoff é registrada com handler-stub porque quem delega é o `AgentLoop` — chamá-la responderia
  `{}` e não delegaria a ninguém.
- **A `allowedTools` só valia na listagem.** Quem adivinhasse um nome alcançava uma tool que a
  implantação tirou da superfície de propósito.

Agora `isExposable` decide igual na listagem e na chamada: `action` fora por default, com
`actions: 'execute'` como opt-in nomeado — uma implantação dizendo que aceita um ator não aprovado
rodando toda `action` que os papéis dele alcançam. Kinds servidos pelo loop nunca são expostos, nem
sob o opt-in. E a allow-list é re-checada na chamada.

`createMcpServer` não tinha teste nenhum, que é como isso passou. Tem agora, contra um `Client` MCP
real, e cada portão foi revertido para ver o buraco reabrir.
