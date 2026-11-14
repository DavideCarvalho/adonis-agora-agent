---
'@adonis-agora/agent': patch
---

`agent.dev-tools-authkit-mcp` follows authkit's automatic MCP client login: it warns only when `config/authkit.ts` sets `mcpClients: false` while the dev tools hub is on, and it reads `mcpClients` structurally (the input `false` or the resolved `{ allowed: false }`). The `mcp: true` advice is gone from the docs.
