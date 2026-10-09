// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { sandboxAction, uiActionText } from '../../../src/genui/actions.js';
import { MessageItem } from '../../../src/react/core/components/message-item.js';
import { UiActionChip } from '../../../src/react/core/genui/index.js';
import { buildTranscriptBlocks } from '../../../src/react/core/transcript/model.js';

const openAll = {
  isReasoningOpen: (_key: string, isStreaming: boolean) => isStreaming,
  toggleReasoning: () => undefined,
};

const said = uiActionText(
  sandboxAction({ text: 'Recalculate', people: 4, tip: 15 }, { title: 'Bill splitter' }),
);

function user(text: string): UIMessage {
  return { id: 'u1', role: 'user', parts: [{ type: 'text', text }] };
}

describe('a UI action in the transcript', () => {
  it('reads a user message that is a UI action into its block — and only a user message', () => {
    const [block] = buildTranscriptBlocks(user(said), openAll);
    expect(block).toMatchObject({
      kind: 'text',
      text: said,
      uiAction: { text: 'Recalculate', name: 'send', context: { people: 4, tip: 15 } },
    });
    const [plain] = buildTranscriptBlocks(user('hello'), openAll);
    expect(plain && 'uiAction' in plain).toBe(false);
    const [assistant] = buildTranscriptBlocks({ ...user(said), role: 'assistant' }, openAll);
    expect(assistant && 'uiAction' in assistant).toBe(false);
  });

  it('draws it as a chip: the sentence and a few values, no JSON', () => {
    render(<UiActionChip action={said} />);
    const chip = screen.getByText('Recalculate · people: 4, tip: 15');
    expect(chip.getAttribute('data-ui-action')).toBe('send');
    expect(chip.getAttribute('title')).toContain('"people":4');
    render(<UiActionChip action="not an action" />);
    expect(screen.getByText('not an action')).toBeTruthy();
  });

  it('MessageItem shows the chip in the user bubble', () => {
    const { container } = render(<MessageItem message={user(said)} editable />);
    expect(container.textContent).toContain('Recalculate · people: 4, tip: 15');
    expect(container.textContent).not.toContain('```json');
    expect(container.textContent).not.toContain('Edit');
  });
});
