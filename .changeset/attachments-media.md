---
'@adonis-agora/agent': minor
---

Chat attachments by id, media-backed, bring-your-own storage — matching `@dudousxd/nestjs-agent`'s refs-only contract.

- **One `attachments` option (BREAKING).** `attachments: attachmentStores.media()` stores uploads through `@adonis-agora/media` (an optional peer; any Drive disk — S3, GCS, R2, the filesystem): a media row per file in its own collection, owned by the actor, with signed short-lived urls by default (`visibility`, `urlExpiresInSeconds`, `resolveUrl`, `canAccess`, `maxBytes`, `allowedContentTypes`, `disk`, `collection`). `attachmentStores.memory({ maxBytes?, allowedContentTypes? })` for tests; or pass your own `AttachmentStagingStore`. Replaces `attachmentStaging`, `attachmentMaxBytes` and `attachmentAllowedContentTypes`; limits now come from the store's `describe()`. `@adonis-agora/agent/media` exports `MediaAttachmentStaging` to wire over a media setup of your own.
- **Refs only (BREAKING).** `POST /agent/chat` takes `attachments: [{ mediaId }]` — anything else in an entry is `400`, at most 10 — and resolves each through the store for the calling actor (`403` for one it may not use, `501` when attachments are off). The url the model fetches is never taken from the request.
- **`AttachmentStagingStore.resolve({ mediaId, actor })`** is now required (the store mints the url per request); `describe()` is optional. `GET /agent/threads/:id` re-mints each attachment's url by `mediaId`, so an old turn's signed link has not expired. `GET /agent/config` reports the store's limits.
