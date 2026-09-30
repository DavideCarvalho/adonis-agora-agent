---
'@adonis-agora/agent': minor
---

`defineConfirmedTool` — a write with a human gate that works over MCP: the first call validates everything, writes nothing and returns a preview plus a signed `confirmToken`; the same arguments with `confirm: true` and the token commit. Closes #233.

`createMcpServer` keeps `action` tools off the surface and Claude.ai / Claude Desktop have no elicitation, so every app exposing writes over MCP was rebuilding this gate inside a `read` tool. It is now one helper:

```ts
import { defineConfirmedTool, LucidConfirmTokenStore } from '@adonis-agora/agent'

export const refundOrder = defineConfirmedTool(
  { name: 'refund_order', description: '…', input: z.object({ orderId: z.string() }),
    secret: () => env.get('APP_KEY').release(), store: new LucidConfirmTokenStore(db) },
  {
    prepare: async ({ orderId }, ctx) => loadRefundableOrder(orderId, ctx.actor),
    preview: (order) => ({ summary: `Refund ${order.total}?`, data: order }),
    commit: async (order) => ({ summary: 'Refunded.', data: await refund(order) }),
  },
)
```

- The token is `<expiresAt>.<HMAC-SHA256>` over the tool, `ctx.actor.id`, `ctx.actor.tenantRef`, the expiry and the canonical arguments: stateless, and useless for another actor, tenant, tool or argument, or after `ttlMs` (default 15 minutes). `secret` is required — there is no default.
- `confirm` / `confirmToken` are added around the app's own Standard Schema (`withConfirmFields`): validated by the helper, stripped before the app schema runs, and merged into the JSON Schema `tools/list` and the model see. `prepare` receives the arguments without them.
- Results: `{ status: 'preview', summary, data, confirmToken, expiresAt, confirm }` and `{ status: 'done', summary, data }`. A refused confirmation throws `ConfirmTokenError` (`reason: 'invalid' | 'used'`) and writes nothing. `messages` overrides the English wording.
- Single use through the new `ConfirmTokenStore` SPI (`claim` / `release` / `purgeExpired`): the token is claimed right before `commit` (a refusal in `prepare` does not spend it) and released if `commit` throws. `LucidConfirmTokenStore` keeps the marks — the token's SHA-256, the actor, the tool — in a new `agent_confirm_token` table and is safe across replicas; `InMemoryConfirmTokenStore` (also in `@adonis-agora/agent/testing`) is for tests and a single process. **Without a `store` a token is not single use.**
- `createAgentTables` creates `agent_confirm_token` (`AGENT_TABLES.confirmTokens`). With `autoCreateTables: true` it appears as the app starts; with it off, add a migration that calls `createAgentTables` again.
- `canonicalJson`, `signConfirmToken`, `verifyConfirmToken`, `confirmTokenExpiry` and `hashConfirmToken` are exported for a gate of your own.
