import { type AgentEngineContext, engineOnlyModel } from '../../src/engine.js';
import {
  type Actor,
  type AgentConfig,
  type AgentDefinition,
  AgentDepsFactory,
  type AgentEngine,
  AgentRegistry,
  AgentService,
  type AgentStreamEvent,
  ChatQueueService,
  DefaultToolAuthorizer,
  type ElicitationReply,
  frameToEvents,
  type MemoryConfig,
  type SkillsConfig,
  type StreamFrame,
  ToolRegistry,
  toApprovalPolicy,
} from '../../src/index.js';
import type { OpenCodeEngine } from '../../src/opencode/engine.js';
import type { OpenCodeHost, OpenCodeServer, OpenCodeTurnContext } from '../../src/opencode/host.js';
import type { OpenCodeTurns } from '../../src/opencode/turns.js';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '../../src/testing/index.js';
import { FakeOpenCode, type FakeScript } from './fake-opencode.js';

/** A host on one in-memory OpenCode server, whose boot id a test can change (a restart). */
export class TestHost implements OpenCodeHost {
  bootId = 'boot-1';
  constructor(readonly fake: FakeOpenCode) {}

  async server(): Promise<OpenCodeServer> {
    return { client: this.fake, key: 'tenant-1', bootId: this.bootId };
  }

  async session(_context: OpenCodeTurnContext) {
    return {
      location: { directory: '/work/u1' },
      permissions: [{ action: '*', resource: '*', effect: 'deny' as const }],
    };
  }
}

export interface Harness {
  engine: OpenCodeEngine;
  turns: OpenCodeTurns;
  fake: FakeOpenCode;
  host: TestHost;
  store: InMemoryAgentStore;
  sink: InMemoryTokenStreamSink;
  registry: ToolRegistry;
  service: AgentService;
  close(): Promise<void>;
}

/**
 * The agent's graph — store, sink, registry, deps factory, queue, service — with the runner an
 * engine builds, as the provider wires it. No HTTP: the service is the surface the routes call.
 */
export async function bootEngine(args: {
  engine: (host: TestHost) => OpenCodeEngine;
  script?: FakeScript;
  defaultAgent?: Omit<AgentDefinition, 'name'>;
  options?: Pick<AgentConfig, 'skills' | 'memory'> & {
    approvalPolicy?: AgentConfig['approvalPolicy'];
    skills?: SkillsConfig;
    memory?: MemoryConfig;
  };
  register?: (registry: ToolRegistry) => void;
  appKey?: string;
  pricingStore?: AgentEngineContext['pricingStore'];
  priceCatalog?: AgentEngineContext['priceCatalog'];
}): Promise<Harness> {
  const fake = new FakeOpenCode(args.script);
  const host = new TestHost(fake);
  const engine = args.engine(host);
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const registry = new ToolRegistry();
  args.register?.(registry);
  const agents = new AgentRegistry();
  agents.register({ name: 'default', ...(args.defaultAgent ?? {}) });
  const options = args.options ?? {};
  const factory = new AgentDepsFactory({
    model: engineOnlyModel(engine as AgentEngine),
    store,
    sink,
    rolesPolicy: new DefaultToolAuthorizer([], { emptyRoles: 'allow' }),
    registry,
    agents,
    ...(options.approvalPolicy !== undefined
      ? { approvalPolicy: toApprovalPolicy(options.approvalPolicy) }
      : {}),
    ...(options.skills !== undefined ? { skills: options.skills } : {}),
    ...(options.memory !== undefined ? { memory: options.memory } : {}),
  });
  const queue = new ChatQueueService(store, sink);
  const runner = await engine.createRunner({
    factory,
    store,
    sink,
    registry,
    queue,
    ...(args.appKey !== undefined ? { appKey: args.appKey } : {}),
    ...(args.pricingStore !== undefined ? { pricingStore: args.pricingStore } : {}),
    priceCatalog: args.priceCatalog ?? { modelsDev: false },
  });
  const service = new AgentService(runner, store, factory, { queue });
  return {
    engine,
    turns: engine.turns,
    fake,
    host,
    store,
    sink,
    registry,
    service,
    async close() {
      await engine.shutdown?.();
    },
  };
}

/** A failed run's `event: error`, as a reader of the stream sees it. */
export class StreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Frames until one matching `until` arrives (for runs parked on a person), as wire events. */
export async function framesUntil(
  service: AgentService,
  runId: string,
  until: (event: AgentStreamEvent) => boolean,
): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = [];
  let position = 0;
  for await (const frame of service.subscribe(runId) as AsyncIterable<StreamFrame>) {
    if (frame.t === 'error') throw new StreamError(frame.code, frame.message);
    for (const event of frameToEvents(frame, position)) {
      // The wire extras (`runId`, `toolName`, `input`) ride outside the shared vocabulary.
      out.push(event);
      if (until(event)) return out;
    }
    position += 1;
  }
  return out;
}

/** Every frame of a run's stream, to its end, as wire events. Rejects on `event: error`. */
export function frames(service: AgentService, runId: string): Promise<AgentStreamEvent[]> {
  return framesUntil(service, runId, () => false);
}

export const textOf = (events: AgentStreamEvent[]) =>
  events.flatMap((event) => (event.kind === 'text' ? [event.text] : [])).join('');

/** The protocol event without the wire extras the SSE encoder adds. */
export function bare(event: AgentStreamEvent | undefined): unknown {
  if (event === undefined) return undefined;
  const { runId: _r, toolName: _t, input: _i, ...rest } = event as Record<string, unknown>;
  return event.kind === 'approval-requested' ? rest : event;
}

/** Approve a call by its id, as the approve route does (the run looked up from the call). */
export async function approve(
  service: AgentService,
  toolCallId: string,
  opts: { via?: string; remember?: boolean; executedByRef?: string } = {},
): Promise<void> {
  const runId = await service.toolCallRun(toolCallId);
  if (runId === null) throw new Error(`no run for ${toolCallId}`);
  await service.approve(runId, toolCallId, opts);
}

export async function reject(
  service: AgentService,
  toolCallId: string,
  reason?: string,
): Promise<void> {
  const runId = await service.toolCallRun(toolCallId);
  if (runId === null) throw new Error(`no run for ${toolCallId}`);
  await service.reject(runId, toolCallId, reason);
}

export async function answer(
  service: AgentService,
  toolCallId: string,
  answers: ElicitationReply['answers'],
): Promise<void> {
  const runId = await service.toolCallRun(toolCallId);
  if (runId === null) throw new Error(`no run for ${toolCallId}`);
  await service.answer({ runId, toolCallId, answers });
}

export async function eventually(
  check: () => boolean | Promise<boolean>,
  what: string,
): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`never: ${what}`);
}

export const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
