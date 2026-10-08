import { describe, expect, it } from 'vitest';
import { Card, Chart, DataTable, KpiCards, Stack } from '../src/genui/builtins.js';
import { defineCatalog, defineComponent, genuiTools, partialTree } from '../src/genui/index.js';
import { parsePartialJson } from '../src/partial-json.js';
import type { SinkWriter, StreamFrame } from '../src/spi/token-stream-sink.js';
import type { PartialToolInput, ToolInputPreview } from '../src/spi/tool.js';
import { previewToolInputs } from '../src/tool-input-preview.js';

const catalog = defineCatalog([Stack, Card, Chart, DataTable, KpiCards]);

const dashboard = {
  type: 'Card',
  props: { title: 'Sales dashboard' },
  children: [
    { type: 'KpiCards', props: { items: [{ label: 'Revenue', value: '$9k' }] } },
    {
      type: 'Chart',
      props: {
        type: 'bar',
        xKey: 'month',
        series: [{ key: 'revenue' }],
        data: [
          { month: 'Jan', revenue: 1 },
          { month: 'Feb', revenue: 2 },
        ],
      },
    },
  ],
};

function partial(text: string): PartialToolInput {
  const parsed = parsePartialJson(text);
  if (parsed === undefined) throw new Error(`not JSON: ${text}`);
  return {
    value: parsed.value,
    done: parsed.complete,
    isOpen: parsed.isOpen,
    pendingMember: parsed.pendingMember,
  };
}

const prefix = (value: unknown, until: string) => {
  const text = JSON.stringify(value);
  const at = text.indexOf(until);
  if (at < 0) throw new Error(`no ${until}`);
  return text.slice(0, at + until.length);
};

describe('partialTree', () => {
  it('draws the nodes whose type has arrived, flagged incomplete while open, with positional ids', () => {
    const tree = partialTree(catalog, partial(prefix(dashboard, '"label":"Rev')), {
      streaming: 'partial',
    });
    expect(tree).toEqual({
      root: {
        id: 'root',
        type: 'Card',
        props: { title: 'Sales dashboard' },
        incomplete: true,
        children: [
          {
            id: 'root.0',
            type: 'KpiCards',
            props: { items: [{ label: 'Rev' }] },
            incomplete: true,
          },
        ],
      },
    });
  });

  it('keeps every id stable as the tree grows', () => {
    const text = JSON.stringify(dashboard);
    const ids = new Map<string, string>();
    for (let cut = 1; cut <= text.length; cut += 1) {
      const tree = partialTree(catalog, partial(text.slice(0, cut)), { streaming: 'partial' });
      expect(tree, `prefix ${cut}`).not.toBeNull();
      const visit = (node: { id: string; type: string; children?: unknown[] } | null) => {
        if (node === null) return;
        const seen = ids.get(node.id);
        if (seen !== undefined) expect(seen).toBe(node.type);
        ids.set(node.id, node.type);
        for (const child of node.children ?? []) visit(child as never);
      };
      visit(tree?.root ?? null);
    }
    expect([...ids]).toEqual([
      ['root', 'Card'],
      ['root.0', 'KpiCards'],
      ['root.1', 'Chart'],
    ]);
    // Closed: no node is flagged any more.
    const whole = partialTree(catalog, partial(text), { streaming: 'partial' });
    expect(JSON.stringify(whole)).not.toMatch(/incomplete|held/);
  });

  it('never takes a type cut mid-way for a component', () => {
    const tree = partialTree(catalog, partial('{"type":"Card","children":[{"type":"Char'), {
      streaming: 'partial',
    });
    expect(tree?.root?.children).toBeUndefined();
    expect(partialTree(catalog, partial('{"type":"Ca'), { streaming: 'partial' })).toEqual({
      root: null,
    });
  });

  it('holds a component that streams complete as a placeholder until its subtree closes', () => {
    const held = defineCatalog([Card, KpiCards, { ...Chart, streaming: 'complete' }]);
    const writing = partialTree(held, partial(prefix(dashboard, '"month":"Jan"')), {
      streaming: 'partial',
    });
    expect(writing?.root?.children?.[1]).toEqual({
      id: 'root.1',
      type: 'Chart',
      props: {},
      incomplete: true,
      held: true,
    });
    const closed = partialTree(held, partial(prefix(dashboard, '"revenue":2}]}}')), {
      streaming: 'partial',
    });
    expect(closed?.root?.children?.[1]).toEqual({
      id: 'root.1',
      type: 'Chart',
      props: dashboard.children[1]?.props,
    });
  });

  it('stops (null) at what can no longer become a tree this catalog draws', () => {
    const options = { streaming: 'partial' as const };
    expect(partialTree(catalog, partial('{"type":"Pie","props":{'), options)).toBeNull();
    expect(
      partialTree(
        catalog,
        partial('{"type":"Chart","props":{},"children":[{"type":"Card"'),
        options,
      ),
    ).toBeNull();
    expect(partialTree(catalog, partial('{"type":"Card","children":[1,'), options)).toBeNull();
    const nested = { type: 'Stack', children: [{ type: 'Stack', children: [{ type: 'Stack' }] }] };
    expect(
      partialTree(catalog, partial(JSON.stringify(nested)), {
        ...options,
        limits: { maxDepth: 2 },
      }),
    ).toBeNull();
  });
});

