---
'@adonis-agora/agent': minor
---

The MCP server's auth works behind a proxy, sends clients to the login, and can take more than one kind of token

Five things an app putting `/mcp` behind OAuth had to work around, now in the provider:

- **Every refused request carries `WWW-Authenticate`.** The MCP Authorization spec has clients start the login from the `401` challenge, and the provider answered `401` without one. With OAuth metadata it is now `Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/<path>"`, with `error="invalid_token"` when a token was sent and refused; without OAuth it is a bare `Bearer`.
- **`publicUrl` in `config/mcp.ts`.** The RFC 9728 `resource` (and now the challenge's `resource_metadata`) were built from the request's protocol and `Host`, so behind a TLS-terminating proxy the app does not trust they came out `http://`. `publicUrl: env.get('APP_URL')` names the public origin; omitted, the request is used as before. A value with a path, query, or fragment fails the boot. The metadata document also gains `bearer_methods_supported: ['header']` and `Access-Control-Allow-Origin: *`.
- **`authKitAuth()` hands `toActor` the grant.** Besides `accountId`/`scopes`/`clientId`, the resolver now gets `grantId`, the `grant`, the `activeOrg` authkit bound to it at consent, and the token's `extra` claims — so a multi-tenant app resolves the tenant the user actually authorized. Existing resolvers keep working. The grant is loaded per request, and a token whose grant was revoked is refused (`401 authorization revoked`).
- **`McpAuthError`, a typed refusal.** Throw it from `toActor` or `verify` to refuse a token you recognized — a client that must not reach MCP, a member who left the org. `new McpAuthError(msg)` is a `401` with `error="invalid_token"`, `{ status: 403 }` a `403` with `error="insufficient_scope"`. An expired authkit token is now one too.
- **`anyOf(...strategies)`.** Accepts OAuth tokens and, say, personal access tokens on the same endpoint. Tried in order, first to verify wins; a plain `Error` passes to the next strategy, an `McpAuthError` stops the chain. OAuth metadata comes from the first strategy that exposes it.
