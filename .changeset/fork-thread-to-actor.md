---
'@adonis-agora/agent': minor
---

`forkThread(threadId, fromMessageId, options?)` takes `ForkThreadOptions` — `{ actorRef?, tenantRef? }` — to make the copy belong to someone else. That is "continue this conversation" from a shared link: the reader gets their own copy up to that point to go on from, and the original stays its owner's. Without options nothing changes (the copy is the source owner's), in `AgentService`, the Lucid store and the in-memory store. A custom `AgentStore` keeps compiling (the parameter is optional) and should honour it to support the feature.
