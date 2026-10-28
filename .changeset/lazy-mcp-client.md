---
"@adonis-agora/agent": patch
---

Load the MCP client (and `@modelcontextprotocol/sdk` with it) only when `mcpServers` is configured. The agent provider imported it at boot in every app; an app without MCP servers now skips ~5 MB of heap and ~60 ms of module evaluation per process. No API change — `@adonis-agora/agent/mcp-client` still exports the same values.
