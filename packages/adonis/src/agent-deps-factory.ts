import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { AgentDeps } from './agent-deps.js';
import type { AgentRegistry } from './agent-registry.js';
import type { AgentStore } from './spi/agent-store.js';
import type { ModelProvider } from './spi/model-provider.js';
import type { AgentPricingStore } from './spi/pricing-store.js';
import type { QuotaStore } from './spi/quota-store.js';
import type { Retriever } from './spi/retriever.js';
import type { RolesPolicy } from './spi/roles-policy.js';
import type { TokenStreamSink } from './spi/token-stream-sink.js';
import type { ToolRegistry } from './tool-registry.js';
import type { ToolTransientRetrySetting } from './tool-retry.js';
import type { Actor, AgentDefinition, DelegateEdge, Persona } from './types.js';

/** The synthesized `agent`-kind tool name an orchestrator uses to delegate to `target`. */
export function delegateToolName(target: string): string {
  return `ask_${target.replace(/[^a-zA-Z0-9]+/g, '_')}`;
}

/**
 * The `{ task: string }` input a delegate (`agent`-kind) tool takes, as a zero-dependency Standard
 * Schema so synthesizing delegate tools never pulls in `zod` (an optional peer). The loop validates
 * against it in the delegation branch of `agent-loop.ts` before delegating, mirroring
 * `ToolRegistry.invoke`'s input gate for every other tool kind.
 */
const DELEGATE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      description: 'What the delegate agent should do, in one self-contained instruction.',
    },
  },
  required: ['task'],
  additionalProperties: false,
} as const;

/**
 * The delegate tool's input contract.
 *
 * `jsonSchema.input` is NOT optional decoration — it is what makes this tool usable.
 * The SDK bridge can only derive parameter shapes from a Zod schema or from this
 * Standard JSON Schema extension; anything else degrades to a permissive
 * `{ properties: {} }`, which tells the model the tool takes NO arguments.
 *
 * Without it, the loop was unwinnable for the model: it was shown a tool with no
 * parameters, sent `{}` — correctly, given what it was told — and then had the call
 * rejected against a `validate` that demands `{ task: string }`. A production install
 * showed four delegate tools at 121 calls and 121 failures each: a 100% failure rate
 * that burned the actor's whole daily token budget re-trying a call it could not get
 * right, because the requirement was never communicated.
 *
 * `validate` stays the authority (it is what actually gates execution); this is the
 * same contract, expressed in the one form the model gets to see.
 */
const delegateInputSchema: StandardSchemaV1<{ task: string }, { task: string }> = {
  '~standard': {
    version: 1,
    vendor: '@adonis-agora/agent',
    validate: (value: unknown) => {
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { task?: unknown }).task === 'string'
      ) {
        return { value: { task: (value as { task: string }).task } };
      }
      return { issues: [{ message: 'expected { task: string }' }] };
    },
    jsonSchema: {
      input: () => DELEGATE_JSON_SCHEMA,
      output: () => DELEGATE_JSON_SCHEMA,
    },
  },
} as StandardSchemaV1<{ task: string }, { task: string }>;

/** Normalize a `delegatesTo` entry: a bare string is the edge with no authorization annotation. */
export function normalizeDelegateEdge(edge: string | DelegateEdge): DelegateEdge {
  return typeof edge === 'string' ? { agent: edge } : edge;
}

/**
 * Synthesize an `agent`-kind delegate tool for each `agent→agent` edge declared via `delegatesTo`, so
 * an orchestrator can call `ask_<target>({ task })` to hand work to another registered agent. The loop
 * handles delegation itself (never the handler), so the handler is a no-op. Skips names already taken.
 * Returns the number of delegate tools registered.
 *
 * Authorization: the synthesized spec carries the edge's `roles`/`ability` verbatim, so delegation is
 * gated by the SAME `RolesPolicy` as every other tool — no special case, no implicit grant. An edge
 * declared as a bare string carries neither, which means ADMIN-only under `DefaultToolAuthorizer` and
 * an outright deny under the ability-aware authz adapter. That is deliberate (fail-closed), and the
 * {@link DelegateEdge} object form is how an app opens the edge to the actors it intends.
 */
