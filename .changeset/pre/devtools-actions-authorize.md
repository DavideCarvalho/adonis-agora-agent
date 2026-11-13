---
"@adonis-agora/agent": minor
---

`devTools.actions` in `config/mcp.ts` is now authorized per caller. Besides `'refuse'`, `'execute'` and a list, it takes a map of lib ids or tool names to a console `authorize` (`{ flags: authorizeByRoles({ roles: ['ADMIN'] }), flags_save_flag: authorizeByRoles({ roles: ['OWNER'] }) }`, a tool key winning over its lib's), or a function `(ctx, { lib, tool, destructive, caller }) => boolean`. A refused action is neither listed nor callable; a throw or `{ redirectTo }` refuses; each `authorize` runs once per request. `agora:doctor` now warns on `devTools.actions: 'execute'` and suggests the map form. New types from `@adonis-agora/agent/mcp`: `DevToolsActions`, `DevToolsActionsMap`, `DevToolsActionsAuthorizer`, `DevToolsActionRequest`.
