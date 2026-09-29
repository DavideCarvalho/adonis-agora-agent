import { describe, expect, it } from 'vitest';
import {
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  DefaultToolAuthorizer,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  type ModelProvider,
  type StreamFrame,
  ToolRegistry,
} from '../src/index.js';
import { InMemoryAgentStore } from '../src/testing/index.js';
import { observeTurnFrames, withTurnFrames } from '../src/turn-frames.js';

describe('observeTurnFrames', () => {
  it('sums each burst of reasoning and keeps the last props per ui id in first-seen order', async () => {
    let clock = 1000;
    const written: StreamFrame[] = [];
    const observed = observeTurnFrames(
      { write: (frame) => void written.push(frame), end: () => {} },
      () => clock,
    );
    await observed.writer.write({ t: 'event', event: { kind: 'reasoning', text: 'first ' } });
    clock = 1400;
    await observed.writer.write({ t: 'event', event: { kind: 'reasoning', text: 'thought' } });
    clock = 1500;
    await observed.writer.write({ t: 'text', v: 'answer' }); // closes a 500ms burst
    await observed.writer.write({
      t: 'event',
      event: { kind: 'ui', id: 'u1', component: 'Card', props: { n: 1 } },
    });
    await observed.writer.write({
      t: 'component',
      name: 'Chart',
      data: 7,
      id: 'c:ui:0',
      toolCallId: 'c',
    });
    await observed.writer.write({
      t: 'event',
      event: { kind: 'ui', id: 'u1', component: 'Card', props: { n: 2 } },
    });
    clock = 2000;
    await observed.writer.write({ t: 'event', event: { kind: 'reasoning', text: '!' } });
    clock = 2250; // an open burst closes when the summary is taken

    expect(written).toHaveLength(7);
    expect(observed.summary()).toEqual({
      reasoning: 'first thought!',
      reasoningMs: 750,
      ui: [
        { id: 'u1', component: 'Card', props: { n: 2 } },
        { id: 'c:ui:0', component: 'Chart', props: { value: 7 }, toolCallId: 'c' },
      ],
    });
  });

  it("lets a provider's own values win", () => {
    const result = {
      text: '',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      reasoningMs: 5,
    };
    expect(withTurnFrames(result, { reasoning: 'x', reasoningMs: 900 })).toMatchObject({
      reasoning: 'x',
      reasoningMs: 5,
    });
  });
});

describe('the loop persists what the turn streamed', () => {
  it('stores reasoning and its duration on the assistant message and streams it on step-finish', async () => {
    const model: ModelProvider = {
      async runTurn(args) {
        await args.sink.write({ t: 'event', event: { kind: 'reasoning', text: 'Considering…' } });
        await args.sink.write({ t: 'text', v: 'Done.' });
        return { text: 'Done.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const store = new InMemoryAgentStore();
    const sink = new InProcessTokenStreamSink();
    const factory = new AgentDepsFactory({
      model,
      store,
      sink,
      rolesPolicy: new DefaultToolAuthorizer(),
      registry: new ToolRegistry(),
      agents: new AgentRegistry(),
    });
    const service = new AgentService(new InlineAgentRunner(factory, store), store, factory);
    const { runId, threadId } = await service.chat({ actor: { id: 'u1' }, message: 'go' });
    const frames: StreamFrame[] = [];
    for await (const frame of service.subscribe(runId)) frames.push(frame);

    const thread = await store.getThread(threadId);
    const assistant = thread?.messages.find((message) => message.role === 'assistant');
    expect(assistant?.reasoning).toBe('Considering…');
    expect(typeof assistant?.reasoningMs).toBe('number');
    const finish = frames.find(
      (frame) => frame.t === 'event' && frame.event.kind === 'step-finish',
    );
    expect(finish).toMatchObject({ event: { reasoningMs: assistant?.reasoningMs } });
  });
});