describe('the ui__render preview', () => {
  const scope = { actor: { id: 'u1', roles: [] }, toolCallId: 'call-1' };

  it('is off by default: the tree appears when the call has run, as before', async () => {
    const [tool] = genuiTools(catalog, { mode: 'tree' });
    expect(await tool?.handler.previewInput?.(scope)).toBeUndefined();
  });

  it('is on with streaming partial, or when a component opts in', async () => {
    const [tool] = genuiTools(catalog, { mode: 'tree', streaming: 'partial' });
    const preview = await tool?.handler.previewInput?.(scope);
    expect(preview?.render(partial('{"type":"Card","props":{"title":"S'))).toEqual({
      component: 'genui:tree',
      version: 1,
      props: { root: { id: 'root', type: 'Card', props: { title: 'S' }, incomplete: true } },
    });
    const optIn = defineCatalog([Card, { ...KpiCards, streaming: 'partial' }]);
    const [opted] = genuiTools(optIn, { mode: 'tree' });
    expect(await opted?.handler.previewInput?.(scope)).toBeDefined();
  });

  it('answers nothing until a node is drawable, and withdraws (null) an undrawable tree', async () => {
    const [tool] = genuiTools(catalog, { mode: 'tree', streaming: 'partial' });
    const preview = (await tool?.handler.previewInput?.(scope)) as ToolInputPreview;
    expect(preview.render(partial('{"ty'))).toBeUndefined();
    expect(preview.render(partial('{"type":"Pie"'))).toBeNull();
  });

  it('previews only what the client declared it draws', async () => {
    const [tool] = genuiTools(catalog, { mode: 'tree', streaming: 'partial' });
    const preview = (await tool?.handler.previewInput?.({
      ...scope,
      uiCapabilities: { components: [{ name: 'Card', version: 1 }] },
    })) as ToolInputPreview;
    expect(preview.render(partial('{"type":"Card","props":{}'))).toBeDefined();
    // A Chart would make the final push degrade to text for this client: withdraw.
    expect(preview.render(partial('{"type":"Card","children":[{"type":"Chart"'))).toBeNull();
    // A text-only client (what a channel declares) gets no preview at all.
    expect(
      await tool?.handler.previewInput?.({ ...scope, uiCapabilities: { components: [] } }),
    ).toBeUndefined();
  });

  it('rejects an unknown streaming value on a component', () => {
    expect(() => defineComponent({ ...Card, streaming: 'eager' as never })).toThrow(/streaming/);
  });
});

