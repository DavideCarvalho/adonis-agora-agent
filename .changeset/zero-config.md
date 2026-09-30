---
'@adonis-agora/agent': minor
---

Zero-config by default, matching `@dudousxd/nestjs-agent`'s DX pass: `defineConfig({ model })` is a working public chat.

- **Anonymous identity by default (BREAKING).** With no `actorResolver` the routes are public and each browser is its own anonymous actor (`AnonymousActorResolver`): the first response sets `agent_anon=<32 random bytes, base64url>; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax` (plus `Secure` over HTTPS) and the actor is `anon:` + a SHA-256 of it, so visitors never share threads, quota or attachments. A boot notice says the endpoints are public. One line requires login: `actorResolver: new AuthActorResolver()`. Before, an unset resolver answered `401` everywhere — set one explicitly if you relied on that.
- **Tools open unless restricted (BREAKING).** `defaultRoles` defaults to `[]` — no restriction — and `DefaultRolesPolicy` / `DefaultToolAuthorizer` treat an empty list as open. `roles` on a tool still restricts it; `action` tools still wait for approval. `defaultRoles: ['ADMIN']` restores the old default. (The MCP server surface keeps its own `['ADMIN']` default.)
- **`@AiTool` / `static tool` defaults.** `name` defaults to the class name camelCased minus a trailing `Tool` (`toolNameFromClass`), `kind` to `'read'`; `defineTool` still needs a `name`.
- **`aiSdkModels({ id: model | { model, label, badges, … } }, { default, providerLabels })`** from `@adonis-agora/agent/ai-sdk`: several models behind one provider carrying its own catalog, served by `GET /agent/models` when `models` is not set. `aiSdkModel` now refuses a pick naming a model it does not serve. **`aiSdkModel`'s `resolveModel` option (added in 0.44.0) is removed** — use `aiSdkModels`.
- The SSE routes now forward headers the request already set (the identity cookie, a session).
