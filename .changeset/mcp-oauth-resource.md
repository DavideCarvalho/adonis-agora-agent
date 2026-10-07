---
'@adonis-agora/agent': minor
---

MCP server and OAuth, with `@adonis-agora/authkit-server`'s `mcp: true`:

- The MCP server registers its URL with AuthKit at boot, so `claude mcp add <url>` logs users in with no URL in AuthKit's config.
- `authKitAuth()` only accepts a token issued **for this server** (its RFC 8707 audience must be the endpoint's URL), as the MCP authorization spec requires. A token for another resource, or with no audience, is refused with `401`. **Behavior change:** clients that do not send `resource` need `authKitAuth({ audience: 'any' })`.
- `McpAuth.verify(token, context?)` gets `{ resource }`; `anyOf()` passes it on.
- Tool calls over MCP carry a `toolCallId` and an `idempotencyKey` per `tools/call` (tools that need one to write, ran refused before) and `pageContext.channel = 'mcp'`.
