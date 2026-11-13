---
'@adonis-agora/agent': patch
---

The dev tools endpoint (`/mcp/agora`) now also binds an authkit-signed-in MCP caller through `authkit.server`'s `bindBearerAccount(ctx, accountId)` (authkit-server 1.0.0-rc.16 and later), so a console `authorize` / `devTools.authorize` written with authkit-server's `getAccountId(ctx)` or `realAccountId(ctx)` sees the account, not only ones that read `ctx.authkit` or `ctx.auth`. With an older authkit-server nothing changes. New `agora:doctor` check `agent.dev-tools-authkit-mcp`: warns when the dev tools hub is on and authkit is installed but `mcp` is off in `config/authkit.ts` (MCP clients can't register).
