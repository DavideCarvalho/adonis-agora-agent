---
"@adonis-agora/agent": patch
---

fix(mcp): type the auth → actor contract end to end (#42). `isMcpAuthInfo(authInfo)` (from `@adonis-agora/agent/mcp`) narrows the SDK's `AuthInfo`, whose `extra` is an untyped record, to an `McpAuthInfo`, so `authInfo.extra.actor` is an `Actor` without a cast. `actorFromAuthInfo` is built on it. `McpAuthInfo.extra` is now `McpAuthExtra`: the actor typed, plus any other keys a strategy of your own adds, so it is still an SDK `AuthInfo`. `isActor` also rejects a non-string `tenantRef`.
