import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ClaimedActionApproval } from './action-proposal-approval.js';
import type { AgentIntake } from './elicitation.js';
import type { ActionProposalOutcome } from './spi/action-proposal-outcome-store.js';
import type { ActorResolver } from './spi/actor-resolver.js';
import type { ChatQueueState } from './spi/chat-queue.js';
import type { ToolPreflightResult } from './spi/tool.js';
import type { AgentUiComponent } from './stream-events.js';
import type { ToolConfirmation, ToolPresentation } from './tool-presentation.js';
import type { UiCapabilities } from './ui-capabilities.js';

/** Who is driving the turn. Roles + tenant come from the host app (nestjs-context/authz). */
export interface Actor {
  id: string;
  /** The caller's roles. Tool authorization is a set intersection against a tool's `roles`. */
  roles?: string[];
  tenantRef?: string;
}

export type ToolKind = 'read' | 'action' | 'agent' | 'ask' | 'skill' | 'memory';

/**
 * Declared shape of a tool.
 *  - `read`   auto-executes.
 *  - `action` never auto-executes — requires HITL approval.
 *  - `agent`  delegates to another named agent (durable: a child workflow; inline: a nested loop),
 *             handled at the loop level — NOT via a handler. Carries `targetAgent`.
 *  - `ask`    puts a structured question set to the user and parks. Carried by no {@link ToolSpec}:
 *             `ask` has no handler and is never registered, it is offered to the model straight from
 *             module config — so the branch that decides whether a call parks on a human can never
 *             be settled by a process-local registry lookup.
 *  - `skill`  reads an authored procedure out of the catalog the turn's `skills:catalog` checkpoint
 *             holds. Registered by nothing, for the same reason `ask` is not, and it spends a read's
 *             checkpoints exactly — see `skills.ts`.
 *  - `memory` writes one durable fact about the actor, authorized against the scopes the turn's
 *             `memory:digest` checkpoint holds. Registered by nothing, and spends a read's
 *             checkpoints exactly — see `memory.ts`.
 */
export interface ToolSpec {
  name: string;
  kind: ToolKind;
  description: string;
  /**
   * How a person-facing surface talks about this tool (see {@link ToolPresentation}). Never shown
   * to the model; served to clients by `GET <path>/tools`.
   */
  presentation?: ToolPresentation;
  replacementKey?:
    | string
    | ((
        input: unknown,
        ctx: import('./spi/tool.js').AiToolCtx,
      ) => string | undefined | Promise<string | undefined>);
  /**
   * Input schema as a [Standard Schema](https://standardschema.dev) — validation-agnostic, so
   * Zod, Valibot, or ArkType all work. The loop validates input via `~standard.validate` before
   * running the handler, and providers convert it to the model's tool-parameter JSON schema.
   */
  inputSchema: StandardSchemaV1;
  /** For `kind: 'agent'` — the name of the agent to delegate to. */
  targetAgent?: string;
  /**
   * For `kind: 'agent'` — start the delegate and let the calling turn END instead of holding it open
   * until the delegate answers. The call's result is a receipt (`DetachedDelegationReceipt`), and the
   * answer arrives later as its own message in the same thread (see {@link AgentRunInput.deliverTo}).
   *
   * Authored per EDGE (`delegatesTo: [{ agent, detached: true }]`), never chosen by the model: a model
   * that can detach can detach the one thing the user is sitting there waiting for, and it cannot know
   * which that is. The person wiring `A -> B` does.
   *
   * Settled into the call's `persist:toolcall` checkpoint, so a replay reads the branch back rather
   * than re-deciding it against a registry that may have changed while the run was parked.
   */
  detached?: boolean;
  /**
   * A successful call ENDS the turn: its effect is the answer (it pushed the UI the user reads), so
   * no further model call narrates it. A failed call does not end it — the model gets to recover.
   */
  terminal?: boolean;
  /** Roles allowed to invoke. Undefined → defaults applied by RolesPolicy (unrestricted unless `defaultRoles` is set). */
  roles?: string[];
  /**
   * Whether the tool exists in this deployment. `false` (or a predicate returning `false`) drops it
   * before the role filter, so it is never offered to the model and cannot be invoked. Undefined →
   * enabled.
   *
   * A predicate is re-evaluated every turn, so a flag flipped at runtime takes effect on the next
   * message with nothing re-registered. For availability that depends on a container-resolved
   * service, put `isEnabled()` on the tool class instead — a spec is data, a handler is a service.
   */
  enabled?: boolean | (() => boolean | Promise<boolean>);
  /**
   * An authorization ability name (e.g. 'cache.purge'). Consumed by an ability-aware RolesPolicy
   * such as the `@adonis-agora/agent/authz` Bouncer adapter (`authzToolAuthorizer`), which denies
   * every tool that declares none. Apps that don't use authz ignore it and rely on `roles` instead —
   * both live on the same SPI, so neither is required.
   */
  ability?: string;
}

