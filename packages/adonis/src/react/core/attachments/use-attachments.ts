import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MessageAttachment } from '../../../index.js';
import type { AgentBackend, UploadAttachmentOptions } from '../backend.js';
import { AgentBackendUnsupportedError } from '../backend.js';
import { useAgentConfig } from '../config/use-agent-config.js';
import { useAgentBackend } from '../provider.js';
import { acceptsFile, dragHasFiles, filesFromClipboard } from './files.js';

/** Where one staged file stands. `rejected` never uploaded (validation); `error` can be retried. */
export type StagedAttachmentStatus = 'uploading' | 'ready' | 'error' | 'rejected';

export interface StagedAttachment {
  /** Local id, stable for the item's life — use it as the React key and for `remove`/`retry`. */
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
  status: StagedAttachmentStatus;
  /** 0..1 while uploading (0 until the backend reports progress), 1 once ready. */
  progress: number;
  /** Why it was rejected or failed. */
  error?: string;
  /** What the server returned — present once `ready`. */
  attachment?: MessageAttachment;
  /** An object URL for image previews (revoked on remove/unmount), when the runtime has one. */
  previewUrl?: string;
}

/** Why a file was turned away before any upload. */
export type AttachmentRejection = 'type' | 'size' | 'count';

export interface UseAttachmentsOptions {
  /**
   * Upload one file — defaults to `backend.uploadAttachment`. Resolve with what the server
   * answered; honour `signal` so `remove` can cancel; call `onProgress(0..1)` if you can.
   */
  upload?: (file: File, options: UploadAttachmentOptions) => Promise<MessageAttachment>;
  /** Used for the default `upload`. Default: the enclosing `<AgentProvider>`'s. */
  backend?: AgentBackend;
  /**
   * `<input accept>` grammar: `'image/*,.pdf'` or `['image/*', 'application/pdf']`. Default: the
   * server's allowed content types (`GET <base>/config`).
   */
  accept?: string | readonly string[];
  /** Per-file ceiling, in bytes. Default: the server's (`GET <base>/config`). */
  maxBytes?: number;
  /**
   * How many files may be staged at once (rejected ones do not count). Default: how many one
   * message may carry, per the server (`GET <base>/config`).
   */
  maxFiles?: number;
  /** Words for a rejection; default English. */
  describeRejection?: (reason: AttachmentRejection, file: File) => string;
}

export interface AttachmentsState {
  items: StagedAttachment[];
  /** Stage files: validate, then upload each that passes. */
  add: (files: Iterable<File> | ArrayLike<File> | null | undefined) => void;
  /** Drop an item, cancelling its upload. */
  remove: (id: string) => void;
  /** Upload a failed item again. */
  retry: (id: string) => void;
  /** Drop everything — call after a send. */
  clear: () => void;
  /** An upload is still running — hold the send button. */
  isUploading: boolean;
  /** What to send: the ready uploads, in order, as the `{ mediaId }` refs `POST <base>/chat` takes. */
  refs: Array<{ mediaId: string }>;
  /** Props for a hidden `<input type="file">`: `accept`, `multiple`, `onChange`. */
  inputProps: {
    type: 'file';
    accept: string | undefined;
    multiple: boolean;
    onChange: (event: { currentTarget: HTMLInputElement }) => void;
  };
  /** Handlers for any element that should take dropped files. */
  dropZoneProps: {
    onDragEnter: (event: DragLikeEvent) => void;
    onDragOver: (event: DragLikeEvent) => void;
    onDragLeave: (event: DragLikeEvent) => void;
    onDrop: (event: DragLikeEvent) => void;
  };
  /** Files are being dragged over the drop zone — for a highlight. */
  isDragging: boolean;
  /** Paste handler for the composer: stages pasted files (screenshots), leaves text alone. */
  onPaste: (event: ClipboardLikeEvent) => void;
}

/** The slice of a React/DOM drag event these handlers read. */
export interface DragLikeEvent {
  dataTransfer: DataTransfer | null;
  preventDefault: () => void;
}

