---
'@adonis-agora/agent': minor
---

A tool can say whether it exists here, and who may use it — `enabled`, `isEnabled()`, `canUse(actor)`

`roles`/`ability` are checked by one app-wide `RolesPolicy`, and an agent's `tools` allow-list is fixed when the agent is declared. Neither could say "this capability is off in this deployment" or "only accounts on the paid plan get it", so the per-actor decision had to live inside `execute` — where a refusal has already cost the model a turn and told the user the capability exists.

- **`enabled`** on `@AiTool({ … })`, `static tool = { … }`, `defineTool` and `defineConfirmedTool` — a boolean, or a predicate re-read every turn — and **`isEnabled()`** on a tool class (container-resolved, so it can read an `@inject`'d service).
- **`canUse(actor)`** as a method on a tool class, or an option on `defineTool` / `defineConfirmedTool`.
- **`mcpServers[].enabled` / `mcpServers[].canUse`** — the same two gates for every tool an MCP server exports.

Both run when the turn's tool list is built (so `GET <path>/tools` and the MCP server's `tools/list` agree with it) and again on invoke, which is what stops a HITL action approved before a flag moved from running after it. Order: allow-list → `enabled` → `RolesPolicy` → `canUse`; every layer only removes tools. A disabled tool raises the new `ToolDisabledError`, distinct from `ToolForbiddenError` and `ToolNotFoundError`. `isToolEnabled`, `canActorUseTool`, `filterToolsByEnabled` and `filterToolsByCanUse` are exported.

Also fixed on the way: a tool class's `describe()` was not forwarded by discovery, and `Guardrails.wrapTool` dropped `describe` — both now reach the registry.

Matches `@dudousxd/nestjs-agent`'s `ToolSpec.enabled` / `ToolHandler.isEnabled` / `ToolHandler.canUse`. Purely additive: a tool that declares none of this behaves exactly as before.
