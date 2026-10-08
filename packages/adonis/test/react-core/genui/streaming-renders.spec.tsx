// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { type ReactNode, useLayoutEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GenerativeUI, useGenuiNode } from '../../../src/react/core/genui/generative-ui.js';
import { shareStructure } from '../../../src/react/core/genui/share-structure.js';
import type { GenerativeUIElement, GenuiRegistry } from '../../../src/react/core/genui/types.js';
import { useChatTranscript } from '../../../src/react/core/transcript/use-chat-transcript.js';

afterEach(cleanup);

const renders = new Map<string, number>();
const count = (name: string) => renders.set(name, (renders.get(name) ?? 0) + 1);
beforeEach(() => renders.clear());

/** Told about every layout pass of the chart, as a chart that measures itself would be. */
let onMeasure: (() => void) | undefined;

const registry: GenuiRegistry = {
  Card: ({ title, children }: { title?: string; children?: ReactNode }) => {
    count('card');
    return (
      <section>
        <h2>{title}</h2>
        {children}
      </section>
    );
  },
  // A heavy renderer the way real charts are written: it measures itself in a layout effect keyed
  // on its data, sets state from it, and reports the size up.
  Chart: ({ data }: { data?: unknown[] }) => {
    count('chart');
    const [width, setWidth] = useState(0);
    useLayoutEffect(() => {
      setWidth((data?.length ?? 0) * 10);
      onMeasure?.();
    }, [data]);
    return <figure data-testid="chart">{width}</figure>;
  },
  Table: ({ rows }: { rows?: unknown[] }) => {
    count('table');
    const node = useGenuiNode();
    return (
      <table data-testid="table" data-incomplete={String(node?.incomplete)}>
        <tbody>
          {(rows ?? []).map((_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
            <tr key={index} />
          ))}
        </tbody>
      </table>
    );
  },
};

const chart: GenerativeUIElement = {
  id: 'root.0',
  type: 'Chart',
  props: { data: [{ m: 'a', v: 1 }] },
};

/** The tree after `rows` table rows, the table still being written. */
function frameTree(rows: number, incomplete = true): GenerativeUIElement {
  return {
    id: 'root',
    type: 'Card',
    props: { title: 'Sales' },
    ...(incomplete ? { incomplete: true as const } : {}),
    children: [
      chart,
      {
        id: 'root.1',
        type: 'Table',
        props: { rows: Array.from({ length: rows }, (_, index) => ({ index })) },
        ...(incomplete ? { incomplete: true as const } : {}),
      },
    ],
  };
}

/** A streaming assistant message carrying the tree, as the AI SDK hands it over: a fresh deep copy. */
function message(rows: number, text: string, incomplete = true): UIMessage {
  return structuredClone({
    id: 'm1',
    role: 'assistant',
    parts: [
      { type: 'text', text, state: 'streaming' },
      {
        type: 'data-ui',
        id: 'call-0:ui:0',
        data: {
          id: 'call-0:ui:0',
          component: 'genui:tree',
          props: { root: frameTree(rows, incomplete) },
          version: 1,
          toolCallId: 'call-0',
          ...(incomplete ? { partial: true } : {}),
        },
      },
    ],
  } as UIMessage);
}

let push: ((next: UIMessage) => void) | undefined;

/** A chat view: the transcript of the streamed message, its pushed components drawn in place. */
function Chat({ initial }: { initial: UIMessage }) {
  const [messages, setMessages] = useState<UIMessage[]>([initial]);
  push = (next) => setMessages([next]);
  const transcript = useChatTranscript({ messages, status: 'streaming' });
  return (
    <>
      {transcript.items.flatMap((item) =>
        item.blocks.map((block) =>
          block.kind === 'ui' ? (
            <GenerativeUI key={block.key} part={block} registry={registry} />
          ) : block.kind === 'text' ? (
            <p key={block.key}>{block.text}</p>
          ) : null,
        ),
      )}
    </>
  );
}