export function registerDelegateTools(registry: ToolRegistry, agents: AgentRegistry): number {
  let count = 0;
  for (const definition of agents.list()) {
    for (const edge of definition.delegatesTo ?? []) {
      const { agent: target, roles, ability } = normalizeDelegateEdge(edge);
      const name = delegateToolName(target);
      if (registry.has(name)) continue;
      const targetDefinition = agents.get(target);
      // Only a flat string prompt is worth surfacing; a PromptBuilder is per-request source, so skip it.
      const blurb =
        typeof targetDefinition?.systemPrompt === 'string'
          ? ` It is: ${targetDefinition.systemPrompt}`
          : '';
      registry.register(
        {
          name,
          kind: 'agent',
          targetAgent: target,
          description: `Delegate a task to the "${target}" agent and get its answer.${blurb}`,
          inputSchema: delegateInputSchema,
          ...(roles !== undefined ? { roles } : {}),
          ...(ability !== undefined ? { ability } : {}),
        },
        // Loop-handled (kind 'agent'); the handler is never called.
        { execute: async () => ({}) },
      );
      count += 1;
    }
  }
  return count;
}

/** The shared infrastructure the factory hands to every per-agent deps bundle. */
export interface AgentDepsFactoryConfig {
  model: ModelProvider;
  store: AgentStore;
  sink: TokenStreamSink;
  rolesPolicy: RolesPolicy;
  registry: ToolRegistry;
  agents: AgentRegistry;
  quota?: QuotaStore;
  /** Shared pricing store so every agent's turns are priced from one table. Omit → cost stays `null`. */
  pricingStore?: AgentPricingStore;
  /**
   * Shared inject-mode retriever. When set, every agent's loop retrieves passages for the user message
   * and folds them into its system prompt (replay-safe under durable). Omit → no injection.
   */
  retriever?: Retriever;
  /** How many passages inject-mode retrieval requests. Undefined → 5. */
  retrievalTopK?: number;
  /**
   * Shared hook deriving the inject-mode retrieval filter from the run's actor, applied for every
   * agent. Without it, retrieval is UNSCOPED. See the doc comment on `AgentConfig.retrievalFilter`.
   */
  retrievalFilter?: (actor: Actor) => Record<string, unknown>;
  /**
   * Shared in-place transient-retry policy applied to every agent's tool invocations (DB deadlock /
   * lock-wait timeout / serialization failure). Undefined → the loop default; `false` disables it.
   */
  toolTransientRetry?: ToolTransientRetrySetting;
  /** Name of the implicit default agent. Defaults to `'default'`. */
  defaultAgentName?: string;
}

/**
 * Builds the per-agent {@link AgentDeps} the runner feeds `runAgentLoop`. The single-agent case is
 * just the `default` definition; a named agent (registered in the {@link AgentRegistry}) supplies its
 * own prompt, personas, tool allow-list and step budget. Model/store/sink/roles are shared.
 */
export class AgentDepsFactory {
  constructor(private readonly config: AgentDepsFactoryConfig) {}

  defaultAgentName(): string {
    return this.config.defaultAgentName ?? 'default';
  }

  private effectiveTools(definition: AgentDefinition | undefined): string[] | undefined {
    if (definition === undefined) {
      return undefined;
    }
    const delegated = (definition.delegatesTo ?? []).map((edge) =>
      delegateToolName(normalizeDelegateEdge(edge).agent),
    );
    if (definition.tools === undefined && delegated.length === 0) {
      return undefined; // no restriction
    }
    return [...(definition.tools ?? []), ...delegated];
  }

  forAgent(agentName?: string): AgentDeps {
    const name = agentName ?? this.defaultAgentName();
    const definition = this.config.agents.get(name);
    const personas = new Map<string, Persona>();
    for (const persona of definition?.personas ?? []) {
      personas.set(persona.id, persona);
    }
    const toolAllowList = this.effectiveTools(definition);
    return {
      model: this.config.model,
      store: this.config.store,
      sink: this.config.sink,
      rolesPolicy: this.config.rolesPolicy,
      registry: this.config.registry,
      systemPrompt: definition?.systemPrompt ?? 'You are a helpful assistant.',
      maxSteps: definition?.maxSteps ?? 8,
      personas,
      defaultPersona: definition?.defaultPersona ?? 'default',
      ...(definition?.modelId !== undefined ? { modelId: definition.modelId } : {}),
      ...(this.config.quota !== undefined ? { quota: this.config.quota } : {}),
      ...(this.config.pricingStore !== undefined ? { pricingStore: this.config.pricingStore } : {}),
      ...(this.config.retriever !== undefined ? { retriever: this.config.retriever } : {}),
      ...(this.config.retrievalTopK !== undefined
        ? { retrievalTopK: this.config.retrievalTopK }
        : {}),
      ...(this.config.retrievalFilter !== undefined
        ? { retrievalFilter: this.config.retrievalFilter }
        : {}),
      ...(this.config.toolTransientRetry !== undefined
        ? { toolTransientRetry: this.config.toolTransientRetry }
        : {}),
      ...(toolAllowList !== undefined ? { toolAllowList } : {}),
    };
  }
}
