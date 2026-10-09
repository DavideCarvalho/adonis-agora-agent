import type { ReactNode } from 'react';
import { readUiActionText, type UiActionMessage, uiActionSummary } from '../../../genui/actions.js';

export interface UiActionChipProps {
  /** The action: a transcript block's `uiAction`, or a user message's text (read with `readUiActionText`). */
  action: UiActionMessage | string;
  /** Plain values shown after the sentence. Default 3; `0` shows the sentence alone. */
  maxValues?: number;
  className?: string;
  /** Replaces the default content (the summary line). */
  children?: ReactNode;
}

/**
 * A user message that is a UI action — a sandbox's `agent.send`, a component's button — drawn as a
 * compact chip: what the user said, then a few of its values (`Recalculate · people: 4, tip: 15`).
 * The message's JSON block stays in the message (the model reads it); the chip's `title` lists every
 * value for a reader who wants them. A string that is not a UI action draws as itself.
 *
 * Unstyled: `className`, or the `[data-ui-action]` attribute, is the hook.
 */
export function UiActionChip({ action, maxValues, className, children }: UiActionChipProps) {
  const parsed = typeof action === 'string' ? readUiActionText(action) : action;
  if (parsed === null) return <>{action as string}</>;
  const values = Object.keys(parsed.context).length > 0 ? JSON.stringify(parsed.context) : '';
  return (
    <span
      className={className}
      data-ui-action={parsed.name}
      data-ui-action-source={parsed.source}
      title={values.length > 0 ? `${parsed.text}\n${values}` : parsed.text}
    >
      {children ?? uiActionSummary(parsed, maxValues !== undefined ? { maxValues } : {})}
    </span>
  );
}
