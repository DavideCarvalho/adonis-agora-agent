import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ActorResolver } from './spi/actor-resolver.js';

/** Who is driving the turn. Roles + tenant come from the host app (nestjs-context/authz). */
export interface Actor {
  id: string;
  /** The caller's roles. Tool authorization is a set intersection against a tool's `roles`. */
  roles?: string[];
  tenantRef?: string;
}

export type ToolKind = 'read' | 'action' | 'agent';

/**
 * Declared shape of a tool.
 *  - `read`   auto-executes.
 *  - `action` never auto-executes — requires HITL approval.
 *  - `agent`  delegates to another named agent (durable: a child workflow; inline: a nested loop),
 *             handled at the loop level — NOT via a handler. Carries `targetAgent`.
 */
export interface ToolSpec {
  name: string;
  kind: ToolKind;
  description: string;
  /**
   * Input schema as a [Standard Schema](https://standardschema.dev) — validation-agnostic, so
   * Zod, Valibot, or ArkType all work. The loop validates input via `~standard.validate` before
   * running the handler, and providers convert it to the model's tool-parameter JSON schema.
   */
  inputSchema: StandardSchemaV1;
  /** For `kind: 'agent'` — the name of the agent to delegate to. */
  targetAgent?: string;
  /** Roles allowed to invoke. Undefined → defaults applied by RolesPolicy (e.g. ADMIN-only). */
  roles?: string[];
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
  id: string;
  name: string;
  input: unknown;
}

/** Result of running a tool. */
export interface ToolResult {
  id: string;
  name: string;
  output: unknown;
  error?: string;
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

export type UsagePurpose = 'chat' | 'title' | 'follow_ups' | 'summary';

export interface QuotaState {
  usedTokens: number;
  limitTokens: number;
  withinLimit: boolean;
}

/** A human decision on a pending action tool call. */
export interface Decision {
  approved: boolean;
  reason?: string;
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
  basePrompt: string;
}

/**
 * A dynamic system prompt. Return a string (optionally async) built from the turn's context —
 * e.g. injecting the actor, the current page, or a data-shape description. The loop resolves it
 * once per turn from stable inputs (actor/persona/pageContext), so it stays replay-safe.
 */
export type PromptBuilder = (ctx: PromptContext) => string | Promise<string>;

export interface Persona {
  id: string;
  label: string;
  /** A flat prompt, or a {@link PromptBuilder} composed per request from {@link PromptContext}. */
  systemPrompt: string | PromptBuilder;
  /** If set, only these tool names are offered (after role filtering). */
  allowedTools?: string[];
}

/** Everything needed to run one agent turn. */
export interface AgentRunInput {
  threadId: string;
  actor: Actor;
  /** The latest user message text. */
  userText: string;
  /** Files attached to the latest user message (image/PDF). Persisted with it and sent to the model. */
  attachments?: MessageAttachment[];
  persona?: Persona;
  pageContext?: PageContext;
  isRegenerate?: boolean;
  /** YYYY-MM-DD stamped by the runner so quota/day stays deterministic under durable replay. */
  day?: string;
  /** Which named agent runs this turn. Omitted → the default/single agent. */
  agentName?: string;
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
   * Roles allowed to invoke the synthesized delegate tool. Omitted → the `RolesPolicy` default,
   * which is ADMIN-only under {@link import('./authorizer.js').DefaultToolAuthorizer}.
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
  /** Base prompt for this agent. A flat string, or a {@link PromptBuilder} resolved per turn. */
  systemPrompt?: string | PromptBuilder;
  /** Allow-list of tool names this agent may use (subset of all registered tools). */
  tools?: string[];
  /**
   * Other agents this agent may delegate to. Each edge is auto-registered as an `agent`-kind tool
   * named `ask_<target>`, which the loop authorizes exactly like any other tool.
   *
   * A bare string declares the edge with no authorization annotation, which is fail-closed on
   * purpose: under the default {@link import('./authorizer.js').DefaultToolAuthorizer} a tool with
   * no `roles` is ADMIN-only, and under the `@adonis-agora/agent/authz` adapter a tool with no
   * `ability` is denied outright — so under authz a bare edge can never be called. Use the
   * {@link DelegateEdge} object form to declare the `roles` and/or `ability` the delegate tool
   * carries.
   */
  delegatesTo?: (string | DelegateEdge)[];
  personas?: Persona[];
  defaultPersona?: string;
  modelId?: string;
  maxSteps?: number;
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
  persona: string;
  pinnedAt?: string;
  transient: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview?: string;
}

export interface StoredMessage {
  id: string;
  role: MessageRole;
  content: string;
  toolCalls?: ToolCallRequest[];
  toolResults?: ToolResult[];
  /** Files the user attached to this message (image/PDF). Persisted with the message, replayed as-is. */
  attachments?: MessageAttachment[];
  followUps?: string[];
  usage?: MessageUsage;
  createdAt: string;
}

export interface ThreadDetail extends ThreadSummary {
  messages: StoredMessage[];
  activeStreamId?: string;
}

export type ToolCallStatus =
  | 'auto_executed'
  | 'pending_approval'
  | 'executed'
  | 'rejected'
  | 'failed';
