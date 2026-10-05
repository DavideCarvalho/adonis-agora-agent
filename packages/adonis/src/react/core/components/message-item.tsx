import type { UIMessage } from 'ai';
import React from 'react';
import type {
  AnyToolUIPart,
  MessageUsageInfo,
  TranscriptBlock,
  TranscriptFile,
  TranscriptUiBlock,
} from '../transcript/model.js';
import {
  type EditSubmitInput,
  type MessageActionInput,
  type TranscriptItem,
  useTranscriptItem,
} from '../transcript/use-chat-transcript.js';
import { useAmbientRenderUi } from './ambient-ui.js';

export type { AnyToolUIPart, MessageUsageInfo } from '../transcript/model.js';
export { formatRelativeTime } from '../transcript/model.js';

export type RenderToolPartFn = (part: AnyToolUIPart, key: string) => React.ReactNode;

/** Render a run of consecutive tool parts as one block (e.g. a collapsible tool group). */
export type RenderToolGroupFn = (parts: AnyToolUIPart[], key: string) => React.ReactNode;

/** Render a message's text — pass a markdown renderer (e.g. `AgentMarkdown`) here if desired. */
export type RenderTextFn = (text: string, ctx: { isStreaming: boolean }) => React.ReactNode;

/** Render a run of files — attachments on a user turn, or files the model produced. */
export type RenderFilesFn = (files: TranscriptFile[]) => React.ReactNode;

/**
 * Render a component the server pushed into the message — look `block.component` up in your own
 * registry. Omitted → drawn by the enclosing `<GenuiProvider>` (`/genui`) if there is one, else not
 * drawn (there is no sensible default for an app's own component).
 */
export type RenderUiFn = (block: TranscriptUiBlock) => React.ReactNode;

/** Render the body of a reasoning run; the disclosure toggle around it stays this component's. */
export type RenderReasoningFn = (
  text: string,
  ctx: { isStreaming: boolean; isOpen: boolean },
) => React.ReactNode;

export interface MessageItemClassNames {
  root?: string;
  /** Resolved per role so user/assistant/system bubbles can differ. */
  byRole?: Partial<Record<UIMessage['role'], string>>;
  text?: string;
  /** The action row under the bubble (copy / fork / regenerate / usage / timestamp). */
  actions?: string;
  actionButton?: string;
  usage?: string;
  timestamp?: string;
  editTextarea?: string;
  editActions?: string;
  reasoning?: string;
  reasoningToggle?: string;
  reasoningText?: string;
  files?: string;
  file?: string;
  fileImage?: string;
}

interface MessageRenderSlots {
  renderToolPart?: RenderToolPartFn;
  /** Takes precedence over `renderToolPart` for a run of consecutive tool parts. */
  renderToolGroup?: RenderToolGroupFn;
  renderText?: RenderTextFn;
  renderReasoning?: RenderReasoningFn;
  /** Draw files yourself — a gallery, a viewer. Omitted → images inline, everything else a link. */
  renderFiles?: RenderFilesFn;
  /**
   * Draw a server-pushed component (a `ui` stream frame). Omitted → the enclosing `<GenuiProvider>`
   * draws it; without one, not drawn.
   */
  renderUi?: RenderUiFn;
  /**
   * Extra content for the action row, after the built-in affordances and before usage — a badge
   * naming which agent answered, a status pill. Rendered for every message that has an action row.
   */
  meta?: React.ReactNode;
  /** Label on the reasoning disclosure toggle. Default `"Reasoning"`. */
  reasoningLabel?: React.ReactNode;
  classNames?: MessageItemClassNames;
}

export interface MessageItemProps extends MessageRenderSlots {
  message: UIMessage;
  /** Marks the in-flight assistant bubble (e.g. for a caret animation / deferred markdown render). */
  isStreaming?: boolean;
  /** User bubble gets a pencil → inline textarea; submitting calls back with the new text. */
  editable?: boolean;
  onEditSubmit?: (input: EditSubmitInput) => void | Promise<void>;
  /** Assistant bubble gets a "Regenerate" affordance. */
  regeneratable?: boolean;
  onRegenerate?: (input: MessageActionInput) => void | Promise<void>;
  /** When provided, a "Fork" affordance calls back with this message's id. */
  onFork?: (input: MessageActionInput) => void | Promise<void>;
  /** Server-aggregated usage for this assistant turn (cost + tokens line). */
  usage?: MessageUsageInfo | null;
  /** ISO timestamp of the persisted message; rendered as a relative-time line when set. */
  createdAt?: string | null;
}