/** What the model is told a tool looks like (no handler, no host types). */
export interface ToolDefinition {
  name: string;
  kind: ToolKind;
  description: string;
  inputSchema: StandardSchemaV1;
}

/** A tool call the model asked for during a turn. */
export interface ToolCallRequest {
  actionApproval?: ClaimedActionApproval;
  prepared?: {
    preparationInput: unknown;
    input: unknown;
    preflight: ToolPreflightResult;
    replacementKey?: string;
  };
  /** Trusted domain preparation stamped by the runtime into the model checkpoint, never supplied by the model. */
  preflight?: ToolPreflightResult | { status: 'failed'; error: string };
  id: string;
  name: string;
  input: unknown;
  /**
   * The tool's declared kind (`ToolSpec.kind`), stamped where the tool was OFFERED — inside the llm
   * checkpoint, by the process that built the definition list the model chose from. It travels with
   * the call from there, so the approval branch does not depend on which process replays the turn.
   * Undefined only for a call that predates the stamp, or one no registry could resolve
   * (defensively treated as `read` wherever a definite value is required).
   */
  kind?: ToolKind;
  /**
   * The call this one ran inside — an inner call of a code-mode tool an engine reported (see
   * `AgentEngine`). Absent for a call the model made itself, which is every call the loop records.
   */
  parentId?: string;
}

/** Result of running a tool. */
export interface ToolResult {
  id: string;
  name: string;
  output: unknown;
  error?: string;
  /**
   * A person declined this action, so the tool never ran. Set INSTEAD of a failure, and read by
   * every consumer that has to tell the two apart. `error` still carries what the MODEL is told,
   * because that is the channel a model reads a tool's outcome on; this flag is what everything
   * else reads.
   */
  denied?: true;
  /**
   * The approval request lapsed before anyone decided, so the tool never ran. Always set together
   * with {@link denied}: an expiry IS a refusal to every consumer that only knows that much, and this
   * flag is for the ones that tell "nobody answered" from "someone said no".
   */
  expired?: true;
}

export interface MessageUsage {
  /**
   * Total input (prompt) tokens for the turn — the whole input side, cached and uncached alike.
   * `cacheWriteTokens` + `cacheReadTokens` are subsets of this count, not additions to it, so
   * token totals and quota never change when a breakdown is present.
   */
  inputTokens: number;
  /** Total output (completion) tokens for the turn; `reasoningTokens` is a subset of this. */
  outputTokens: number;
  /**
   * How many of `inputTokens` were written to the prompt cache this turn (billed at a premium,
   * ~1.25× base input). Undefined when the provider doesn't report caching. Refines the cost
   * estimate only — priced by the pricing row's cache-write rate (falling back to the input rate).
   */
  cacheWriteTokens?: number;
  /**
   * How many of `inputTokens` were served from the prompt cache this turn (billed at a discount,
   * ~0.1× base input). Undefined when the provider doesn't report caching.
   */
  cacheReadTokens?: number;
  /**
   * How many of `outputTokens` the model spent on reasoning/thinking. Observability only — reasoning
   * tokens are billed at the output rate, so they don't change the cost estimate. Undefined for
   * non-reasoning models or providers that don't report it.
   */
  reasoningTokens?: number;
  /**
   * This turn's USD cost: the provider's own reported figure when it has one (a gateway), else an
   * estimate from the bound `AgentPricingStore` (cached once per run — see `AgentLoopDeps.pricingStore`),
   * else `null` when no pricing store is bound or the model has no price row. Never `0` for an unpriced
   * model — a real $0 turn and "we don't know" must stay distinguishable. Undefined before the loop
   * folds cost (e.g. a plain usage struct that predates pricing).
   */
  costUsd?: number | null;
}

