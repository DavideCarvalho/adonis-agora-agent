---
'@adonis-agora/agent': patch
---

`agora:doctor` no longer reports the dev tools as off when `config/mcp.ts` is missing. With `mcp_provider` registered, the provider mounts `/mcp/agora` on an empty config. The doctor now resolves the config the same way through shared code (`resolveDevTools` / `readMcpConfig`), so `agent.mcp-csrf` and `agent.dev-tools-gate` check that endpoint. The MCP checks skip only when nothing serves MCP or `devTools: false` is set.
