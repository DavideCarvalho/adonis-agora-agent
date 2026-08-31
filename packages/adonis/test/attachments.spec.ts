import { InMemoryStateStore, WorkflowEngine } from '@adonis-agora/durable';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DurableAgentRunner,
  registerAgentWorkflow,
  setDurableAgentContext,
} from '../src/durable/index.js';
import type { Actor, MessageAttachment, ModelMessage } from '../src/index.js';
import {
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  DefaultToolAuthorizer,
  InlineAgentRunner,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryAttachmentStagingStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean | Promise<boolean>, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return;
    await sleep(5);
  }
  throw new Error('waitFor: condition never became true');
}

function buildInline(script: FakeScript) {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const registry = new ToolRegistry();
  const agents = new AgentRegistry();
  const factory = new AgentDepsFactory({
    model: new FakeModelProvider(script),
    store,
    sink,
    rolesPolicy: new DefaultToolAuthorizer(),
    registry,
    agents,
  });
  const runner = new InlineAgentRunner(factory, store);
  const service = new AgentService(runner, store, factory);
  return { service, store, sink, registry };
}

function buildDurable(script: FakeScript) {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const registry = new ToolRegistry();
  const agents = new AgentRegistry();
  const factory = new AgentDepsFactory({
    model: new FakeModelProvider(script),
    store,
    sink,
    rolesPolicy: new DefaultToolAuthorizer(),
    registry,
    agents,
  });
  const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
  setDurableAgentContext({ factory, store });
  registerAgentWorkflow(engine);
  const runner = new DurableAgentRunner(engine);
  const service = new AgentService(runner, store, factory);
  return { service, store, sink, registry, engine };
}

async function collectStream(service: AgentService, runId: string): Promise<string> {
  let text = '';
  for await (const frame of service.subscribe(runId)) {
    if (frame.t === 'text') text += frame.v;
  }
  return text;
}

afterEach(() => {
  setDurableAgentContext(undefined);
});

describe('attachment staging (in-memory)', () => {
  it('stages an uploaded file into a data-URL MessageAttachment and records it', async () => {
    const staging = new InMemoryAttachmentStagingStore();
    const attachment = await staging.stage({
      data: Buffer.from('hello world'),
      filename: 'note.txt',
      contentType: 'text/plain',
      sizeBytes: 11,
      actor,
    });

    expect(attachment).toMatchObject({
      mediaId: 'media-1',
      contentType: 'text/plain',
      name: 'note.txt',
    });
    // The url is a model-fetchable data URL carrying the base64 bytes.
    expect(attachment.url).toBe(
      `data:text/plain;base64,${Buffer.from('hello world').toString('base64')}`,
    );
    expect(staging.staged).toEqual([
      {
        mediaId: 'media-1',
        filename: 'note.txt',
        contentType: 'text/plain',
        sizeBytes: 11,
        actorId: 'u1',
      },
    ]);
  });
});

describe('multimodal messages (inline)', () => {
  it('threads staged attachments to the model turn and persists them on the user message', async () => {
    let seen: ModelMessage[] = [];
    const script: FakeScript = (args) => {
      seen = args.messages;
      return { text: 'i see them' };
    };
    const g = buildInline(script);
    const staging = new InMemoryAttachmentStagingStore();
    const image = await staging.stage({
      data: Buffer.from('PNGDATA'),
      filename: 'pic.png',
      contentType: 'image/png',
      sizeBytes: 7,
      actor,
    });
    const doc = await staging.stage({
      data: Buffer.from('%PDF-1.7'),
      filename: 'report.pdf',
      contentType: 'application/pdf',
      sizeBytes: 8,
      actor,
    });

    const { runId } = await g.service.chat({
      actor,
      message: 'what is in these?',
      attachments: [image, doc],
    });
    await collectStream(g.service, runId);

    // The model turn's user message carries both attachments (image + file), so the adapter renders
    // them as native content parts.
    const userMsg = seen.find((m) => m.role === 'user');
    expect(userMsg?.attachments).toEqual([image, doc]);
    // They persist on the stored user message, so a re-load / replay sends the same parts.
    const thread = await g.store.getThread((await g.store.listThreads('u1'))[0]?.id ?? '');
    const storedUser = thread?.messages.find((m) => m.role === 'user');
    expect(storedUser?.attachments).toEqual([image, doc]);
  });

  it('leaves a text-only message with no attachments field (back-compatible)', async () => {
    let seen: ModelMessage[] = [];
    const script: FakeScript = (args) => {
      seen = args.messages;
      return { text: 'ok' };
    };
    const g = buildInline(script);

    const { runId } = await g.service.chat({ actor, message: 'plain question' });
    await collectStream(g.service, runId);

    const userMsg = seen.find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('plain question');
    expect(userMsg && 'attachments' in userMsg).toBe(false);
  });
});

describe('multimodal messages (durable replay)', () => {
  it('memoizes the attachment persist across a suspend/resume — persisted exactly once', async () => {
    const attachment: MessageAttachment = {
      mediaId: 'media-1',
      url: 'data:image/png;base64,QUJD',
      contentType: 'image/png',
      name: 'pic.png',
    };
    let sawAttachmentAfterResume = false;
    // Turn 0 requests an action tool → the run suspends on approval; the body replays on resume.
    const script: FakeScript = (args, turnIndex) => {
      if (turnIndex === 0) {
        return { text: 'acting', toolCall: { name: 'danger', input: {} } };
      }
      // On the resumed replay the user message must still carry the attachment.
      sawAttachmentAfterResume = args.messages.some(
        (m) => m.role === 'user' && (m.attachments?.length ?? 0) === 1,
      );
      return { text: 'done' };
    };
    const g = buildDurable(script);
    g.registry.register(
      {
        name: 'danger',
        kind: 'action',
        description: 'dangerous',
        inputSchema: z.object({}),
        roles: ['ADMIN'],
      },
      { execute: async () => ({ ok: true }) },
    );

    const { runId } = await g.service.chat({
      actor,
      message: 'look at this',
      attachments: [attachment],
    });
    await waitFor(() => g.store.toolCallRows().some((r) => r.status === 'pending_approval'));

    await g.service.approve(runId, 'call-0-danger');
    await waitFor(async () => (await g.engine.getRun(runId))?.status === 'completed');

    // The workflow body replayed after resume, but `persist:user` was checkpointed — the user message
    // (with its attachment) exists exactly once, and the resumed turn still saw the attachment.
    const thread = await g.store.getThread((await g.store.listThreads('u1'))[0]?.id ?? '');
    const userMessages = thread?.messages.filter((m) => m.role === 'user') ?? [];
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.attachments).toEqual([attachment]);
    expect(sawAttachmentAfterResume).toBe(true);
  });
});