/**
 * Para que serviu o consumo de uma linha do ledger.
 *
 * `embedding` é o gasto de RETRIEVAL: embedar a pergunta do usuário antes da busca vetorial. Ele
 * entrou depois dos outros, e a razão é a que importa — sem ele, um agente com retrieval em modo
 * inject gastava tokens em toda pergunta e nem o painel nem a COTA enxergavam. A cota soma o
 * ledger inteiro, sem filtrar propósito, então registrar aqui é o que faz o gasto de RAG passar a
 * contar contra o teto diário.
 */
export type UsagePurpose =
  | 'chat'
  | 'title'
  | 'follow_ups'
  | 'summary'
  | 'embedding'
  | 'structured_output';

export interface QuotaState {
  usedTokens: number;
  limitTokens: number;
  withinLimit: boolean;
}

/** A human decision on a pending action tool call. */
export interface Decision {
  approved: boolean;
  reason?: string;
  /** Opaque ref of WHO decided, when it wasn't the run's own actor. */
  executedByRef?: string;
  /**
   * Approve later calls of the SAME tool in the SAME thread without asking again. Read only on an
   * approval; the loop answers it through `AgentStore.rememberedApprovals`.
   */
  remember?: boolean;
  /**
   * The surface the decision came through — `'web'`, `'slack'`, `'console'`, anything the caller
   * names. Provenance only: persisted with the call, never authorized against.
   */
  decidedVia?: string;
  /**
   * Nobody decided before the request lapsed. Set by the RUNNER when the approval wait times out
   * (see `AgentLoopHooks.awaitApproval`'s `timeoutMs`), never by a person — the HTTP surface does not
   * accept it. Read as a denial the model is told expired.
   */
  expired?: true;
}

export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * A file a user attached to a message so a vision-capable model sees it natively (an image, a PDF).
 * The lib stays provider-agnostic: it passes {@link MessageAttachment.url} straight through as the
 * model's image/file part data — making that URL reachable by the provider (a presigned URL, a proxy,
 * or a `data:` URI) is the consumer's job. The lib never fetches bytes or talks to a store; that
 * upload-time work is the {@link import('./spi/attachment-staging.js').AttachmentStagingStore} seam.
 */
export interface MessageAttachment {
  /** Stable id of the stored media object in the consumer's media store. Provenance + replay key. */
  mediaId: string;
  /** A URL the model provider can fetch the bytes from at turn time. */
  url: string;
  /** MIME type — routes the part: `image/*` → image part, otherwise → file part. */
  contentType: string;
  /** Original filename, for display and the file part's filename. */
  name: string;
}

/** A neutral chat message exchanged with the model. */
export interface ModelMessage {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCallRequest[];
  toolResults?: ToolResult[];
  /** User-message attachments (image/PDF), rendered as native model content parts by the adapter. */
  attachments?: MessageAttachment[];
}

export interface PageContext {
  kind?: string;
  [key: string]: unknown;
}

/**
 * Inputs a {@link PromptBuilder} may use to compose the effective system prompt for a turn.
 * `basePrompt` is the agent's own (already-resolved) base prompt, so a persona builder can wrap
 * or extend it rather than replace it.
 */
export interface PromptContext {
  actor: Actor;
  persona?: Persona;
  pageContext?: PageContext;
  uiCapabilities?: UiCapabilities;
  basePrompt: string;
}

/**
 * A dynamic system prompt. Return a string (optionally async) built from the turn's context —
 * e.g. injecting the actor, the current page, or a data-shape description. The loop resolves it
 * once per turn from stable inputs (actor/persona/pageContext), so it stays replay-safe.
 */
export type PromptBuilder = (ctx: PromptContext) => string | Promise<string>;

/**
 * A named variant of ONE agent: its own prompt and, optionally, a narrower tool allow-list. The
 * caller picks one per send (`POST <path>/chat { persona }`); everything else — the agent's model,
 * its access rules, its handoffs, its history — stays the agent's. A variant that needs any of those
 * to differ is a different agent, not a persona. The same shape as `@dudousxd/nestjs-agent`'s.
 */