export interface MessageItemViewProps extends MessageRenderSlots {
  item: TranscriptItem;
}

/**
 * Styling-agnostic renderer for a single v7 `UIMessage`. Ports flip's full chat-item UX —
 * copy, fork, regenerate, inline edit-and-resubmit, collapsible reasoning, usage line, relative
 * timestamp, and tool grouping — but with ALL styling left to `classNames` and every action
 * surfaced as a callback, so no design-system / icon / date library is pulled in (relative time
 * uses Intl.RelativeTimeFormat).
 *
 * All of the logic lives in `useTranscriptItem`; this is one rendering of it. An app that wants
 * different markup drives that hook and writes its own.
 */
export function MessageItem({
  message,
  isStreaming = false,
  editable,
  onEditSubmit,
  regeneratable,
  onRegenerate,
  onFork,
  usage,
  createdAt,
  ...slots
}: MessageItemProps) {
  const item = useTranscriptItem({
    message,
    isStreaming,
    ...(editable !== undefined ? { editable } : {}),
    ...(onEditSubmit ? { onEditSubmit } : {}),
    ...(onFork ? { onFork } : {}),
    ...(regeneratable !== undefined ? { regeneratable } : {}),
    ...(onRegenerate ? { onRegenerate } : {}),
    ...(usage != null ? { getUsage: () => usage } : {}),
    ...(createdAt != null ? { getCreatedAt: () => createdAt } : {}),
  });
  return <MessageItemView item={item} {...slots} />;
}

/** The default markup for one modelled message — what `MessageItem` renders once it has an item. */
export function MessageItemView({ item, ...given }: MessageItemViewProps) {
  // Inside a `<GenuiProvider>`, pushed components draw without a `renderUi` of their own.
  const ambientRenderUi = useAmbientRenderUi();
  const slots: MessageRenderSlots =
    given.renderUi === undefined && ambientRenderUi !== null
      ? { ...given, renderUi: ambientRenderUi }
      : given;
  const { classNames } = slots;
  const actionRow = (
    <div className={classNames?.actions} data-actions-for={item.role}>
      {item.copy.available ? (
        <button
          type="button"
          onClick={item.copy.copy}
          className={classNames?.actionButton}
          title={item.copy.copied ? 'Copied!' : 'Copy message text'}
        >
          {item.copy.copied ? 'Copied' : 'Copy'}
        </button>
      ) : null}
      {item.fork.available ? (
        <button
          type="button"
          onClick={item.fork.run}
          className={classNames?.actionButton}
          title="Fork thread from this message"
        >
          Fork
        </button>
      ) : null}
      {item.regenerate.available ? (
        <button
          type="button"
          onClick={item.regenerate.run}
          className={classNames?.actionButton}
          title="Regenerate response"
        >
          Regenerate
        </button>
      ) : null}
      {slots.meta}
      {!item.isUser && item.usage ? (
        <span
          className={classNames?.usage}
          title={`Input ${item.usage.inputTokens.toLocaleString()} · Output ${item.usage.outputTokens.toLocaleString()} tokens`}
        >
          {item.usage.costLabel} · {item.usage.tokensLabel}
        </span>
      ) : null}
      {item.timestamp ? (
        <span className={classNames?.timestamp} title={item.timestamp.absolute}>
          {item.timestamp.relative}
        </span>
      ) : null}
    </div>
  );

  if (item.edit.available) {
    return <EditableUserBubble item={item} slots={slots} actions={actionRow} />;
  }

  const className = joinClasses(classNames?.root, classNames?.byRole?.[item.role]);

  return (
    <div
      className={className}
      data-role={item.role}
      data-streaming={item.isStreaming ? 'true' : undefined}
    >
      <div>{renderBlocks(item, slots)}</div>
      {actionRow}
    </div>
  );
}

/** Blocks the model has no opinion on are skipped — a renderer only draws what it can draw. */
function renderBlocks(item: TranscriptItem, slots: MessageRenderSlots): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  for (const block of item.blocks) {
    if (block.kind === 'text') {
      nodes.push(
        <div key={block.key} className={slots.classNames?.text}>
          {slots.renderText
            ? slots.renderText(block.text, { isStreaming: item.isStreaming })
            : block.text}
        </div>,
      );
      continue;
    }
    if (block.kind === 'reasoning') {
      nodes.push(renderReasoningBlock(block, slots));
      continue;
    }
    if (block.kind === 'files') {
      nodes.push(renderFilesBlock(block, slots));
      continue;
    }
    if (block.kind === 'tools') {
      nodes.push(...renderToolBlock(item, block, slots));
      continue;
    }
    if (block.kind === 'ui' && slots.renderUi) {
      nodes.push(
        <div key={block.key} data-slot="ui" data-component={block.component}>
          {slots.renderUi(block)}
        </div>,
      );
    }
  }
  return nodes;
}

