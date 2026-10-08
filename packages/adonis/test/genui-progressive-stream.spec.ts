import { afterEach, describe, expect, it } from 'vitest';
import { agUiAdapter } from '../src/ag-ui/index.js';
import { channels } from '../src/channels/index.js';
import { Card, Chart, DataTable, KpiCards } from '../src/genui/builtins.js';
import { type Catalog, defineCatalog, type GenuiToolsOptions, genui } from '../src/genui/index.js';
import type {
  ModelProvider,
  ModelTurnArgs,
  ModelTurnResult,
  StreamFrame,
  ThreadDetail,
} from '../src/index.js';
import { type BootedApp, bootAgentApp, readSse, type SseFrame } from './helpers/boot-agent-app.js';
import { actor, fakeAdapter, fakeService, inbound, makeCtx, texts } from './helpers/channels.js';

const catalog = defineCatalog([Card, Chart, DataTable, KpiCards]);

const chart = (type: string) => ({
  type: 'Chart',
  props: {
    type,
    title: 'Revenue',
    xKey: 'month',
    series: [{ key: 'revenue' }],
    data: [
      { month: 'Jan', revenue: 1200 },
      { month: 'Feb', revenue: 1800 },
    ],
  },
});

const dashboard = (chartType = 'bar') => ({
  type: 'Card',
  props: { title: 'Sales dashboard', subtitle: 'January – June' },
  children: [
    { type: 'KpiCards', props: { items: [{ label: 'Revenue', value: '$3.0k', trend: 'up' }] } },
    chart(chartType),
  ],
});

/**
 * A model that streams its `ui__render` arguments in chunks, as `aiSdkModel` relays a real
 * provider's `tool-input-delta`s. Turn 0 renders `first`; after a tool error, turn 1 renders `retry`.
 */
