---
'@adonis-agora/agent': minor
---

Resumable (tus) chat attachment uploads on `@adonis-agora/media` — and `@adonis-agora/agent/react/media`

With `attachmentStores.media()` over a media library that has `uploads.resumable` in `config/media.ts`, the provider now mounts `POST <path>/attachments/uploads` (validate + open an owned tus session → `{ mediaId, uploadId, location }`), `POST <path>/attachments/uploads/:mediaId/complete` (`409` while bytes are missing, `422` and dropped on a size mismatch, `404` for another actor's id) and `DELETE <path>/attachments/uploads/:mediaId`. The bytes go to the media library's own tus routes (`tusBasePath`, default `/media/uploads/tus`). `GET <path>/config` reports `upload: 'resumable'`; the multipart route stays. A pending upload is not attachable until it completes.

On the client: `<AgentProvider attachments={{ upload: mediaAttachments() }}>` from the new `@adonis-agora/agent/react/media` subpath (a re-export of `@dudousxd/nestjs-agent-react/media`; optional peer `@dudousxd/nestjs-media-client`).

`MediaAttachmentStaging` gains `beginUpload` / `completeUpload` / `discard` (and `MediaUploadRefusedError`), and `remove` aborts an upload still in flight. `AttachmentStagingDescription.upload` is new. Matches `@dudousxd/nestjs-agent`'s `AgentMediaAttachmentsModule` routes.