export interface Persona {
  /** Unique within its agent — what a send names and what a message records. */
  id: string;
  /** What a picker shows. */
  label: string;
  /** One line about what the persona is for, for a picker. */
  description?: string;
  /**
   * The persona's prompt. A flat string STANDS IN FOR the agent's base prompt; a
   * {@link PromptBuilder} is handed that base as `ctx.basePrompt`, so it can wrap it instead. Omit →
   * the agent's base prompt, unchanged (which can itself read `ctx.persona`).
   */
  systemPrompt?: string | PromptBuilder;
  /**
   * Only these tool names are offered — and only these may be invoked, handoffs included — under
   * this persona. Layered AFTER the agent's own allow-list, `enabled`, the roles policy and `canUse`:
   * it narrows, never widens. Omit → whatever the agent offers.
   */
  allowedTools?: string[];
  /**
   * Agent names this persona answers for: a send, a queued message, a thread's `defaultAgent` or an
   * in-flight run that names one of them runs as THIS agent under THIS persona. For an app that folds
   * separate agents into personas of one — what recorded the old agent name keeps resolving, with no
   * data migration. A name that is still a registered agent is never an alias.
   */
  aliases?: string[];
}

/**
 * A persona as a turn RESOLVED it, journaled in the `persona:resolve` checkpoint — so every replay of
 * the run uses this, and not whatever the persona's configuration says by the time it resumes.
 */
export interface TurnPersona {
  id: string;
  label: string;
  allowedTools?: string[];
  /** The persona's prompt, resolved (with the base prompt it wraps). Absent → the base prompt. */
  prompt?: string;
}

/** One persona as `GET <path>/agents` lists it — what a persona picker renders. */
export interface PersonaCatalogEntry {
  id: string;
  label: string;
  description?: string;
}

/** One agent as `GET <path>/agents` lists it — what an agent picker renders. */
export interface AgentCatalogEntry {
  name: string;
  description: string;
  /** Whether this is the agent a turn uses when the caller names none. Omitted when not the default. */
  isDefault?: true;
  /**
   * The catalog model this agent always runs on, when the model catalog locks it to one — an agent
   * picker can say so before a chat starts. `GET <path>/models?agent=` reports the same lock as
   * `locked`.
   */
  lockedModel?: string;
  /** The agent's personas, for a persona picker. Omitted when it declares none. */
  personas?: PersonaCatalogEntry[];
  /** The persona a send runs under when it names none. Omitted when the agent has no default. */
  defaultPersona?: string;
}

/**
 * What the HOST knows about a send that the library does not model — see
 * {@link AgentRunInput.hostContext}. Plain JSON.
 */
export type AgentHostContext = { readonly [key: string]: unknown };

/** Everything needed to run one agent turn. */
export interface AgentRunInput {
  threadId: string;
  actor: Actor;
  /** The latest user message text. */
  userText: string;
  /** Files attached to the latest user message (image/PDF). Persisted with it and sent to the model. */
  attachments?: MessageAttachment[];
  /**
   * The persona of {@link agentName} this turn runs under. An id ({@link Persona.id}) is the durable
   * form: the service resolves it from the send, the thread's pin and the agent's default BEFORE the
   * run starts, and the loop looks its definition up once, in the `persona:resolve` checkpoint. A
   * whole {@link Persona} is applied as given, with no checkpoint — what a caller of `runAgentLoop`
   * may hand it, and what a run started by a release before 0.60 recorded in its input. Omitted → no
   * persona, and no checkpoint spent on one.
   */
  persona?: string | Persona;
  pageContext?: PageContext;
  uiCapabilities?: UiCapabilities;
  /**
   * Answer the thread's last user message again instead of appending {@link userText} (ignored):
   * the loop drops every message after that user message — the answer being replaced — and runs
   * the turn on what is left. What `POST <path>/chat { threadId, regenerate: true }` starts.
   */
  regenerate?: boolean;
  /** YYYY-MM-DD stamped by the runner so quota/day stays deterministic under durable replay. */
  day?: string;
  /** Which named agent runs this turn. Omitted → the default/single agent. */
  agentName?: string;
  /**
   * The run that started this one (a delegation's parent). Recorded with the run so a governance
   * surface can roll a delegation's cost up to the turn that asked for it; without it a child run is
   * a row with nothing pointing at it outside the durable engine's own journal.
   */
  parentRunId?: string;
  /**
   * How many agent→agent delegations deep this run already is (0 for a top-level turn). The runner
   * increments it for each child run; the loop refuses to delegate past its depth ceiling.
   */
  delegationDepth?: number;
  /**
   * The named agents already on this delegation chain, root first — what {@link delegationDepth}
   * counts, spelled out. The runner appends its own agent's name for each child it starts.
   *
   * A count can only say a chain is LONG. This says whether it is going in circles, and how often:
   * an agent that appears here is one the chain has already passed through, so a delegation back to
   * it is a cycle by inspection rather than by proxy. A run whose runner supplies none falls back to
   * the depth ceiling alone.
   */
  delegationPath?: readonly string[];
  /**
   * The model this turn runs on — a catalog id the service already checked (a per-send pick, else
   * the thread's pinned model). Handed to the provider as `ModelTurnArgs.model`, and the usage label
   * when the provider reports none. Omitted → the provider's default.
   */
  model?: string;
  /**
   * Set on a DETACHED sub-agent run only: the thread and tool call it answers into when it finishes.
   * Its presence is also what makes a run detached from the inside — it owns its own stream (no
   * ancestor sink to forward into), so nothing else tells it apart from a top-level turn.
   */
  deliverTo?: DetachedDelivery;
  /**
   * What the HOST knows about this turn that the library does not model — where it came from, where
   * its answer goes, on whose behalf (e.g. `{ source: 'slack', delivery: { channel, ts } }`). Plain
   * JSON: it travels through the queue and the durable journal untouched, and reaches the runner's
   * hooks (an engine's host callbacks) as it was sent. Never shown to the model or to clients, and
   * never inherited by a delegated run.
   */
  hostContext?: AgentHostContext;
}

