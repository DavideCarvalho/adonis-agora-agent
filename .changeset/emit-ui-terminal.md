---
'@adonis-agora/agent': minor
---

`ctx.emitUi(component, props, { id?, version? })` and terminal tools, matching `@dudousxd/nestjs-agent`. Every tool context now carries `emitUi` (always present; a no-op outside a conversation, e.g. over MCP — `createNoopEmitUi` is exported, also from `./testing`, for contexts a test builds by hand). A push streams at once (`ui` under the agent protocol, `event: component` under the legacy envelope), a repeat `id` replaces it, and every component a step's tools pushed is persisted on the assistant message once they settle (`StoredMessage.ui`; optional `AgentStore.setMessageUi`, implemented by the Lucid and in-memory stores). The pushes ride the tool step's journaled result, so a durable replay neither re-streams nor re-persists them. `ctx.emitComponent` keeps working through the same path. `terminal: true` on a tool ends the turn once a call to it succeeds. `AiToolCtx` gains `agentName`.

**Breaking for hand-built contexts:** `AiToolCtx.emitUi` is required, so code that constructs an `AiToolCtx` literal (usually a test calling a handler directly) adds `emitUi: createNoopEmitUi()`.
