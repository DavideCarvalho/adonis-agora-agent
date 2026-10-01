---
'@adonis-agora/agent': minor
---

A file a message in your own thread already carries is yours to attach — `AgentStore.referencedMediaIds`

`attachmentStores.media()` let only the uploader attach a file (unless `canAccess` widened it). Now the default also admits an actor whose OWN thread holds a surviving message carrying that file — a fork, a regenerate — matching `@dudousxd/nestjs-agent`. The verdict is handed to `canAccess` as `allowed`, so it can still be narrowed.

It is derived on every send, not remembered: the new optional `AgentStore.referencedMediaIds(actorRef, mediaIds)` answers from the messages that still exist (so `truncateFrom` takes the access away again), scoped to one actor so it cannot probe anyone else's conversation. `LucidAgentStore` and `InMemoryAgentStore` implement it; a store without it keeps the uploader-only rule. The attachment-store factory context now carries the provider's `agentStore`.