/**
 * Where a detached sub-agent run posts its answer: the thread that delegated it, and the `agent`-kind
 * tool call that started it. Carried on the child run's own {@link AgentRunInput}, because by the time
 * the child finishes the delegating turn is over and nothing else is holding the address.
 */
export interface DetachedDelivery {
  threadId: string;
  toolCallId: string;
}

/**
 * One `agent → agent` delegation edge, with the authorization the synthesized `ask_<target>` tool
 * carries. The object form exists because delegation goes through the same {@link ToolSpec} gate as
 * every other tool: a spec with neither `roles` nor `ability` is denied by both shipped authorizers,
 * so an orchestrator that must actually delegate has to say who may.
 *
 * ```ts
 * // Role-based (the default `DefaultToolAuthorizer`):
 * { name: 'orchestrator', delegatesTo: [{ agent: 'researcher', roles: ['ANALYST', 'ADMIN'] }] }
 *
 * // Ability-based (the `@adonis-agora/agent/authz` Bouncer adapter):
 * { name: 'orchestrator', delegatesTo: [{ agent: 'researcher', ability: 'agent.delegate' }] }
 * ```
 */
export interface DelegateEdge {
  /** Name of the agent to delegate to — the `target` in `ask_<target>`. */
  agent: string;
  /**
   * Run the delegate in the BACKGROUND: the synthesized tool is `start_<target>`, the calling turn
   * ends with a receipt instead of waiting, and the delegate's answer is posted into the same thread
   * as its own message (stamped with its `runId` / `agentName`) when it is ready. The chat stays free
   * meanwhile. Default `false` — the awaited `ask_<target>`. See {@link ToolSpec.detached}.
   */
  detached?: boolean;
  /**
   * Roles allowed to invoke the synthesized delegate tool. Omitted → the `RolesPolicy` default
   * (`defaultRoles`; unrestricted unless configured, under {@link import('./authorizer.js').DefaultToolAuthorizer}).
   */
  roles?: string[];
  /**
   * Ability the synthesized delegate tool declares. REQUIRED under an ability-aware authorizer such
   * as `authzToolAuthorizer`, which denies every tool that declares none — omit it there and the
   * delegation is denied on every call.
   */
  ability?: string;
}

/**
 * A named agent: its prompt, the tools it may use, and its personas. Definitions are registered in
 * `config/agent.ts` under `agents: [...]`; an orchestrator delegates to the others it names in
 * {@link AgentDefinition.delegatesTo}, which the factory turns into `ask_<target>` tools. Model,
 * store, sink and governance are shared from the module config unless overridden here.
 */