/**
 * Files as content. An image is shown; anything else is a labelled link, because a renderer that
 * cannot display a format is more useful pointing at it than guessing.
 */
function renderFilesBlock(
  block: Extract<TranscriptBlock, { kind: 'files' }>,
  slots: MessageRenderSlots,
): React.ReactNode {
  return (
    <div key={block.key} className={slots.classNames?.files} data-files="true">
      {slots.renderFiles
        ? slots.renderFiles(block.files)
        : block.files.map((file) => (
            <a
              key={file.url}
              href={file.url}
              target="_blank"
              rel="noreferrer"
              className={slots.classNames?.file}
              title={file.filename ?? file.mediaType}
            >
              {file.isImage ? (
                <img
                  src={file.url}
                  alt={file.filename ?? 'image'}
                  className={slots.classNames?.fileImage}
                />
              ) : (
                (file.filename ?? file.mediaType)
              )}
            </a>
          ))}
    </div>
  );
}

function renderReasoningBlock(
  block: Extract<TranscriptBlock, { kind: 'reasoning' }>,
  slots: MessageRenderSlots,
): React.ReactNode {
  return (
    <div
      key={block.key}
      className={slots.classNames?.reasoning}
      data-reasoning="true"
      data-streaming={block.isStreaming ? 'true' : undefined}
    >
      <button
        type="button"
        className={slots.classNames?.reasoningToggle}
        onClick={() => block.toggle()}
        aria-expanded={block.isOpen}
      >
        {slots.reasoningLabel ?? 'Reasoning'}
      </button>
      {block.isOpen ? (
        <div className={slots.classNames?.reasoningText}>
          {slots.renderReasoning
            ? slots.renderReasoning(block.text, {
                isStreaming: block.isStreaming,
                isOpen: block.isOpen,
              })
            : block.text}
        </div>
      ) : null}
    </div>
  );
}

function renderToolBlock(
  item: TranscriptItem,
  block: Extract<TranscriptBlock, { kind: 'tools' }>,
  slots: MessageRenderSlots,
): React.ReactNode[] {
  if (slots.renderToolGroup) {
    return [
      <React.Fragment key={block.key}>
        {slots.renderToolGroup(block.parts, block.key)}
      </React.Fragment>,
    ];
  }
  if (!slots.renderToolPart) {
    return [];
  }
  const renderToolPart = slots.renderToolPart;
  return block.parts.map((part) => {
    const partKey = `${item.id}-${part.toolCallId}`;
    return <React.Fragment key={partKey}>{renderToolPart(part, partKey)}</React.Fragment>;
  });
}

interface EditableUserBubbleProps {
  item: TranscriptItem;
  slots: MessageRenderSlots;
  actions: React.ReactNode;
}

function EditableUserBubble({ item, slots, actions }: EditableUserBubbleProps) {
  const { classNames } = slots;
  const { edit } = item;

  if (!edit.isEditing) {
    return (
      <div className={joinClasses(classNames?.root, classNames?.byRole?.user)} data-role="user">
        <div className={classNames?.text}>
          {slots.renderText ? slots.renderText(item.text, { isStreaming: false }) : item.text}
        </div>
        <button
          type="button"
          onClick={edit.start}
          className={classNames?.actionButton}
          title="Edit & resubmit"
        >
          Edit
        </button>
        {actions}
      </div>
    );
  }

  const textareaProps = edit.getTextareaProps();
  return (
    <div data-editing="true">
      <textarea
        {...textareaProps}
        rows={Math.min(8, edit.draft.split('\n').length + 1)}
        className={classNames?.editTextarea}
      />
      <div className={classNames?.editActions}>
        <button type="button" onClick={edit.cancel}>
          Cancel
        </button>
        <button type="button" onClick={edit.save} disabled={!edit.canSave}>
          Resend
        </button>
      </div>
    </div>
  );
}

function joinClasses(...entries: Array<string | undefined>): string | undefined {
  const joined = entries.filter((entry) => entry).join(' ');
  return joined === '' ? undefined : joined;
}
