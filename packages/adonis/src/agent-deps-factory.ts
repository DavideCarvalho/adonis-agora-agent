import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { AgentDeps } from './agent-deps.js';
import type { AgentRegistry } from './agent-registry.js';
import type { MemoryConfig } from './memory.js';
import {
  defaultPersonaOf,
  findPersona,
  intersectAllowLists,
  PersonaNotFoundError,
  personaCatalogEntry,
  resolvePersonaAlias,
} from './personas.js';
import type { SkillsConfig } from './skills.js';
import type { AgentStore } from './spi/agent-store.js';
import type { ApprovalPolicy } from './spi/approval-policy.js';
import type { HistoryWindow } from './spi/history-window.js';
import type { ModelProvider } from './spi/model-provider.js';
import type { AgentPricingStore } from './spi/pricing-store.js';
import type { InputProcessor, OutputProcessor } from './spi/processors.js';
import type { QuotaStore } from './spi/quota-store.js';
import type { Retriever } from './spi/retriever.js';
import type { RolesPolicy } from './spi/roles-policy.js';
import type { TokenStreamSink } from './spi/token-stream-sink.js';
import type { ToolRegistry } from './tool-registry.js';
import type { ToolTransientRetrySetting } from './tool-retry.js';
import type {
  Actor,
  AgentDefinition,
  DelegateEdge,
  Persona,
  PersonaCatalogEntry,
  PromptBuilder,
  PromptContext,
} from './types.js';

