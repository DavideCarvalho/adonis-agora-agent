/** Default per-file size cap when the attachment store declares none (20 MiB). */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Default allowlist: what multimodal model providers commonly accept as native image/file parts. */
export const DEFAULT_ALLOWED_ATTACHMENT_CONTENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
];

/** The size cap and content types an upload is held to. */
export interface AttachmentLimits {
  maxBytes: number;
  allowedContentTypes: readonly string[];
}