describe('a fast stream of partial tree frames', () => {
  it('renders an unchanged node once while its siblings and the text keep streaming', () => {
    onMeasure = undefined;
    render(<Chat initial={message(0, '')} />);
    for (let frame = 1; frame <= 100; frame++) {
      // A tree frame, then a text token: both are new deep copies of the whole message.
      act(() => push?.(message(frame, 'x'.repeat(frame - 1))));
      act(() => push?.(message(frame, 'x'.repeat(frame))));
    }
    // One render, plus the one its own layout effect asks for — never once per frame.
    expect(renders.get('chart')).toBe(2);
    // The table grew on each tree frame (and only then): 1 mount + 100 frames.
    expect(renders.get('table')).toBe(101);
    expect(screen.getByTestId('table').querySelectorAll('tr')).toHaveLength(100);

    // `incomplete` → final is a change: the final frame renders the nodes it settles.
    const before = renders.get('table') ?? 0;
    act(() => push?.(message(100, 'x'.repeat(100), false)));
    expect(renders.get('table')).toBe(before + 1);
    expect(screen.getByTestId('table').dataset.incomplete).toBe('false');
  });

  it('does not loop when a renderer sets state in a layout effect while frames keep landing', () => {
    // Every layout pass of the chart lands another frame synchronously — what a fast stream does to
    // a chart that measures itself. Re-rendering the unchanged chart for each frame re-runs its
    // effect, which lands a frame, … until React gives up with "Maximum update depth exceeded".
    let frames = 0;
    onMeasure = () => {
      if (frames >= 500) return;
      frames++;
      push?.(message(1, 'x'.repeat(frames)));
    };
    try {
      render(<Chat initial={message(1, '')} />);
      expect(screen.getByTestId('chart').textContent).toBe('10');
      expect(renders.get('chart')).toBe(2);
      expect(frames).toBe(1);
    } finally {
      onMeasure = undefined;
    }
  });
});

describe('<GenerativeUI> fed fresh copies directly (no transcript)', () => {
  const part = (root: GenerativeUIElement, partial = true) =>
    structuredClone({
      type: 'data-ui',
      id: 'call-0:ui:0',
      data: {
        id: 'call-0:ui:0',
        component: 'genui:tree',
        props: { root },
        toolCallId: 'call-0',
        ...(partial ? { partial: true } : {}),
      },
    });
  const held = (rows: number, isHeld: boolean): GenerativeUIElement => ({
    id: 'root',
    type: 'Card',
    props: {},
    incomplete: true,
    children: [
      chart,
      isHeld
        ? { id: 'root.1', type: 'Table', props: {}, held: true }
        : { id: 'root.1', type: 'Table', props: { rows: Array.from({ length: rows }) } },
    ],
  });

  it('shares the tree itself, and re-renders a node whose held flag flips', () => {
    onMeasure = undefined;
    const view = render(
      <GenerativeUI part={part(held(0, true))} registry={registry} placeholder={<i>held</i>} />,
    );
    expect(screen.getByText('held')).toBeTruthy();
    for (let frame = 0; frame < 20; frame++)
      view.rerender(
        <GenerativeUI part={part(held(0, true))} registry={registry} placeholder={<i>held</i>} />,
      );
    expect(renders.get('chart')).toBe(2);
    expect(renders.get('card')).toBe(1);
    view.rerender(
      <GenerativeUI part={part(held(3, false))} registry={registry} placeholder={<i>held</i>} />,
    );
    expect(screen.queryByText('held')).toBeNull();
    expect(screen.getByTestId('table').querySelectorAll('tr')).toHaveLength(3);
    expect(renders.get('table')).toBe(1);
    expect(renders.get('chart')).toBe(2);
  });
});

describe('shareStructure', () => {
  it('keeps every unchanged part, and the whole when nothing changed', () => {
    const previous = frameTree(2);
    const same = shareStructure(previous, structuredClone(previous));
    expect(same).toBe(previous);

    const next = shareStructure(previous, frameTree(3));
    expect(next).not.toBe(previous);
    expect(next.children?.[0]).toBe(previous.children?.[0]);
    expect(next.children?.[1]).not.toBe(previous.children?.[1]);
    expect(next.children?.[1]?.props.rows).toEqual(frameTree(3).children?.[1]?.props.rows);
    const rows = (tree: GenerativeUIElement) => tree.children?.[1]?.props.rows as unknown[];
    expect(rows(next)[0]).toBe(rows(previous)[0]);
  });

  it('sees a flag flip, a removed key and a shorter array as changes', () => {
    const previous = frameTree(2);
    expect(shareStructure(previous, frameTree(2, false))).not.toBe(previous);
    const { title: _title, ...rest } = previous.props;
    expect(shareStructure(previous, { ...previous, props: rest })).not.toBe(previous);
    expect(shareStructure([1, 2], [1])).toEqual([1]);
    expect(shareStructure({ a: undefined }, { b: undefined })).toEqual({ b: undefined });
  });
});
