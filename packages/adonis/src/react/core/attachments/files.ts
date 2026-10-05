import type { FileUIPart, UIMessage } from 'ai';
import type { MessageAttachment } from '../../../index.js';

/** How a renderer is likely to show a file. */
export type MessageFileKind = 'image' | 'pdf' | 'text' | 'audio' | 'video' | 'other';

/** One file on a message, live or replayed, with what a renderer needs to decide how to show it. */
export interface MessageFile {
  url: string;
  mediaType: string;
  /** The original name, or `null` when the part carried none. */
  filename: string | null;
  kind: MessageFileKind;
  /** Lower-case extension from the name (`'pdf'`), or `null`. */
  extension: string | null;
  /** The stored media id — present on files replayed from history (`StoredMessage.attachments`). */
  mediaId: string | null;
}

/** The {@link MessageFileKind} of a MIME type. */
export function fileKind(mediaType: string): MessageFileKind {
  const type = mediaType.toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('text/') || type === 'application/json') return 'text';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  return 'other';
}

function messageFile(url: string, mediaType: string, name: string | null, mediaId: string | null) {
  const dot = name?.lastIndexOf('.') ?? -1;
  const file: MessageFile = {
    url,
    mediaType,
    filename: name,
    kind: fileKind(mediaType),
    extension: name !== null && dot > 0 ? name.slice(dot + 1).toLowerCase() : null,
    mediaId,
  };
  return file;
}

/**
 * An uploaded attachment as the {@link MessageFile} it is once its message is sent — so a message
 * still waiting (in the queue, in the composer) draws its files with the same code a sent one does.
 */
export function attachmentFile(attachment: MessageAttachment): MessageFile {
  return messageFile(attachment.url, attachment.contentType, attachment.name, attachment.mediaId);
}

/**
 * The files on a message — the user's attachments (live, or replayed from `StoredMessage.attachments`
 * by `storedMessageToUiMessage`) and any the model produced — in part order. Data only: pair it with
 * your own thumbnails/links.
 */
export function messageFiles(message: Pick<UIMessage, 'parts'>): MessageFile[] {
  const files: MessageFile[] = [];
  for (const part of message.parts) {
    if (part.type !== 'file') continue;
    const file = part as FileUIPart;
    const mediaId = (file.providerMetadata?.agent as { mediaId?: unknown } | undefined)?.mediaId;
    files.push(
      messageFile(
        file.url,
        file.mediaType,
        file.filename ?? null,
        typeof mediaId === 'string' ? mediaId : null,
      ),
    );
  }
  return files;
}

/**
 * Whether `file` matches an `accept` list in the `<input accept>` grammar: MIME types
 * (`application/pdf`), wildcards (`image/*`) and extensions (`.csv`). An empty list accepts all.
 */
export function acceptsFile(
  accept: string | readonly string[] | undefined,
  file: Pick<File, 'name' | 'type'>,
): boolean {
  const rules = (typeof accept === 'string' ? accept.split(',') : (accept ?? []))
    .map((rule) => rule.trim().toLowerCase())
    .filter((rule) => rule.length > 0);
  if (rules.length === 0) return true;
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return rules.some((rule) => {
    if (rule.startsWith('.')) return name.endsWith(rule);
    if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1));
    return type === rule;
  });
}

/** Files carried by a paste — screenshots and copied files. Text-only pastes give `[]`. */
export function filesFromClipboard(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file !== null) files.push(file);
  }
  return files.length > 0 ? files : Array.from(data.files ?? []);
}

/** Whether a drag carries files (as opposed to text or a link) — gate your drop highlight on it. */
export function dragHasFiles(data: DataTransfer | null | undefined): boolean {
  return Array.from(data?.types ?? []).includes('Files');
}