describe('previewToolInputs', () => {
  function recorder() {
    const frames: StreamFrame[] = [];
    const writer: SinkWriter = { write: (frame) => void frames.push(frame), end: () => {} };
    return { frames, writer };
  }
  const echo: ToolInputPreview = {
    render: (input) => ({ component: 'Echo', props: { value: input.value ?? null } }),
  };
  const start = (id = 'c1'): StreamFrame => ({
    t: 'event',
    event: { kind: 'tool-input-start', id, name: 'echo', toolKind: 'read' },
  });
  const delta = (delta: string, id = 'c1'): StreamFrame => ({
    t: 'event',
    event: { kind: 'tool-input-delta', id, delta },
  });
  const available = (input: unknown, id = 'c1'): StreamFrame => ({
    t: 'event',
    event: { kind: 'tool-input-available', id, name: 'echo', input, toolKind: 'read' },
  });
  const partials = (frames: StreamFrame[]) =>
    frames.filter((frame) => frame.t === 'component' && frame.partial === true);

  it('passes every frame through and adds partial frames under the push id', async () => {
    const { frames, writer } = recorder();
    const previews = previewToolInputs(writer, async (name) =>
      name === 'echo' ? echo : undefined,
    );
    await previews.writer.write(start());
    await previews.writer.write(delta('{"a":"x'));
    await previews.writer.write(available({ a: 'xy' }));
    expect(frames.map((frame) => (frame.t === 'event' ? frame.event.kind : frame.t))).toEqual([
      'tool-input-start',
      'tool-input-delta',
      'component',
      'tool-input-available',
      'component',
    ]);
    expect(partials(frames)).toEqual([
      {
        t: 'component',
        name: 'Echo',
        data: { value: { a: 'x' } },
        id: 'c1:ui:0',
        toolCallId: 'c1',
        partial: true,
      },
      {
        t: 'component',
        name: 'Echo',
        data: { value: { a: 'xy' } },
        id: 'c1:ui:0',
        toolCallId: 'c1',
        partial: true,
      },
    ]);
    expect(previews.shown()).toEqual([{ id: 'c1:ui:0', component: 'Echo', toolCallId: 'c1' }]);
  });

  it('throttles: at most one frame per interval, the rest coalesced into the next', async () => {
    let clock = 0;
    const { frames, writer } = recorder();
    const previews = previewToolInputs(
      writer,
      async () => ({ ...echo, throttleMs: 100 }),
      () => clock,
    );
    await previews.writer.write(start());
    const text = JSON.stringify({ items: Array.from({ length: 50 }, (_, index) => index) });
    // 200 deltas over 1s of model time: one every 5ms.
    const step = Math.ceil(text.length / 200);
    for (let at = 0; at < text.length; at += step) {
      clock += 5;
      await previews.writer.write(delta(text.slice(at, at + step)));
    }
    const live = partials(frames).length;
    expect(live).toBeGreaterThan(1);
    expect(live).toBeLessThanOrEqual(Math.ceil(clock / 100) + 1);
    await previews.writer.write(available(JSON.parse(text)));
    const last = partials(frames).at(-1) as Extract<StreamFrame, { t: 'component' }>;
    expect(last.data).toEqual({ value: JSON.parse(text) });
  });

  it('writes nothing for an unchanged preview, nor for a call without one', async () => {
    const { frames, writer } = recorder();
    const previews = previewToolInputs(writer, async (name) =>
      name === 'echo' ? { render: () => ({ component: 'Same', props: {} }) } : undefined,
    );
    await previews.writer.write(start());
    await previews.writer.write(delta('{"a'));
    await previews.writer.write(delta('":1}'));
    await previews.writer.write(available({ a: 1 }));
    expect(partials(frames)).toHaveLength(1);
    await previews.writer.write({
      t: 'event',
      event: { kind: 'tool-input-start', id: 'c2', name: 'other', toolKind: 'read' },
    });
    await previews.writer.write(delta('{}', 'c2'));
    expect(partials(frames)).toHaveLength(1);
  });

  it('withdraws what it showed when the preview gives up, and stops', async () => {
    const { frames, writer } = recorder();
    let calls = 0;
    const previews = previewToolInputs(writer, async () => ({
      throttleMs: 0,
      render: () => (calls++ === 0 ? { component: 'genui:tree', props: { root: {} } } : null),
    }));
    await previews.writer.write(start());
    await previews.writer.write(delta('{'));
    await previews.writer.write(delta('"x"'));
    await previews.writer.write(delta(':1'));
    expect(partials(frames)).toEqual([
      expect.objectContaining({ data: { root: {} } }),
      expect.objectContaining({ data: {}, id: 'c1:ui:0', partial: true }),
    ]);
    expect(calls).toBe(2);
    expect(previews.shown()).toEqual([]);
  });

  it('a preview that throws is dropped, never the turn', async () => {
    const { frames, writer } = recorder();
    const previews = previewToolInputs(writer, async () => ({
      render: () => {
        throw new Error('boom');
      },
    }));
    await previews.writer.write(start());
    await previews.writer.write(delta('{}'));
    expect(partials(frames)).toEqual([]);
    const failing = previewToolInputs(writer, async () => {
      throw new Error('no catalog');
    });
    await failing.writer.write(start('c3'));
    await failing.writer.write(delta('{}', 'c3'));
    expect(partials(frames)).toEqual([]);
  });
});
