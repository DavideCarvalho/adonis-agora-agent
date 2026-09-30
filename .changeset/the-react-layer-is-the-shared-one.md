---
'@adonis-agora/agent': minor
---

`@adonis-agora/agent/react` is now the full React layer: `<AgentProvider>` + `useAgentChat()` with history, resume, the message queue, approvals, questions, attachments, threads, models and quota.

It re-exports `@dudousxd/nestjs-agent-react` (a new optional peer — install it with `@ai-sdk/react` and `ai`) rather than carrying a second client: this package's routes speak the same wire contract as `@dudousxd/nestjs-agent`, so one React client serves both. What is added here is the AdonisJS connection — `AgentProvider` and `createAgentClient()` send the session cookie and `@adonisjs/shield`'s CSRF token (the `XSRF-TOKEN` cookie as `X-XSRF-TOKEN`, else `<meta name="csrf-token">` as `X-CSRF-TOKEN`), read per request. `@adonis-agora/agent/react/genui`, `/react/genui/json-render` and `/react/markdown` re-export the matching subpaths.

```tsx
import { AgentProvider, useAgentChat } from '@adonis-agora/agent/react'

<AgentProvider><Chat /></AgentProvider>

const { transcript, composer, queue } = useAgentChat()
```

**Breaking:** the previous minimal `useAgentChat` of this entry (`{ messages, status, error, send, cancel }` over `createAgentChatClient`) is gone — the name now resolves to the shared hook, whose shape is different (`sendMessage`, `transcript`, `composer`, `queue`, …). The framework-free stream client at `@adonis-agora/agent/client` is unchanged.

Server pieces the React client calls, ported from `@dudousxd/nestjs-agent`:

- `POST <path>/queue/:messageId/interrupt` — run a waiting message now (`chat.queue.interrupt(id)`): it moves to the head as an interrupt, any pause is lifted and the running turn is cancelled for it; with nothing running it starts at once. `QueuedMessagePatch.interrupt` on the `ChatQueueStore` SPI (Lucid and in-memory stores implement it; `CHAT_QUEUE_STORE_CONTRACT` has the case), `AgentService.interruptQueuedMessage`.
- `POST <path>/chat { transient: true }` and `POST <path>/threads/:id/promote` — a scratch thread left out of the list until kept (`AgentStore.promoteThread`, optional; `501` without it).
- `DELETE <path>/threads/:id/from/:messageId` — drop a message and everything after it (edit and resend).
- `GET <path>/skills?threadId=` — the skills the caller can invoke, the same list the model is offered.