export interface AgentDefinition {
  name: string;
  /** One line about what the agent does, for a picker (`GET <path>/agents`). */
  description?: string;
  /** Base prompt for this agent. A flat string, or a {@link PromptBuilder} resolved per turn. */
  systemPrompt?: string | PromptBuilder;
  /** Allow-list of tool names this agent may use (subset of all registered tools). */
  tools?: string[];
  /**
   * Other agents this agent may delegate to. Each edge is auto-registered as an `agent`-kind tool
   * named `ask_<target>`, which the loop authorizes exactly like any other tool.
   *
   * A bare string declares the edge with no authorization annotation: under the default
   * {@link import('./authorizer.js').DefaultToolAuthorizer} it takes `defaultRoles` (unrestricted
   * unless configured), and under the `@adonis-agora/agent/authz` adapter a tool with no `ability`
   * is denied outright — so under authz a bare edge can never be called. Use the
   * {@link DelegateEdge} object form to declare the `roles` and/or `ability` the delegate tool
   * carries.
   */
  delegatesTo?: (string | DelegateEdge)[];
  /** Named variants of this agent — see {@link Persona}. Undefined → none. */
  personas?: Persona[];
  /**
   * The persona a send runs under when neither it nor its thread names one. Undefined → the persona
   * whose id is `'default'`, when the agent declares one; else none.
   */
  defaultPersona?: string;
  modelId?: string;
  maxSteps?: number;
  /**
   * How many agent→agent delegations deep a chain starting at this agent may go.
   * Undefined → {@link import('./agent-loop.js').MAX_DELEGATION_DEPTH}.
   */
  maxDelegationDepth?: number;
  /**
   * How many times one agent may appear on a single delegation chain.
   * Undefined → {@link import('./agent-loop.js').DEFAULT_MAX_AGENT_APPEARANCES}.
   */
  maxAgentAppearances?: number;
  /**
   * Offer the model the built-in `ask` tool, so it can put a question set to the user when it judges
   * the scope is missing, and wait for the answers (`POST <path>/tool-call/answer`). Off by default.
   * See `AgentLoopDeps.ask`.
   *
   * The run PARKS on the person. Under the inline runner that wait lives in the process that started
   * the turn, so the answer has to reach the same replica; under the durable runner (`durable: true`)
   * it is a journaled signal any replica can deliver.
   */
  ask?: boolean;
  /**
   * A question set this agent asks before it starts working — authored here, not by the model — on
   * a thread's first turn, or on every turn. See `AgentLoopDeps.intake`. Parks like {@link ask}.
   */
  intake?: AgentIntake;
  /**
   * Per-agent {@link ActorResolver} override. When set, this agent resolves the request's actor with
   * its own resolver instead of the module-global `config.actorResolver` — e.g. an agent that reads
   * the caller from the HTTP body rather than the session. Falls back to the global resolver when
   * unset, so agents without one behave exactly as before. Same type as the global resolver.
   */
  actorResolver?: ActorResolver;
}

export interface ThreadSummary {
  id: string;
  title: string;
  /**
   * The persona this thread's turns run under when a send names none — the last one a send on it
   * named, or `PATCH <path>/threads/:id { persona }`. `null` → none pinned (the agent's default
   * applies). The routes report a pin the thread's agent no longer declares as `null` too.
   */
  persona: string | null;
  pinnedAt?: string;
  transient: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview?: string;
  /**
   * The model pinned on this thread (`PATCH /threads/:id { model }`) — every turn without its own
   * `model` runs on it. `null` → the provider's default. Undefined for a store that does not persist it.
   */
  model?: string | null;
  /**
   * The agent this thread's turns run as when a send names none (`PATCH /threads/:id
   * { defaultAgent }`). `null` → the configured default agent. Undefined for a store that does not
   * persist it.
   */
  defaultAgent?: string | null;
  /**
   * The run streaming on this thread right now — the one a reloading client re-attaches to
   * (`GET <path>/chat/:runId/stream`) — or `null` when none is. Set when a turn starts, cleared when
   * it ends.
   */
  activeRunId?: string | null;
}

