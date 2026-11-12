---
"@adonis-agora/agent": minor
---

Account console pages. When `@adonis-agora/authkit-server` is in the app, the agent registers itself into authkit's `authkit.accountExtensions` registry, with no import of authkit. Signed-in users get AI usage meters (`/account/ai`), their conversations (delete), the companies their assistant is connected to (disconnect, with sudo), and pending approvals they can approve or reject under the same rules as in the app (recorded `via: 'account-console'`). New `accountConsole` option in `config/agent.ts`: `false`, or `{ actor, threadUrl, pages }`. With organizations on, the pages follow the account's active organization. `AgentService.listThreads(actorRef, { limit, tenantScope })`, `threadTenantRef` and `runTenantRef` are new.
