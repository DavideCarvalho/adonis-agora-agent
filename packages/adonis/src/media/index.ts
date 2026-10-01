/**
 * `@adonis-agora/agent/media` — chat attachments stored through `@adonis-agora/media` (an optional
 * peer). `attachmentStores.media()` in `config/agent.ts` builds {@link MediaAttachmentStaging} from
 * the app's `MediaManager`; use the class directly to wire it over a media setup of your own.
 */
export {
  DEFAULT_AGENT_MEDIA_COLLECTION,
  DEFAULT_AGENT_MEDIA_OWNER_TYPE,
  MediaAttachmentStaging,
  type MediaAttachmentStagingDeps,
  type MediaAttachmentsOptions,
  type MediaDiskLike,
  type MediaRecordLike,
  type MediaStorageLike,
  type MediaStoreLike,
  type ReferencedMediaLike,
} from './media-attachment-staging.js';