export interface StoredMessage {
  actionProposalOutcome?: ActionProposalOutcome;
  id: string;
  role: MessageRole;
  content: string;
  toolCalls?: ToolCallRequest[];
  toolResults?: ToolResult[];
  /** Files the user attached to this message (image/PDF). Persisted with the message, replayed as-is. */
  attachments?: MessageAttachment[];
  followUps?: string[];
  usage?: MessageUsage;
  /** The persona that was active when the message was written; absent when none was selected. */
  persona?: string;
  /**
   * The run (turn) that wrote this message. Without it a reader can only guess which turn a message
   * belongs to by comparing timestamps against the run's `startedAt`, and that guess breaks the
   * moment a turn is regenerated: regeneration truncates the replaced answer and re-answers the
   * SURVIVING user message without appending a new one, so walking forward by time hands the older
   * run the replacement's text. Absent on a row written outside a run.
   */
  runId?: string;
  /**
   * The agent that wrote this message, when it is not the turn's own: a detached sub-agent's answer
   * lands in the delegating thread as a message of its own, and this is how a reader tells "the
   * research agent finished" from the assistant's next reply. Absent on every other message.
   */
  agentName?: string;
  /**
   * The model's thinking for this step, as it streamed (`reasoning` frames), so a reloaded thread
   * shows it where the live one did. Absent when the model produced none, or on a row written
   * before this was recorded.
   */
  reasoning?: string;
  /** How long the model spent thinking in this step, in ms — what a "Thought for 4s" label reads. */
  reasoningMs?: number;
  /**
   * Components pushed into this step (`ui` frames), in first-seen order with the last props for each
   * `id` — a reloaded thread replays them as `data-ui` parts.
   */
  ui?: AgentUiComponent[];
  /**
   * The approval record of every call on this message that was put to a person under an
   * `ApprovalPolicy` — who had to decide, until when, and how it settled. Read off the tool-call rows
   * by the store; absent when no call on the message asked for one.
   */
  approvals?: ToolCallApproval[];
  /**
   * The thread owner's rating of this message (`POST <path>/messages/:id/feedback`). Absent when
   * nobody rated it, or on a store that does not record feedback.
   */
  feedback?: MessageFeedback;
  createdAt: string;
}

/** A thumbs-up/down on one message, with an optional free-text comment. */
export type MessageFeedbackValue = 'up' | 'down';

/** What {@link StoredMessage.feedback} holds. Not copied when a thread is forked. */
export interface MessageFeedback {
  value: MessageFeedbackValue;
  comment?: string;
  /** ISO-8601 instant the rating was last set. */
  updatedAt: string;
}

/**
 * How one approval stands. `pending` → still parked; `approved` → someone said yes (or a remembered
 * approval did); `rejected` → someone said no; `expired` → nobody answered before `expiresAt`.
 */
export type ToolCallApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/** The persisted approval metadata of one action tool call. See {@link StoredMessage.approvals}. */
export interface ToolCallApproval {
  proposalId?: string;
  target?: { kind: 'proposal'; proposalId: string };
  confirmation?: ToolConfirmation;
  toolCallId: string;
  /** Who may decide: `'requester'` (the thread's own actor) or a role name. */
  approver: string;
  /** ISO-8601 instant the request lapses; absent → it never does. */
  expiresAt?: string;
  status: ToolCallApprovalStatus;
  /** The decision asked for later calls of this tool in this thread to be approved automatically. */
  remember?: boolean;
  /** Opaque ref of who decided. Absent while pending and on an expiry. */
  decidedBy?: string;
  /** The surface the decision came through (`'web'`, `'slack'`, `'remembered'`, …). */
  decidedVia?: string;
  /** What the person said when declining. */
  reason?: string;
}

export interface ThreadDetail extends ThreadSummary {
  messages: StoredMessage[];
  /**
   * Messages sent while a turn was running, waiting to run after it, and whether the queue is
   * draining. Present when the store supports a queue (`ChatQueueStore`); omitted otherwise.
   */
  queue?: ChatQueueState;
}

export type ToolCallStatus =
  | 'proposed'
  | 'auto_executed'
  | 'pending_approval'
  | 'executed'
  | 'rejected'
  | 'failed'
  /** An approval request lapsed before anyone decided; the tool never ran. */
  | 'expired';

/** The attachment rules in force — what the upload route enforces (`GET <path>/config`). */
export interface AgentAttachmentConfig {
  /** An upload store is configured, so uploads work at all. */
  enabled: boolean;
  /** How a client uploads (`null` when `enabled` is false). */
  upload: 'multipart' | 'resumable' | null;
  maxBytes: number;
  allowedContentTypes: readonly string[];
  /** How many attachments one message may name. */
  maxPerMessage: number;
}

/**
 * `GET <path>/config` — server facts a client would otherwise repeat (the shape of
 * `@dudousxd/nestjs-agent`'s `AgentClientConfig`, which its React `useAgentConfig` reads).
 */
export interface AgentClientConfig {
  attachments: AgentAttachmentConfig;
  /** A model catalog is available, so `GET <path>/models` lists something to pick. */
  models: { enabled: boolean };
  /** Sends are refused with `429` once `GET <path>/quota` reports `blocked`. */
  quota: { enforced: boolean };
  /** No `actorResolver`: every browser is its own anonymous actor. */
  identity: { anonymous: boolean };
}
