---
'@adonis-agora/agent': minor
---

MCP server and OAuth, with `@adonis-agora/authkit-server`'s `mcp: true`:

- The MCP server registers its URL with AuthKit at boot, so `claude mcp add <url>` logs users in with no URL in AuthKit's config.
- `authKitAuth()` only accepts a token issued **for this server** (its RFC 8707 audience must be the endpoint's URL), as the MCP authorization spec requires. A token for another resource, or with no audience, is refused with `401`. **Behavior change:** clients that do not send `resource` need `authKitAuth({ audience: 'any' })`.
- `McpAuth.verify(token, context?)` gets `{ resource }`; `anyOf()` passes it on.
- Tool calls over MCP carry a `toolCallId` and an `idempotencyKey` per `tools/call` (tools that need one to write, ran refused before) and `pageContext.channel = 'mcp'`.
- `middleware` in `config/mcp.ts`: route middleware for the MCP endpoint (a rate limiter, say); it runs before the bearer check.
- `stateless: true` in `config/mcp.ts`: every `POST` gets its own transport (no in-memory sessions), for more than one instance behind a load balancer; `GET`/`DELETE` answer `405`.
- `actions` in `config/mcp.ts` (`'refuse'` by default, or `'execute'`): the provider never passed it to the server, so action tools could not be exposed through `config/mcp.ts`.
- `instructions` in `config/mcp.ts`: sent to the client in the `initialize` result.