/** The slice of a React/DOM clipboard event `onPaste` reads. */
export interface ClipboardLikeEvent {
  clipboardData: DataTransfer | null;
  preventDefault: () => void;
}

const DEFAULT_REJECTION: Record<AttachmentRejection, (file: File) => string> = {
  type: (file) => `${file.name} is not a supported file type`,
  size: (file) => `${file.name} is too large`,
  count: () => 'Too many files',
};

let sequence = 0;

/**
 * Staged attachments for a composer, headless: validation (`accept`, `maxBytes`, `maxFiles`),
 * one upload per file with progress and cancel, retry, previews, and the event handlers for a file
 * input, a drop zone and paste — no markup, no styles. Send `refs` with the
 * message, then `clear()`:
 *
 * ```ts
 * await chat.sendMessage({ text }, { body: { attachments: files.refs } });
 * files.clear();
 * ```
 */
export function useAttachments(options: UseAttachmentsOptions = {}): AttachmentsState {
  const backend = useAgentBackend(options.backend);
  // The server's limits are the defaults, so a composer never repeats (and drifts from) them.
  const { config } = useAgentConfig({ backend });
  const limits = config?.attachments;
  const accept = options.accept ?? limits?.allowedContentTypes;
  const maxBytes = options.maxBytes ?? limits?.maxBytes;
  const maxFiles = options.maxFiles ?? limits?.maxPerMessage;
  const effective = {
    ...options,
    backend,
    ...(accept !== undefined ? { accept } : {}),
    ...(maxBytes !== undefined ? { maxBytes } : {}),
    ...(maxFiles !== undefined ? { maxFiles } : {}),
  };
  const latest = useRef(effective);
  latest.current = effective;
  const [items, setItems] = useState<StagedAttachment[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const controllers = useRef(new Map<string, AbortController>());
  const [dragDepth, setDragDepth] = useState(0);

  const patch = useCallback((id: string, change: Partial<StagedAttachment>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...change } : item)));
  }, []);

  const start = useCallback(
    (item: StagedAttachment) => {
      const { upload, backend } = latest.current;
      const run =
        upload ??
        (backend.uploadAttachment !== undefined
          ? backend.uploadAttachment.bind(backend)
          : undefined);
      if (run === undefined) {
        patch(item.id, {
          status: 'error',
          error: new AgentBackendUnsupportedError('uploadAttachment').message,
        });
        return;
      }
      const controller = new AbortController();
      controllers.current.set(item.id, controller);
      run(item.file, {
        signal: controller.signal,
        onProgress: (fraction) => patch(item.id, { progress: Math.max(0, Math.min(1, fraction)) }),
      }).then(
        (attachment) => {
          if (controller.signal.aborted) return;
          controllers.current.delete(item.id);
          patch(item.id, { status: 'ready', progress: 1, attachment });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          controllers.current.delete(item.id);
          patch(item.id, {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    },
    [patch],
  );

  const add = useCallback(
    (files: Iterable<File> | ArrayLike<File> | null | undefined) => {
      if (files == null) return;
      const { accept, maxBytes, maxFiles, describeRejection } = latest.current;
      const describe = (reason: AttachmentRejection, file: File) =>
        describeRejection?.(reason, file) ?? DEFAULT_REJECTION[reason](file);
      let room =
        maxFiles === undefined
          ? Number.POSITIVE_INFINITY
          : maxFiles - itemsRef.current.filter((item) => item.status !== 'rejected').length;
      const staged: StagedAttachment[] = [];
      for (const file of Array.from(files as ArrayLike<File>)) {
        sequence += 1;
        const base = {
          id: `att-${sequence}`,
          file,
          name: file.name,
          size: file.size,
          type: file.type,
          progress: 0,
        };
        const reason: AttachmentRejection | undefined = !acceptsFile(accept, file)
          ? 'type'
          : maxBytes !== undefined && file.size > maxBytes
            ? 'size'
            : room <= 0
              ? 'count'
              : undefined;
        if (reason !== undefined) {
          staged.push({ ...base, status: 'rejected', error: describe(reason, file) });
          continue;
        }
        room -= 1;
        const previewUrl =
          file.type.startsWith('image/') && typeof URL.createObjectURL === 'function'
            ? URL.createObjectURL(file)
            : undefined;
        staged.push({ ...base, status: 'uploading', ...(previewUrl ? { previewUrl } : {}) });
      }
      if (staged.length === 0) return;
      setItems((current) => [...current, ...staged]);
      for (const item of staged) {
        if (item.status === 'uploading') start(item);
      }
    },
    [start],
  );

  const release = useCallback((item: StagedAttachment | undefined) => {
    if (item === undefined) return;
    controllers.current.get(item.id)?.abort();
    controllers.current.delete(item.id);
    if (item.previewUrl !== undefined && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(item.previewUrl);
    }
  }, []);

  const remove = useCallback(
    (id: string) => {
      release(itemsRef.current.find((item) => item.id === id));
      setItems((current) => current.filter((item) => item.id !== id));
    },
    [release],
  );

  const clear = useCallback(() => {
    for (const item of itemsRef.current) release(item);
    setItems([]);
  }, [release]);

  const retry = useCallback(
    (id: string) => {
      const item = itemsRef.current.find((candidate) => candidate.id === id);
      if (item === undefined || item.status !== 'error') return;
      const { error: _previous, ...rest } = item;
      const again: StagedAttachment = { ...rest, status: 'uploading', progress: 0 };
      setItems((current) => current.map((candidate) => (candidate.id === id ? again : candidate)));
      start(again);
    },
    [start],
  );

  // Unmount: cancel what is in flight and free the previews.
  useEffect(
    () => () => {
      for (const item of itemsRef.current) release(item);
    },
    [release],
  );

  const onPaste = useCallback(
    (event: ClipboardLikeEvent) => {
      const files = filesFromClipboard(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      add(files);
    },
    [add],
  );

  const dropZoneProps = useMemo(
    () => ({
      onDragEnter: (event: DragLikeEvent) => {
        if (!dragHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        setDragDepth((depth) => depth + 1);
      },
      onDragOver: (event: DragLikeEvent) => {
        // Without this the browser never fires `drop` — it opens the file instead.
        if (dragHasFiles(event.dataTransfer)) event.preventDefault();
      },
      onDragLeave: (event: DragLikeEvent) => {
        if (!dragHasFiles(event.dataTransfer)) return;
        setDragDepth((depth) => Math.max(0, depth - 1));
      },
      onDrop: (event: DragLikeEvent) => {
        if (!dragHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        setDragDepth(0);
        add(event.dataTransfer?.files);
      },
    }),
    [add],
  );

  const inputProps = useMemo(
    () => ({
      type: 'file' as const,
      accept: typeof accept === 'string' ? accept : accept?.join(','),
      multiple: maxFiles === undefined || maxFiles > 1,
      onChange: (event: { currentTarget: HTMLInputElement }) => {
        const input = event.currentTarget;
        add(input.files);
        // Let the same file be picked again after a remove.
        input.value = '';
      },
    }),
    [accept, maxFiles, add],
  );

  return useMemo(() => {
    const ready = items.filter(
      (item): item is StagedAttachment & { attachment: MessageAttachment } =>
        item.status === 'ready' && item.attachment !== undefined,
    );
    return {
      items,
      add,
      remove,
      retry,
      clear,
      isUploading: items.some((item) => item.status === 'uploading'),
      refs: ready.map((item) => ({ mediaId: item.attachment.mediaId })),
      inputProps,
      dropZoneProps,
      isDragging: dragDepth > 0,
      onPaste,
    };
  }, [items, add, remove, retry, clear, inputProps, dropZoneProps, dragDepth, onPaste]);
}