/** The synthesized `agent`-kind tool name for an edge to `target`: `ask_<target>`, or `start_<target>` for a detached one. */
export function delegateToolName(target: string, options: { detached?: boolean } = {}): string {
  const slug = target.replace(/[^a-zA-Z0-9]+/g, '_');
  return options.detached === true ? `start_${slug}` : `ask_${slug}`;
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
      const { agent: target, roles, ability, detached } = normalizeDelegateEdge(edge);
      const name = delegateToolName(target, { detached: detached === true });
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
          // A detached edge's description is the model's only warning that this call hands back a
          // receipt: a tool advertised as returning an answer, which then returns something else, is
          // a model that reports an answer it was never given.
          description:
            detached === true
              ? `Start the "${target}" agent working on a task in the BACKGROUND. Returns immediately with a receipt, NOT an answer — the answer is delivered to this conversation as a separate message later. Use it for work the user does not need to sit and wait for.${blurb}`
              : `Delegate a task to the "${target}" agent and get its answer.${blurb}`,
          ...(detached === true ? { detached: true } : {}),
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
  /** Shared approval policy for every agent's `action` calls. Undefined → the requester, no expiry. */
  approvalPolicy?: ApprovalPolicy;
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
  /**
   * Shared ceiling on how much of a thread rides into every agent's turn. Omit → the full thread
   * history rides every turn.
   */
  historyWindow?: HistoryWindow;
  /**
   * Shared skills seam: the provider a turn lists its catalog from, the resolver that orders an
   * actor's scope tokens, and the catalog ceiling. One deployment, one answer to "which scopes does
   * this actor have". Omit → no catalog block and no `skill` tool for any agent.
   */
  skills?: SkillsConfig;
  /**
   * Shared memory seam: the provider holding the rows, the resolver that orders an actor's scope
   * tokens, and the block's ceilings. Wired next to {@link AgentDepsFactoryConfig.skills} and
   * normally sharing its resolver. Omit → no memory block and no `remember` tool for any agent.
   */
  memory?: MemoryConfig;
  /** Shared input processors, run for every agent's turn — see `AgentLoopDeps.inputProcessors`. */
  inputProcessors?: InputProcessor[];
  /** Shared output processors, run for every agent's turn — see `AgentLoopDeps.outputProcessors`. */
  outputProcessors?: OutputProcessor[];
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

  /** Every registered agent definition, in registration order. */
  agentDefinitions(): AgentDefinition[] {
    return this.config.agents.list();
  }

  defaultAgentName(): string {
    return this.config.defaultAgentName ?? 'default';
  }

  private effectiveTools(definition: AgentDefinition | undefined): string[] | undefined {
    if (definition === undefined) {
      return undefined;
    }
    const delegated = (definition.delegatesTo ?? []).map((edge) => {
      const { agent, detached } = normalizeDelegateEdge(edge);
      return delegateToolName(agent, { detached: detached === true });
    });
    if (definition.tools === undefined && delegated.length === 0) {
      return undefined; // no restriction
    }
    return [...(definition.tools ?? []), ...delegated];
  }

  /** Is `name` a registered agent — or the implicit default one? */
  isAgent(name: string): boolean {
    return name === this.defaultAgentName() || this.config.agents.get(name) !== undefined;
  }

  /**
   * The agent a name stands for: itself when it is a registered agent (or unknown — the bare
   * assistant), else the agent whose persona took the name over ({@link Persona.aliases}) and that
   * persona.
   */
  resolveAgent(name: string): { agentName: string; persona?: string } {
    if (this.isAgent(name)) {
      return { agentName: name };
    }
    const alias = resolvePersonaAlias(this.agentDefinitions(), name);
    return alias === undefined
      ? { agentName: name }
      : { agentName: alias.agent, persona: alias.persona };
  }

  /** `agentName`'s personas as a picker reads them. Empty when it declares none. */
  personaCatalog(agentName: string): PersonaCatalogEntry[] {
    return (this.config.agents.get(agentName)?.personas ?? []).map(personaCatalogEntry);
  }

  /** The persona `agentName` runs under when nothing names one. Undefined → none. */
  defaultPersona(agentName: string): string | undefined {
    return defaultPersonaOf(this.config.agents.get(agentName));
  }

  /** Does `agentName` declare a persona `id`? */
  hasPersona(agentName: string, id: string): boolean {
    return findPersona(this.config.agents.get(agentName), id) !== undefined;
  }

  /**
   * The persona a turn of `agentName` runs under, most specific first: the one the send names
   * (refused with {@link PersonaNotFoundError} when the agent does not declare it), else the thread's
   * pinned one when this agent declares it, else the agent's default. Undefined → none.
   */
  resolvePersona(args: {
    agentName: string;
    requested?: string;
    threadPersona?: string | null;
  }): string | undefined {
    if (args.requested !== undefined) {
      if (!this.hasPersona(args.agentName, args.requested)) {
        throw new PersonaNotFoundError(args.agentName, args.requested);
      }
      return args.requested;
    }
    const pinned = args.threadPersona ?? undefined;
    if (pinned !== undefined && this.hasPersona(args.agentName, pinned)) {
      return pinned;
    }
    return this.defaultPersona(args.agentName);
  }

  forAgent(agentName?: string): AgentDeps {
    const name = agentName ?? this.defaultAgentName();
    // A name a persona took over (`Persona.aliases`): a run journaled under the old agent name — or a
    // caller still naming it — is served by the agent that owns the persona, with it applied.
    if (agentName !== undefined && !this.isAgent(agentName)) {
      const alias = resolvePersonaAlias(this.agentDefinitions(), agentName);
      const persona =
        alias === undefined
          ? undefined
          : findPersona(this.config.agents.get(alias.agent), alias.persona);
      if (alias !== undefined && persona !== undefined) {
        return this.withPersona(this.forAgent(alias.agent), persona);
      }
    }
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
      ...(this.config.approvalPolicy !== undefined
        ? { approvalPolicy: this.config.approvalPolicy }
        : {}),
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
      ...(this.config.historyWindow !== undefined
        ? { historyWindow: this.config.historyWindow }
        : {}),
      ...(this.config.skills !== undefined ? { skills: this.config.skills } : {}),
      ...(this.config.memory !== undefined ? { memory: this.config.memory } : {}),
      ...(this.config.inputProcessors !== undefined
        ? { inputProcessors: this.config.inputProcessors }
        : {}),
      ...(this.config.outputProcessors !== undefined
        ? { outputProcessors: this.config.outputProcessors }
        : {}),
      ...(toolAllowList !== undefined ? { toolAllowList } : {}),
      ...(definition?.maxDelegationDepth !== undefined
        ? { maxDelegationDepth: definition.maxDelegationDepth }
        : {}),
      ...(definition?.maxAgentAppearances !== undefined
        ? { maxAgentAppearances: definition.maxAgentAppearances }
        : {}),
      // From the agent's DEFINITION, never from a run's input: a durable replay rebuilds these deps
      // here, and the loop's checkpoint sequence has to come out the same as the first attempt's.
      ...(definition?.ask !== undefined ? { ask: definition.ask } : {}),
      ...(definition?.intake !== undefined ? { intake: definition.intake } : {}),
    };
  }

  /**
   * A persona baked into an agent's deps — how a run journaled under an agent name that a persona has
   * since taken over ({@link Persona.aliases}) is served. That run names no persona of its own (it
   * predates the fold, and its input cannot change), so the persona applies the way the old agent's
   * own config did: as config, re-read on every replay, with no checkpoint of its own.
   */
  private withPersona(deps: AgentDeps, persona: Persona): AgentDeps {
    const base = deps.systemPrompt;
    const resolve = async (prompt: string | PromptBuilder, ctx: PromptContext) =>
      typeof prompt === 'function' ? prompt(ctx) : prompt;
    const own = persona.systemPrompt;
    const systemPrompt: PromptBuilder = async (ctx) => {
      const scoped: PromptContext = { ...ctx, persona };
      if (own === undefined) {
        return resolve(base, scoped);
      }
      const basePrompt = typeof own === 'function' ? await resolve(base, scoped) : '';
      return resolve(own, { ...scoped, basePrompt });
    };
    const toolAllowList = intersectAllowLists(deps.toolAllowList, persona.allowedTools);
    return { ...deps, systemPrompt, ...(toolAllowList !== undefined ? { toolAllowList } : {}) };
  }
}
