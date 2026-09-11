import type { SkillsConfig } from './skills.js';
import type { AgentStore } from './spi/agent-store.js';
import type { HistoryWindow } from './spi/history-window.js';
import type { ModelProvider } from './spi/model-provider.js';
import type { AgentPricingStore } from './spi/pricing-store.js';
import type { QuotaStore } from './spi/quota-store.js';
import type { Retriever } from './spi/retriever.js';
import type { RolesPolicy } from './spi/roles-policy.js';
import type { TokenStreamSink } from './spi/token-stream-sink.js';
import type { ToolRegistry } from './tool-registry.js';
import type { ToolTransientRetrySetting } from './tool-retry.js';
import type { Actor, Persona, PromptBuilder } from './types.js';

/** Everything `runAgentLoop` needs, minus the per-run `day` the runner stamps. */
export interface AgentDeps {
  model: ModelProvider;
  store: AgentStore;
  registry: ToolRegistry;
  rolesPolicy: RolesPolicy;
  quota?: QuotaStore;
  /** Prices each turn's tokens into `usage.costUsd`. Omit → cost is always `null`. */
  pricingStore?: AgentPricingStore;
  sink: TokenStreamSink;
  /** Fallback accounting label; the provider's turn result overrides it when set. */
  modelId?: string;
  systemPrompt: string | PromptBuilder;
  maxSteps: number;
  personas: Map<string, Persona>;
  defaultPersona: string;
  /** Agent-level tool allow-list (intersected with the persona's). Undefined → all tools. */
  toolAllowList?: string[];
  /** Inject-mode retriever: when set, the loop retrieves + folds context into the prompt each run. */
  retriever?: Retriever;
  /** How many passages inject-mode retrieval requests. Undefined → 5. */
  retrievalTopK?: number;
  /**
   * Derives the metadata filter applied to inject-mode RAG retrieval, from the run's actor.
   * Without it, retrieval is UNSCOPED. See the doc comment on `AgentConfig.retrievalFilter`.
   */
  retrievalFilter?: (actor: Actor) => Record<string, unknown>;
  /**
   * In-place transient-retry policy for a tool's own invocation (DB deadlock / lock-wait timeout /
   * serialization failure). Undefined → the loop's default (`{ attempts: 2, backoffMs: 150 }`);
   * `false` disables it.
   */
  toolTransientRetry?: ToolTransientRetrySetting;
  /** Bounds how much of the persisted thread rides the model call each turn. Omit → full history every turn. */
  historyWindow?: HistoryWindow;
  /**
   * Authored procedures the model can pull in mid-turn, scoped by the host's own tokens. Omit → no
   * catalog block and no `skill` tool.
   */
  skills?: SkillsConfig;
}

/** The UTC calendar day (`YYYY-MM-DD`) a run is accounted against — deterministic for quota/day. */
export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
