import type { AgentDepsFactory } from './agent-deps-factory.js';
import type { ChatQueueService } from './chat-queue-service.js';
import type { PriceCatalogOptions } from './pricing/boot-pricing.js';
import type { AgentRunner } from './spi/agent-runner.js';
import type { AgentStore } from './spi/agent-store.js';
import type { ModelProvider } from './spi/model-provider.js';
import type { AgentPricingStore } from './spi/pricing-store.js';
import type { ProtocolAdapter } from './spi/protocol-adapter.js';
import type { TokenStreamSink } from './spi/token-stream-sink.js';
import type { ToolRegistry } from './tool-registry.js';

/**
 * What the provider hands an engine when it builds the runner: the same graph the library's own
 * runners are built from. Everything around a turn stays the library's — the routes and the stream
 * protocol, threads and the store, the sink, approvals and answers routed through `AgentService`, the
 * queue — and the engine reads the agent's prompt, approval policy, skills and memory off `factory`.
 */
export interface AgentEngineContext {
  factory: AgentDepsFactory;
  store: AgentStore;
  sink: TokenStreamSink;
  registry: ToolRegistry;
  /** The thread message queue: a settling turn hands its thread to the next queued message. */
  queue: ChatQueueService;
  /**
   * Resolve a container binding (e.g. `@adonis-agora/durable`'s `WorkflowEngine`). Absent when the
   * engine is wired outside an AdonisJS app (a test building the graph by hand).
   */
  make?: <T = unknown>(binding: unknown) => Promise<T>;
  /** The app's `APP_KEY`, when there is one — a stable secret for whatever the engine signs. */
  appKey?: string;
  /** The configured pricing store, so an engine prices the calls it reports like the loop does. */
  pricingStore?: AgentPricingStore;
  /** `priceCatalog` from `config/agent.ts`. */
  priceCatalog?: PriceCatalogOptions | false;
}

/**
 * Something other than this library's loop that runs a turn — what `engine` in `config/agent.ts`
 * takes. An engine owns the turn end to end (the model calls, the tools, the context it keeps) and
 * builds the {@link AgentRunner} the service runs turns on; everything around the turn stays the
 * library's.
 *
 * `openCode()` (`@adonis-agora/agent/opencode`) is the one that ships. An engine replaces the loop,
 * so the options only the loop reads (`model`, processors, `maxSteps`, `historyWindow`, `retriever`,
 * delegation) do nothing under one, and `model` becomes optional.
 */
export interface AgentEngine {
  /** For logs and diagnostics. */
  readonly name: string;
  /**
   * The engine checkpoints its own turns (`openCodeDurable()`). `durable: true` in the config names the
   * LOOP's durable runner, which an engine replaces — so it is refused next to an engine that is not
   * durable itself, rather than silently ignored.
   */
  readonly durable?: boolean;
  /** Build the runner the service starts, signals and cancels turns on. Called once, at boot. */
  createRunner(context: AgentEngineContext): AgentRunner | Promise<AgentRunner>;
  /**
   * Routes the engine serves next to the agent's own (e.g. the MCP endpoint OpenCode reaches the
   * app's tools through), mounted like `adapters` once {@link createRunner} has run.
   */
  adapters?(): readonly ProtocolAdapter[];
  /** Release what the engine holds (event streams, timers) when the app shuts down. */
  shutdown?(): void | Promise<void>;
}

/** `engine` in `config/agent.ts`: an engine, or a lazy factory so its module loads with the config. */
export type AgentEngineFactory = () => AgentEngine | Promise<AgentEngine>;

/**
 * Refuse a wiring that cannot run a turn, at boot rather than on the first message: no `model` and
 * no `engine` leaves the loop nothing to call, and `durable: true` names the loop's own durable
 * runner, which a non-durable engine replaces (a durable engine brings its own durability).
 */
export function assertRunnable(options: {
  model?: unknown;
  engine?: AgentEngine | undefined;
  durable?: boolean | undefined;
}): void {
  const { engine } = options;
  if (engine !== undefined && options.durable === true && engine.durable !== true) {
    throw new Error(
      `[@adonis-agora/agent] \`durable: true\` runs turns on the library's loop, but the \`${engine.name}\` engine runs them instead. Drop \`durable\`, or use the engine's durable variant.`,
    );
  }
  if (engine === undefined && options.model === undefined) {
    throw new Error(
      '[@adonis-agora/agent] set `model` in config/agent.ts (the loop runs the turns) or `engine` (something else does).',
    );
  }
}

/**
 * The model the loop is handed when an engine runs the turns and no `model` is configured: nothing
 * of the library's calls it on that path, and a caller that does (a background summarizer reading
 * `deps.model`) is told why instead of crashing on `undefined`.
 */
export function engineOnlyModel(engine: AgentEngine): ModelProvider {
  return {
    async runTurn() {
      throw new Error(
        `[@adonis-agora/agent] the \`${engine.name}\` engine runs this deployment's turns and no \`model\` is configured; set \`model\` for anything that calls the loop's model directly.`,
      );
    },
  };
}
