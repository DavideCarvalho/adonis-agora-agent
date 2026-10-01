/**
 * `@adonis-agora/agent/react/media` — resumable (tus) chat attachment uploads, for an app whose
 * `config/agent.ts` uses `attachmentStores.media()` over a media library with `uploads.resumable`.
 *
 * ```tsx
 * import { AgentProvider } from '@adonis-agora/agent/react'
 * import { mediaAttachments } from '@adonis-agora/agent/react/media'
 *
 * <AgentProvider attachments={{ upload: mediaAttachments() }}>
 * ```
 *
 * `@dudousxd/nestjs-agent-react/media`, re-exported: it opens the upload on
 * `POST <path>/attachments/uploads`, streams the bytes to `@adonis-agora/media`'s tus routes and
 * confirms on `.../complete` — every request on the provider's connection, so the session cookie and
 * the CSRF header ride along. Needs the optional peer `@dudousxd/nestjs-media-client`.
 */
export * from '@dudousxd/nestjs-agent-react/media';