class StreamingTreeModel implements ModelProvider {
  constructor(
    private readonly first: unknown,
    private readonly retry: unknown = dashboard(),
  ) {}

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const turn = args.messages.filter((message) => message.role === 'assistant').length;
    const results = args.messages.flatMap((message) => message.toolResults ?? []);
    if (results.some((result) => result.error === undefined)) {
      await args.sink.write({ t: 'text', v: 'There.' });
      return { text: 'There.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    }
    const input = turn === 0 ? this.first : this.retry;
    const id = `call-${turn}`;
    const json = JSON.stringify(input);
    await args.sink.write({
      t: 'event',
      event: { kind: 'tool-input-start', id, name: 'ui__render', toolKind: 'read' },
    });
    for (let at = 0; at < json.length; at += 24) {
      await args.sink.write({
        t: 'event',
        event: { kind: 'tool-input-delta', id, delta: json.slice(at, at + 24) },
      });
    }
    await args.sink.write({
      t: 'event',
      event: { kind: 'tool-input-available', id, name: 'ui__render', input, toolKind: 'read' },
    });
    return {
      text: '',
      toolCalls: [{ id, name: 'ui__render', input }],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

const headers = { 'content-type': 'application/json', 'x-actor-id': 'u1' };

let booted: BootedApp | null = null;
afterEach(async () => {
  await booted?.close();
  booted = null;
});

async function boot(
  model: ModelProvider,
  options: Partial<GenuiToolsOptions> & { catalog?: Catalog } = {},
): Promise<BootedApp> {
  booted = await bootAgentApp({
    model,
    genui: genui({
      catalog,
      mode: 'tree',
      streaming: 'partial',
      streamingThrottleMs: 0,
      ...options,
    }),
    adapters: [agUiAdapter({ quietMs: 80 })],
  });
  return booted;
}

async function chat(body: Record<string, unknown> = {}) {
  const response = await fetch(`${booted?.url}/agent/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: 'dashboard', ...body }),
  });
  const runId = response.headers.get('x-agent-run-id') as string;
  const threadId = response.headers.get('x-agent-thread-id') as string;
  return { runId, threadId, frames: await readSse(response) };
}

const uiFrames = (frames: SseFrame[]) => frames.filter((frame) => frame.data.kind === 'ui');
type Node = { id: string; type: string; incomplete?: true; held?: true; children?: Node[] };
const rootOf = (frame: SseFrame) => (frame.data.props as { root?: Node }).root;

describe('progressive ui__render over the native stream', () => {
  it('streams partial trees under the final id, then the validated tree replaces them', async () => {
    await boot(new StreamingTreeModel(dashboard()));
    const { frames, threadId } = await chat();
    const ui = uiFrames(frames);
    expect(ui.length).toBeGreaterThan(3);
    expect(new Set(ui.map((frame) => frame.data.id))).toEqual(new Set(['call-0:ui:0']));
    const finalFrame = ui.at(-1) as SseFrame;
    const previews = ui.slice(0, -1);
    expect(previews.every((frame) => frame.data.partial === true)).toBe(true);
    // No preview carries fallback text: there is nothing final to say yet.
    expect(previews.some((frame) => 'fallbackText' in frame.data)).toBe(false);
    // The layout grows: the root first, flagged incomplete, then its children one by one.
    expect(rootOf(previews[0] as SseFrame)).toMatchObject({
      id: 'root',
      type: 'Card',
      incomplete: true,
    });
    expect(
      previews.some((frame) =>
        rootOf(frame)?.children?.some((child) => child.type === 'Chart' && child.incomplete),
      ),
    ).toBe(true);
    // The final frame is the validated push, as without previews.
    expect(finalFrame.data.partial).toBeUndefined();
    expect(finalFrame.data.fallbackText).toEqual(expect.stringContaining('Sales dashboard'));
    expect(rootOf(finalFrame)).toEqual(dashboard());
    // The previews precede the tool's outcome; the final frame too.
    const outcome = frames.findIndex((frame) => frame.data.kind === 'tool-output');
    expect(frames.indexOf(finalFrame)).toBeLessThan(outcome);

    // Persisted: the final tree alone.
    const thread = (await (
      await fetch(`${booted?.url}/agent/threads/${threadId}`, { headers })
    ).json()) as ThreadDetail;
    const persisted = thread.messages.flatMap((message) => message.ui ?? []);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ id: 'call-0:ui:0', component: 'genui:tree' });
    expect(persisted[0]?.partial).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toMatch(/incomplete|held/);
  });

  it('replays (and re-attaches after a seq) to the same final tree', async () => {
    await boot(new StreamingTreeModel(dashboard()));
    const { runId, frames } = await chat();
    const last = uiFrames(frames).at(-1) as SseFrame;
    const replay = await readSse(
      await fetch(`${booted?.url}/agent/chat/${runId}/stream`, { headers }),
    );
    expect(uiFrames(replay).map((frame) => frame.data)).toEqual(
      uiFrames(frames).map((frame) => frame.data),
    );
    // Re-attached mid-preview: what follows still ends on the final tree.
    const raw = await (
      await fetch(`${booted?.url}/agent/chat/${runId}/stream`, { headers })
    ).text();
    const seqs = [...raw.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    const middle = seqs[Math.floor(seqs.length / 3)] as number;
    const rest = uiFrames(
      await readSse(
        await fetch(`${booted?.url}/agent/chat/${runId}/stream?after=${middle}`, { headers }),
      ),
    );
    expect(rest.at(-1)?.data).toEqual(last.data);
  });

  it('streams nothing partial by default (streaming: complete)', async () => {
    await boot(new StreamingTreeModel(dashboard()), { streaming: 'complete' });
    const ui = uiFrames((await chat()).frames);
    expect(ui).toHaveLength(1);
    expect(ui[0]?.data.partial).toBeUndefined();
  });

  it('validates only the final tree: an invalid one is withdrawn, the retry replaces nothing of it', async () => {
    await boot(new StreamingTreeModel(dashboard('pie'), dashboard('bar')));
    const { frames, threadId } = await chat();
    const kinds = frames.map((frame) =>
      frame.data.kind === 'ui'
        ? `ui:${String(frame.data.id)}:${frame.data.partial === true ? (Object.keys(frame.data.props as object).length === 0 ? 'withdrawn' : 'partial') : 'final'}`
        : String(frame.data.kind),
    );
    // The pie chart previewed (props are not validated while streaming)...
    expect(kinds).toContain('ui:call-0:ui:0:partial');
    // ...was refused by the final validation, and its preview withdrawn before the error.
    const withdrawn = kinds.indexOf('ui:call-0:ui:0:withdrawn');
    const error = kinds.indexOf('tool-output-error');
    expect(withdrawn).toBeGreaterThan(-1);
    expect(withdrawn).toBeLessThan(error);
    expect(kinds).not.toContain('ui:call-0:ui:0:final');
    // The model read the error and retried: that call previews and lands under its own id.
    expect(kinds.filter((kind) => kind === 'ui:call-1:ui:0:final')).toHaveLength(1);
    const thread = (await (
      await fetch(`${booted?.url}/agent/threads/${threadId}`, { headers })
    ).json()) as ThreadDetail;
    expect(thread.messages.flatMap((message) => message.ui ?? []).map((ui) => ui.id)).toEqual([
      'call-1:ui:0',
    ]);
  });

  it('holds a component that streams complete until its subtree has arrived', async () => {
    await boot(new StreamingTreeModel(dashboard()), {
      catalog: defineCatalog([Card, KpiCards, { ...Chart, streaming: 'complete' }]),
    });
    const previews = uiFrames((await chat()).frames).filter((frame) => frame.data.partial);
    const charts = previews
      .map((frame) => rootOf(frame)?.children?.find((child) => child.type === 'Chart'))
      .filter((node) => node !== undefined) as Array<Node & { props: Record<string, unknown> }>;
    expect(charts.length).toBeGreaterThan(1);
    // Every Chart drawn while it was being written is a placeholder with no props...
    const writing = charts.filter((node) => node.incomplete === true);
    expect(writing.length).toBeGreaterThan(0);
    for (const node of writing)
      expect(node).toEqual({
        id: 'root.1',
        type: 'Chart',
        props: {},
        incomplete: true,
        held: true,
      });
    // ...and the first one with props has them whole.
    const drawn = charts.find((node) => node.held === undefined);
    expect(drawn?.props).toEqual(chart('bar').props);
  });

  it('previews only for a client that draws the tree: a text-only one gets the final text', async () => {
    await boot(new StreamingTreeModel(dashboard()));
    const { frames } = await chat({ uiCapabilities: { components: [] } });
    expect(uiFrames(frames)).toEqual([]);
    const text = frames
      .filter((frame) => frame.data.kind === 'text')
      .map((frame) => frame.data.text)
      .join('');
    expect(text).toContain('Sales dashboard');
  });
});

describe('progressive ui__render over AG-UI', () => {
  it('sends each preview as an agora.ui event with the same id, the final one last', async () => {
    await boot(new StreamingTreeModel(dashboard()));
    const response = await fetch(`${booted?.url}/agent/ag-ui`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        threadId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        messages: [{ id: 'm1', role: 'user', content: 'dashboard' }],
      }),
    });
    const events = (await readSse(response)).map((frame) => frame.data);
    const ui = events.filter((event) => event.type === 'CUSTOM' && event.name === 'agora.ui');
    const values = ui.map((event) => event.value as Record<string, unknown>);
    expect(values.length).toBeGreaterThan(3);
    expect(new Set(values.map((value) => value.id))).toEqual(new Set(['call-0:ui:0']));
    expect(values.slice(0, -1).every((value) => value.partial === true)).toBe(true);
    expect(values.at(-1)?.partial).toBeUndefined();
    expect((values.at(-1) as { props: { root: unknown } }).props.root).toEqual(dashboard());
  });
});

describe('progressive ui__render on a text channel', () => {
  it('a channel never sees a preview: only the final fallback text', async () => {
    const preview = (props: Record<string, unknown>): StreamFrame => ({
      t: 'component',
      id: 'call-0:ui:0',
      name: 'genui:tree',
      data: props,
      toolCallId: 'call-0',
      partial: true,
    });
    const { adapter, outbox } = fakeAdapter();
    const handle = channels.handle(adapter, {
      service: fakeService([
        preview({ root: { id: 'root', type: 'Card', props: { title: 'Sal' }, incomplete: true } }),
        preview({
          root: { id: 'root', type: 'Card', props: { title: 'Sales' }, incomplete: true },
        }),
        {
          t: 'component',
          id: 'call-0:ui:0',
          name: 'genui:tree',
          data: { root: { type: 'Card', props: { title: 'Sales' } } },
          toolCallId: 'call-0',
          fallbackText: '*Sales*',
        },
        { t: 'text', v: 'There.' },
      ]),
      actor: () => actor,
      thread: () => 't',
      uiCapabilities: { components: [{ name: 'Card', version: 1 }] },
      renderComponent: (component) => {
        if ((component.data as { root?: { incomplete?: true } }).root?.incomplete)
          throw new Error('a preview reached the channel');
        return null;
      },
    });
    await handle(makeCtx(inbound('dashboard')).ctx);
    await handle.drain();
    expect(texts(outbox)).toEqual(['*Sales*\n\nThere.']);
  });
});
