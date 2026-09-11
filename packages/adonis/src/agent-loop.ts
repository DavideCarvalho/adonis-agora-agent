import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  publishAgentDelegated,
  publishAgentMessage,
  publishAgentRetrieved,
  publishAgentRunFinished,
  publishAgentRunStarted,
  publishAgentToolCall,
  publishAgentToolRetry,
  spannedAgent,
} from './diagnostics.js';
import {
  type AgentIntake,
  ASK_TOOL_NAME,
  askInputSchema,
  askToolDefinition,
  DEFAULT_INTAKE_PREAMBLE,
  type ElicitationReply,
  type ElicitationRequest,
  type HumanReply,
  normalizeElicitationReply,
  settleElicitation,
} from './elicitation.js';
import {
  createFrameBuffer,
  createIncrementalGate,
  type GateRejection,
  gateTail,
  releaseGatedFrames,
  resolveGateLookback,
  resolveOutputGateMode,
  runInputProcessors,
  runOutputProcessors,
} from './processors.js';
import { isReplayIntegrityError } from './replay-integrity.js';
import {
  buildSkillsBlock,
  loadSkill,
  offerSkills,
  SKILL_TOOL_NAME,
  type SkillContext,
  type SkillOffer,
  type SkillsConfig,
  skillInputSchema,
  skillToolDefinition,
} from './skills.js';
import type { AgentStore } from './spi/agent-store.js';
import type { HistoryWindow, HistoryWindowContext } from './spi/history-window.js';
import type { ModelProvider, ModelTurnResult } from './spi/model-provider.js';
import {
  type AgentPricingStore,
  type CurrentModelPrice,
  estimateCost,
  resolveModelPrice,
} from './spi/pricing-store.js';
import {
  type InputProcessor,
  type OutputProcessor,
  OutputRejectedError,
  type ProcessedPrompt,
  type ProcessorContext,
} from './spi/processors.js';
import type { QuotaStore } from './spi/quota-store.js';
import type { Passage, RetrievalResult, RetrieveOptions, Retriever } from './spi/retriever.js';
import type { RolesPolicy } from './spi/roles-policy.js';
import type { SinkWriter, StreamFrame } from './spi/token-stream-sink.js';
import type { AiToolCtx } from './spi/tool.js';
import {
  DEFAULT_STRUCTURED_OUTPUT_INSTRUCTION,
  repairInstruction,
  StructuredOutputError,
  validateStructured,
} from './structured-output.js';
import { ToolForbiddenError, ToolInputInvalidError, type ToolRegistry } from './tool-registry.js';
import { invokeWithTransientRetry, type ToolTransientRetrySetting } from './tool-retry.js';
import type {
  Actor,
  AgentRunInput,
  Decision,
  MessageUsage,
  ModelMessage,
  PromptBuilder,
  PromptContext,
  ToolCallRequest,
  ToolDefinition,
  ToolKind,
  ToolResult,
  ToolSpec,
} from './types.js';

export interface AgentLoopDeps<TOutput = unknown> {
  model: ModelProvider;
  store: AgentStore;
  registry: ToolRegistry;
  rolesPolicy: RolesPolicy;
  quota?: QuotaStore;
  /**
   * Prices each step's token usage into `usage.costUsd` on the persisted assistant message. The
   * current price list is fetched ONCE per run (not per step) and reused for every step's estimate.
   * Undefined → `costUsd` is always `null` (never a fabricated `0`). A provider-reported cost always
   * wins over the estimate.
   */
  pricingStore?: AgentPricingStore;
  /**
   * Fallback accounting label when the provider's turn result doesn't report a `modelId`.
   * Optional — a provider that reports its own model makes this unnecessary.
   */
  modelId?: string;
  /** Pre-computed (YYYY-MM-DD) so the loop body stays deterministic under durable replay. */
  day: string;
  /** The agent's base prompt. A flat string, or a {@link PromptBuilder} resolved per turn. */
  systemPrompt: string | PromptBuilder;
  maxSteps?: number;
  /** Optional host handle threaded to tool ctx (e.g. an ORM EntityManager). */
  host?: unknown;
  /** Agent-level tool allow-list (intersected with the persona's). Undefined → all tools. */
  toolAllowList?: string[];
  /**
   * Enables always-on ("inject") RAG: before the turn, retrieve passages for the user message and fold
   * them into the system prompt. Its presence IS inject mode (a retriever wired as a `read` tool for
   * agentic retrieval sets nothing here). Retrieval runs inside `hooks.step` so durable replay reuses
   * the same passages deterministically. Undefined → no injection (unchanged behavior).
   */
  retriever?: Retriever;
  /** How many passages inject-mode retrieval requests. Undefined → 5. */
  retrievalTopK?: number;
  /**
   * Derives the metadata filter applied to inject-mode RAG retrieval, from the run's actor.
   * Without it, retrieval is UNSCOPED: every passage in the corpus is eligible for every actor's
   * system prompt. Any deployment sharing one corpus across tenants must set this. The returned
   * object is passed verbatim as `RetrieveOptions.filter` and is interpreted by the store (see the
   * `audience` ACL pattern in docs/retrieval/rag.mdx). A throwing hook fails the turn rather than
   * falling back to unfiltered retrieval — a filter that fails open is worse than no filter.
   */
  retrievalFilter?: (actor: Actor) => Record<string, unknown>;
  /**
   * Retries a tool's own invocation, in place, when it throws a classified-transient error (a DB
   * deadlock, a lock-wait timeout, a serialization failure — see {@link isTransientToolError}) —
   * never a new durable step/checkpoint, just repeated attempts inside the same `tool:<call.id>` step
   * body (so a durable replay reuses the memoized successful result and side effects run once).
   * Default ON (`{ attempts: 2, backoffMs: 150 }` with the default classifier) when undefined; set
   * `{ classify }` to widen/narrow which errors count as transient, or `false` to disable entirely. A
   * tool's other (non-transient) failures are unaffected — they remain a one-shot business outcome.
   */
  toolTransientRetry?: ToolTransientRetrySetting;
  /**
   * Bounds how much of the persisted thread rides into the model call each turn. Undefined → the
   * WHOLE thread, every message the store holds, which is unbounded: a long-lived thread eventually
   * exceeds the provider's context limit, and pays for the full transcript on every turn until it
   * does. Applied once per run. See {@link SlidingWindowHistory} for the built-in.
   */
  historyWindow?: HistoryWindow;
  /**
   * Rewrites `{ system, messages }` before EVERY model call of the turn — masking identifiers,
   * stamping a policy preamble, collapsing an oversized tool result. Every step, not once per run,
   * because the transcript grows between steps. Adds one `process:input:<step>` checkpoint per step;
   * empty/undefined adds none, so a deployment with no processors records byte-identical
   * checkpoints.
   *
   * Not a second {@link HistoryWindow}: that owns WHICH messages ride into the turn (pure, outside
   * any checkpoint), this owns what they SAY (may call a model, journaled). The loop's canonical
   * `modelMessages` is untouched — a redaction is what leaves the process, never the thread's own
   * memory of what was said.
   */
  inputProcessors?: InputProcessor[];
  /**
   * Rules on each step's answer before anything downstream sees it, and may redact or refuse it.
   * Adds one `process:output:<step>` checkpoint per step.
   *
   * **Registering any of these takes the turn's model call off the run's live sink**, because a gate
   * that must read the answer cannot run after the answer has reached the reader. What that costs is
   * proportional to what the chain declares: a chain whose every member declares
   * {@link import('./spi/processors.js').OutputProcessor.incremental} keeps streaming a
   * lookback-bounded prefix; one undeclared member holds the whole answer and releases it as a
   * single `text` frame once the chain has passed.
   */
  outputProcessors?: OutputProcessor[];
  /**
   * Constrain the turn's answer to a schema — any [Standard Schema](https://standardschema.dev) —
   * returned validated as `object` on the loop's result and recorded on the assistant message as a
   * synthetic auto-executed `structured_output` tool call, the same device inject-mode retrieval
   * uses, so no store gains a column for it.
   *
   * HOW IT COMPOSES WITH TOOL CALLING: as a separate formatting pass, ALWAYS. The turn runs its
   * model→tools iteration exactly as it would without a schema; once a step comes back with no tool
   * calls, one extra non-streamed call (`structured:<step>:<attempt>`, `tools: []`, `outputSchema`
   * set) restates that answer as the schema. Most providers cannot serve a response format and a
   * tool set in one request, and skipping the pass for an agent that happens to have no tools would
   * make the checkpoint sequence depend on a tool-registry lookup — the registry of whichever
   * process is replaying — which is exactly how a run ends up asking for a position its history has
   * no room for. So the pass is unconditional, and it costs one model call per turn, billed as its
   * own `structured_output` usage row.
   */
  outputSchema?: StandardSchemaV1<unknown, TOutput>;
  /** Overrides the formatting pass's system prompt. Undefined → {@link DEFAULT_STRUCTURED_OUTPUT_INSTRUCTION}. */
  outputInstruction?: string;
  /**
   * How many extra model calls may try to fix an answer that failed `outputSchema`, each shown the
   * previous attempt's validation issues. Undefined → 1; `0` → fail on the first invalid reply.
   * Bounded because a model that cannot satisfy a schema usually cannot satisfy it on the fourth try
   * either, and every attempt is billed.
   */
  outputRepairAttempts?: number;
  /**
   * Show the formatting pass the turn's whole transcript instead of just the question and the
   * answer. For an agent whose answer cannot be restated from its own words — one that reports on
   * rows a tool returned and names only their total in the prose, say.
   *
   * OFF by default because the pass is a translation, and a translation needs the thing being
   * translated. The transcript it would otherwise carry is the turn's entire prompt a second time,
   * at no discount: the pass swaps the system block for the schema instruction, and the system block
   * is the prompt cache's prefix, so nothing of the first call's cache survives into it.
   */
  outputFromTranscript?: boolean;
  /**
   * A question set the agent puts to the user BEFORE it starts working — collecting the scope, as
   * against `awaitApproval`, which sanctions work already proposed. The questions are AUTHORED, so
   * the turn spends no model call producing them and a client knows the total ("Question 1 of 3")
   * the moment the form appears.
   *
   * The turn parks on the answers exactly as it parks on an approval, and the request persists as
   * the same tool-call row the model's `ask` writes — see {@link AgentLoopDeps.ask}. Undefined → no
   * intake, and a turn's checkpoint sequence is byte-identical to one that never had the option.
   */
  intake?: AgentIntake;
  /**
   * Offer the model the built-in `ask` tool, so it can put its own question set to the user when it
   * judges the scope is missing — the same surface as {@link AgentLoopDeps.intake}, minus the "known
   * in advance".
   *
   * `ask` is NOT a registered tool: it has no handler (the loop settles it against a human), and
   * keeping it out of the `ToolRegistry` is what keeps its kind out of a process-local lookup. The
   * loop appends its definition to the turn's tool list from THIS flag, which is module config and
   * therefore uniform across a deployment. Undefined/false → the model never sees it.
   */
  ask?: boolean;
  /**
   * Authored procedures the model can pull in mid-turn, scoped to the actor's own scope tokens — see
   * `skills.ts`. Undefined → no catalog block, no `skill` tool, and a turn's checkpoint sequence is
   * byte-identical to one that never had the option.
   *
   * WHAT IT COSTS THE PROMPT. Four things write the system block — the agent's own prompt, the
   * persona's, injected retrieval, and this — and the catalog is the cheapest of them by
   * construction: one line per skill, carrying a name, a scope and a description. A skill's BODY
   * never enters the system block at all; it arrives as a tool result, on the transcript, where
   * {@link AgentLoopDeps.historyWindow} already governs it. So a deployment with fifty skills pays
   * for fifty lines and for whichever bodies a turn actually asked to read.
   */
  skills?: SkillsConfig;
}

/**
 * What the `llm:<step>` checkpoint returns once an output gate is in play: the model's own result
 * plus the state of the gate that ran alongside it. All of it rides the CHECKPOINT rather than a
 * local variable — a run that suspends between the model call and the verdict resumes in a process
 * that never saw the model's stream, and a release decided from local state would either drop the
 * turn's whole stream or flush the same prefix into the reader a second time.
 */
interface BufferedModelTurnResult extends ModelTurnResult {
  /** Whole-answer mode: every frame the model wrote, held back from the subscriber. */
  bufferedFrames?: StreamFrame[];
  /** Incremental mode: the transformed prefix that already reached the reader. */
  releasedText?: string;
  /** A refusal an incremental gate reached on a prefix, carried out rather than thrown. */
  gateRejection?: GateRejection;
}

/** Renders retrieved passages as a numbered, citable context block appended to the system prompt. */
function buildContextBlock(passages: Passage[]): string {
  const items = passages
    .map((passage, index) => {
      const label = passage.source !== undefined ? ` (${passage.source})` : '';
      return `[${index + 1}]${label} ${passage.text}`;
    })
    .join('\n\n');
  return `<retrieved_context>\n${items}\n</retrieved_context>\nUse the retrieved context above to answer when relevant, and cite sources by their bracket number.`;
}

/** Intersect two allow-lists where `undefined` means "no restriction". */
function intersectAllow(a?: string[], b?: string[]): string[] | undefined {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  const second = new Set(b);
  return a.filter((name) => second.has(name));
}

/** One task's outcome under {@link AgentLoopHooks.parallel}, reported instead of thrown. */
export type SettledTask<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * The {@link AgentLoopHooks.parallel} implementation for a runner whose checkpoint positions are
 * handed out on the CALL — `@adonis-agora/durable`'s `ctx.localStep` is: it takes `pos.next()`
 * before its first `await`. Every task is invoked here, synchronously and in list order, before any
 * of them is awaited, which is what fixes the block of positions they occupy whatever order they
 * then settle in. Nothing rejects: the caller decides what an individual failure means.
 */
export function settleAll<T>(tasks: readonly (() => Promise<T>)[]): Promise<SettledTask<T>[]> {
  const started = tasks.map((task) => task());
  return Promise.all(
    started.map((work) =>
      work.then<SettledTask<T>, SettledTask<T>>(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error }),
      ),
    ),
  );
}

export interface AgentLoopHooks {
  runId: string;
  /**
   * True when this run executes as a replay-safe durable workflow, false/undefined for the inline
   * runner. Recorded on the `agent_run` row so governance can tell durable runs apart.
   */
  durable?: boolean;
  /** A writer for this run's live token stream (data plane). */
  openSink(): SinkWriter | Promise<SinkWriter>;
  /** HITL gate for an action tool. Inline resolves a pending promise; durable awaits a signal. */
  awaitApproval(call: ToolCallRequest, ctx: AiToolCtx): Promise<Decision>;
  /**
   * The wait an elicitation parks on. Both shipped runners map it to the SAME channel an approval
   * uses — `tool:<runId>:<callId>` — so an answer and an approval reach a parked run by one path.
   *
   * Optional, and its absence changes no checkpoint: the loop falls back to `awaitApproval` and
   * reads the decision as "the user confirmed the pre-picked answers" (approved) or "the user
   * skipped" (rejected). That is the honest reduction of a yes/no channel, and it means a host that
   * only ever implemented approval still runs an elicitation to completion instead of hanging.
   *
   * Declared as {@link HumanReply} rather than `ElicitationReply` because that is what the channel
   * really carries: a question set is parked as a `pending_approval` action, so a `Decision` can
   * arrive on this wait from the approvals inbox even where the host implements it. The loop reduces
   * one to the other, so an implementer never has to.
   */
  awaitAnswers?(request: ElicitationRequest, ctx: AiToolCtx): Promise<HumanReply>;
  /**
   * Run another named agent and return its answer. Provided only when the host wired multi-agent
   * support (durable → child workflow, inline → nested loop). Exposed to tools as `ctx.runAgent`.
   */
  runAgent?(agentName: string, task: string): Promise<{ text: string }>;
  /**
   * Checkpoint wrapper. Inline = call fn directly; durable = ctx.step(name, fn).
   * EVERY side-effect and control-flow read goes through this so durable replay returns
   * cached results (stable ids, no double-write, no re-streaming).
   */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Recognizes the runner's control-flow signals (durable suspend / continue-as-new) so the tool
   * transient-retry loop never mistakes one for a retryable tool error. Provided only by the durable
   * runner; the inline runner has no such notion and leaves it unset.
   */
  isControlFlowError?(error: unknown): boolean;
  /**
   * Run `tasks` concurrently, resolving once EVERY one has settled — one outcome per task, in INPUT
   * order, never rejecting. Supplying it is a statement about the runner's checkpointing: each task
   * MUST be invoked synchronously, in list order, before any is awaited, so a runner that hands out
   * positions on the call assigns them in that order regardless of which task finishes first.
   * {@link settleAll} is exactly that, and is what both bundled runners pass.
   *
   * Waiting for ALL of them is the other half of the contract. A durable runner unwinds a turn by
   * THROWING, and a sibling abandoned part-way through its own step is a tool nobody ever runs.
   *
   * Absent → the loop runs a turn's tool calls one at a time, which is the honest answer for a
   * runner whose positions are assigned anywhere other than the call.
   */
  parallel?<T>(tasks: readonly (() => Promise<T>)[]): Promise<SettledTask<T>[]>;
  /**
   * Does this run take the loop shape guarded by `id`? A runner replaying against recorded
   * checkpoints answers `false` for a run that started before the shape changed, so that run keeps
   * replaying the shape its history holds (`@adonis-agora/durable`'s `ctx.patched`, which consumes a
   * position for a new run and gives it back to an old one). Absent → `true`: a runner that records
   * no positions has no older shape to preserve.
   */
  patched?(id: string): Promise<boolean>;
}

export class QuotaExceededError extends Error {
  constructor() {
    super('Daily token quota exceeded');
    this.name = 'QuotaExceededError';
  }
}

/** Resolve a prompt that may be a flat string or a {@link PromptBuilder}. */
async function resolvePrompt(prompt: string | PromptBuilder, ctx: PromptContext): Promise<string> {
  return typeof prompt === 'function' ? prompt(ctx) : prompt;
}

/**
 * The effective system prompt for a turn: resolve the agent's base prompt first, then — if the
 * request selected a persona — resolve the persona prompt with that base as `basePrompt`, so a
 * persona builder can wrap the agent's base rather than discard it.
 */
async function resolveSystemPrompt(deps: AgentLoopDeps, input: AgentRunInput): Promise<string> {
  const base: Omit<PromptContext, 'basePrompt'> = {
    actor: input.actor,
    ...(input.persona !== undefined ? { persona: input.persona } : {}),
    ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
  };
  const basePrompt = await resolvePrompt(deps.systemPrompt, { ...base, basePrompt: '' });
  if (input.persona === undefined) {
    return basePrompt;
  }
  return resolvePrompt(input.persona.systemPrompt, { ...base, basePrompt });
}

/** An `agent`-kind tool's input is `{ task }` by convention; fall back to a JSON dump. */
function extractTask(input: unknown): string {
  if (typeof input === 'object' && input !== null && 'task' in input) {
    const task = (input as { task: unknown }).task;
    if (typeof task === 'string') {
      return task;
    }
  }
  return JSON.stringify(input);
}

/** Either the delegation target and its task, or why the gates refused the call. */
type DelegationOutcome =
  | { targetAgent: string; task: string; error?: undefined }
  | { targetAgent?: undefined; task?: undefined; error: string };

/**
 * What the `persist:toolcall:<callId>` checkpoint returns: the kind this call was resolved to, plus
 * the delegation verdict decided in the same checkpoint. Travels as a checkpoint output, so it must
 * stay JSON-round-trippable.
 */
interface PersistedToolCall {
  kind: ToolKind;
  /** `agent` kind only. */
  delegation?: DelegationOutcome;
}

/**
 * The gates a delegation must clear. Delegation bypasses `ToolRegistry.invoke` (it is a ctx-level
 * suspend point), so the three checks `invoke` applies have to be re-applied here in the same order
 * — authorization first, then shape:
 *  - the offered-tools (persona/agent allow-list) filter: a tool the model was not offered must not
 *    run, even if the model names it anyway;
 *  - the role/ability re-check. A synthesized delegate spec (`registerDelegateTools` in
 *    agent-deps-factory.ts) carries whatever `roles`/`ability` its `delegatesTo` edge declared, and
 *    nothing at all when the edge is a bare string — under `DefaultRolesPolicy` that is ADMIN-only,
 *    and under an authz posture a tool with no `ability` is always denied;
 *  - input validation, so a malformed input is rejected rather than silently coerced.
 *
 * Returns the verdict rather than throwing it: this runs inside the call's checkpoint, whose output
 * is what a replay reads back, and it has to run BEFORE any event publication so a refusal never
 * emits `agent.delegated`.
 */
async function resolveDelegation(
  deps: AgentLoopDeps,
  input: AgentRunInput,
  call: ToolCallRequest,
  spec: ToolSpec | undefined,
): Promise<DelegationOutcome> {
  try {
    if (spec === undefined) {
      // Unreachable while the kind is read off this same spec, but an `agent`-kind call with no
      // resolvable spec must fail closed rather than fall through.
      throw new ToolForbiddenError(call.name);
    }
    const offeredAllow = intersectAllow(input.persona?.allowedTools, deps.toolAllowList);
    if (offeredAllow !== undefined && !offeredAllow.includes(call.name)) {
      throw new ToolForbiddenError(call.name);
    }
    if (!(await deps.rolesPolicy.can(input.actor, spec))) {
      throw new ToolForbiddenError(call.name);
    }
    const validation = await spec.inputSchema['~standard'].validate(call.input);
    if (validation.issues !== undefined) {
      throw new ToolInputInvalidError(call.name, validation.issues);
    }
    return { targetAgent: spec.targetAgent ?? call.name, task: extractTask(validation.value) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function deriveTitle(userText: string): string {
  const trimmed = userText.trim().replace(/\s+/g, ' ');
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed || 'New chat';
}

/**
 * A step's cost: the provider's own reported figure when it has one (a gateway), else an estimate
 * from `price` when the model has a current price row, else `null` — never a fabricated `0` for
 * "we don't know". Mirrors the reference resolution order exactly.
 */
function resolveCostUsd(
  usage: MessageUsage,
  reportedCostUsd: number | undefined,
  price: CurrentModelPrice | undefined,
): number | null {
  if (reportedCostUsd !== undefined) {
    return reportedCostUsd;
  }
  return price === undefined ? null : estimateCost(usage, price);
}

/** Renders a folded-history summary as the leading `system` message of a windowed turn. */
function buildSummaryBlock(summary: string): string {
  return `<conversation_summary>\n${summary}\n</conversation_summary>\nEarlier messages in this thread are no longer included verbatim. Treat the summary above as an accurate record of them.`;
}

/**
 * Identifies the split shape to {@link AgentLoopHooks.patched}: a run whose journal holds one
 * `history:window` checkpoint has to keep replaying against that, not against a pure selection that
 * spends no position at all. Reached only when a window is configured, so a deployment with none
 * never spends the marker's position and records byte-identical checkpoints.
 */
const HISTORY_SELECT_PATCH = 'agent:history-select';

/**
 * Apply the configured ceiling to the thread's messages. `select` runs OUTSIDE any checkpoint — it
 * is contractually pure and its input is already `load:thread`'s cached result, so a replay reaches
 * the same split without a checkpoint of its own.
 *
 * Summarizing is the opposite: it calls a model. Journaled under `history:summarize`, so a resumed
 * run reads back the summary the suspended attempt produced (and does not pay for it twice) instead
 * of prompting with a different one. Both that checkpoint and the usage row below are reachable
 * only through a window that actually summarizes.
 */
async function applyHistoryWindow(
  window: HistoryWindow,
  deps: AgentLoopDeps,
  input: AgentRunInput,
  hooks: AgentLoopHooks,
  messages: ModelMessage[],
  step: AgentLoopHooks['step'],
): Promise<ModelMessage[]> {
  const ctx: HistoryWindowContext = { actor: input.actor, threadId: input.threadId };
  const { keep, drop } = window.select(messages, ctx);
  const summarize = window.summarize?.bind(window);
  if (drop.length === 0 || summarize === undefined) {
    return keep;
  }
  const summary = await step('history:summarize', () => summarize(drop, ctx));
  if (summary.usage !== undefined) {
    const usage = summary.usage;
    await step('persist:usage:history', () =>
      deps.store.recordUsage({
        threadId: input.threadId,
        actorRef: input.actor.id,
        runId: hooks.runId,
        modelId: summary.modelId ?? deps.modelId ?? 'unknown',
        purpose: 'summary',
        usage,
      }),
    );
  }
  return [{ role: 'system', content: buildSummaryBlock(summary.text) }, ...keep];
}

/**
 * The turn's tool list plus the built-ins the module offers — `ask`, `skill`. Appended from CONFIG
 * rather than the registry, because neither is ever registered: see {@link AgentLoopDeps.ask} and
 * {@link AgentLoopDeps.skills}.
 */
export function withBuiltInTools(args: {
  tools: ToolDefinition[];
  ask: boolean | undefined;
  skills: boolean;
}): ToolDefinition[] {
  return [
    ...args.tools,
    ...(args.ask === true ? [askToolDefinition()] : []),
    ...(args.skills ? [skillToolDefinition()] : []),
  ];
}

/**
 * Park on a question set, through whichever wait the host implemented, and read back whatever that
 * wait delivered as answers.
 *
 * The reduction of a yes/no channel — approve is "confirmed the pre-picked answers", reject is
 * "skipped" — applies to BOTH branches, because the shape of the reply is decided by whoever settled
 * the tool call, not by which hook the host wired. The question set sits in the approvals inbox as a
 * `pending_approval` action, so an operator pressing Approve there sends a `Decision` into a run
 * whose host implements `awaitAnswers` perfectly well.
 *
 * Neither branch moves a checkpoint: the wait sits at the same position either way, so the choice of
 * hook cannot change the sequence a replay lines up with.
 */
async function awaitElicitation(args: {
  hooks: AgentLoopHooks;
  request: ElicitationRequest;
  ctx: AiToolCtx;
}): Promise<ElicitationReply> {
  const { hooks, request, ctx } = args;
  if (hooks.awaitAnswers !== undefined) {
    return normalizeElicitationReply(await hooks.awaitAnswers(request, ctx));
  }
  return normalizeElicitationReply(
    await hooks.awaitApproval({ id: request.id, name: ASK_TOOL_NAME, input: request }, ctx),
  );
}

/**
 * Does the configured intake run this turn? Both inputs are facts the journal already holds — the
 * config, and `load:thread`'s record of whether the thread had an assistant message when the turn
 * began. Neither is re-read from the store here, and that is the point: by the time a replay reaches
 * this line the first attempt has already appended the intake's own assistant message to the thread,
 * so a fresh read would answer differently on the resume than it did on the way in — and the answer
 * decides how many checkpoints follow it.
 */
function intakeApplies(args: { intake: AgentIntake; threadHasAssistant: boolean }): boolean {
  return args.intake.when === 'every-turn' || !args.threadHasAssistant;
}

/**
 * The configured intake: post the authored question set, park until a human settles it, and leave
 * the exchange on the transcript as an ordinary tool round-trip so the model reads the answers the
 * same way it reads its own `ask`'s.
 *
 * COSTS NO MODEL CALL. The questions, their options and their pre-picked defaults are all authored
 * on the agent, so nothing here is generated and nothing here is billed — which is also why the
 * total is knowable before the first question is shown.
 *
 * One checkpoint whenever an `intake` is configured, plus two more on the turns it actually asks —
 * all reachable only through that config, so a run that predates the option cannot land on any of
 * them and no {@link AgentLoopHooks.patched} marker is spent keeping the sequence stable for it.
 */
async function runIntake(args: {
  intake: AgentIntake;
  deps: AgentLoopDeps;
  input: AgentRunInput;
  hooks: AgentLoopHooks;
  writer: SinkWriter;
  threadHasAssistant: boolean;
}): Promise<ModelMessage | null> {
  const { intake, deps, input, hooks, writer, threadHasAssistant } = args;
  const preamble = intake.preamble ?? DEFAULT_INTAKE_PREAMBLE;
  // Derived from the run, so a replay rebuilds the same id without minting one — the id is a
  // checkpoint name's suffix and the signal's own key, so it cannot come from a random source.
  const request: ElicitationRequest = {
    id: `intake-${hooks.runId}`,
    source: 'intake',
    preamble,
    questions: intake.questions,
  };
  const call: ToolCallRequest = {
    id: request.id,
    name: ASK_TOOL_NAME,
    input: { preamble, questions: intake.questions },
  };
  const asked = (await hooks.step('intake:ask', async (): Promise<string | null> => {
    if (!intakeApplies({ intake, threadHasAssistant })) {
      return null;
    }
    const message = await deps.store.appendMessage({
      threadId: input.threadId,
      role: 'assistant',
      content: preamble,
      runId: hooks.runId,
      toolCalls: [call],
      ...(input.persona !== undefined ? { persona: input.persona.id } : {}),
    });
    await deps.store.recordToolCall({
      toolCallId: request.id,
      messageId: message.id,
      toolName: ASK_TOOL_NAME,
      // The store knows read/action only. An unanswered question is work waiting on a human, which
      // is what `action` + `pending_approval` already mean — so it surfaces in an approvals inbox
      // rather than needing one of its own.
      toolType: 'action',
      input: call.input,
      status: 'pending_approval',
      runId: hooks.runId,
    });
    await writer.write({ t: 'elicitation', id: request.id, request });
    return message.id;
  })) as string | boolean | null;
  if (asked === null || asked === false) {
    return null;
  }
  // A checkpoint that recorded only WHETHER the intake ran carries no message id, so such a run
  // settles the tool-call row alone.
  const messageId = typeof asked === 'string' ? asked : null;
  const reply = await awaitElicitation({
    hooks,
    request,
    ctx: elicitationContext(deps, input, hooks),
  });
  const result = settleElicitation({ request, reply });
  await hooks.step('intake:answers', async () => {
    await deps.store.updateToolCall({
      toolCallId: request.id,
      // A skip is not an answer. Both leave the agent holding the same values, but only one of them
      // is evidence the user chose them, and a reader auditing what the agent was told has to be
      // able to tell those apart.
      status: result.skipped ? 'rejected' : 'executed',
      output: result,
      ...(result.skipped ? { error: 'skipped by the user' } : {}),
      ...(reply.answeredByRef !== undefined ? { executedByRef: reply.answeredByRef } : {}),
    });
    if (messageId !== null) {
      await deps.store.setMessageToolResults(messageId, [
        { id: request.id, name: ASK_TOOL_NAME, output: result },
      ]);
    }
  });
  return {
    role: 'assistant',
    content: preamble,
    toolCalls: [call],
    toolResults: [{ id: request.id, name: ASK_TOOL_NAME, output: result }],
  };
}

/** The context a wait is handed. The intake has no tool ctx of its own — it is not a tool call. */
function elicitationContext(
  deps: AgentLoopDeps,
  input: AgentRunInput,
  hooks: AgentLoopHooks,
): AiToolCtx {
  return {
    actor: input.actor,
    threadId: input.threadId,
    runId: hooks.runId,
    requestId: hooks.runId,
    ...(input.persona !== undefined ? { persona: input.persona } : {}),
    ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
    ...(deps.host !== undefined ? { host: deps.host } : {}),
  };
}

/**
 * Identifies the batched tool-call shape to {@link AgentLoopHooks.patched}: batching hoists a turn's
 * `persist:toolcall` checkpoints ahead of its first tool execution, so a run whose journal
 * interleaves them one call at a time has to keep replaying against THAT.
 */
const PARALLEL_TOOLS_PATCH = 'agent:parallel-tools';

/**
 * Identifies the message-borne tool results to {@link AgentLoopHooks.patched}: attaching them adds a
 * checkpoint after a turn's last tool, a position a run recorded under the shape without it cannot
 * supply.
 */
const MESSAGE_TOOL_RESULTS_PATCH = 'agent:message-tool-results';

/** What every per-call helper below needs from the turn that requested the call. */
interface ToolTurnContext {
  deps: AgentLoopDeps;
  input: AgentRunInput;
  hooks: AgentLoopHooks;
  /** The assistant message the calls hang off. */
  messageId: string;
  /** The run's live stream, so a tool can push a component into it. */
  writer: SinkWriter;
  /**
   * What `skills:catalog` recorded this turn, absent where skills are not configured. A `skill` call
   * is served against THIS, never against a fresh provider read — see {@link loadSkill}.
   */
  skills?: SkillOffer;
}

/** A tool call whose kind has been settled by its `persist:toolcall` checkpoint. */
interface ClaimedToolCall {
  call: ToolCallRequest;
  toolType: ToolKind;
  /** `agent` kind only: the verdict the same checkpoint decided. */
  delegation?: DelegationOutcome;
  ctx: AiToolCtx;
}

/**
 * A tool call the LOOP makes on the model's behalf — inject-mode retrieval, the structured answer.
 * It rides the assistant message and the tool-call table exactly as a model-issued read does, so a
 * reader renders it through the machinery it already has.
 */
interface SyntheticToolCall {
  /** The checkpoint that records the row, minus its `:<messageId>` suffix. */
  step: string;
  call: ToolCallRequest;
  result: ToolResult;
}

/** One invocation's result, already reduced to what the persist checkpoint writes. */
type ToolOutcome = { status: 'executed'; output: unknown } | { status: 'failed'; error: string };

/**
 * Record the call and settle its KIND, which decides this call's control flow: an `action` suspends
 * the run on an approval signal (`tool:<runId>:<callId>`), an `agent` delegates to a child run,
 * anything else records a plain step. Resolving it from `deps.registry` in the loop body would tie
 * that branch to the registry of WHICHEVER PROCESS runs the body — and a process whose registry
 * lacks the tool reads `undefined`, falls back to 'read', and then asks for a `tool:` checkpoint
 * where the history holds the approval signal. That is a non-determinism refusal on resume, and it
 * is an approval-gated action about to run with nobody's approval.
 *
 * So the lookup — and the delegation gates that hang off it — happen INSIDE the `persist:toolcall`
 * step, and the verdict is RETURNED from it. The first process to reach this call writes the kind
 * into the journal; every later replay reads it back instead of asking its own registry.
 */
async function claimToolCall(
  turn: ToolTurnContext,
  call: ToolCallRequest,
): Promise<ClaimedToolCall> {
  const { deps, input, hooks, messageId, writer } = turn;
  const persona = input.persona;
  const persisted = (await hooks.step(
    `persist:toolcall:${call.id}`,
    async (): Promise<PersistedToolCall> => {
      const kind: ToolKind = declaredKind(deps, call.name);
      if (kind === 'agent') {
        const delegation = await resolveDelegation(
          deps,
          input,
          call,
          deps.registry.spec(call.name),
        );
        await deps.store.recordToolCall({
          toolCallId: call.id,
          messageId,
          toolName: call.name,
          // The store knows read/action only; a delegation is neither approved nor rejected by a
          // human, so it persists as a read. A refused one is recorded `failed` directly — never
          // `auto_executed` even transiently.
          toolType: 'read',
          input: call.input,
          status: delegation.error !== undefined ? 'failed' : 'auto_executed',
          runId: hooks.runId,
        });
        return { kind, delegation };
      }
      // An `ask` persists exactly as an `action` does: the store knows read/action only, and an
      // unanswered question is work waiting on a human — which is what `pending_approval` already
      // means, so it lands in the approvals inbox a deployment already has.
      const parks = kind === 'action' || kind === 'ask';
      await deps.store.recordToolCall({
        toolCallId: call.id,
        messageId,
        toolName: call.name,
        toolType: parks ? 'action' : 'read',
        input: call.input,
        status: parks ? 'pending_approval' : 'auto_executed',
        runId: hooks.runId,
      });
      return { kind };
    },
  )) as PersistedToolCall | undefined;
  // A checkpoint written before the kind was journaled carries no output. Such a run is already
  // committed to whatever its first process resolved, so the local registry is the only thing left
  // to consult — reached by those runs alone.
  const toolType: ToolKind = persisted?.kind ?? declaredKind(deps, call.name);
  return {
    call,
    toolType,
    ...(persisted?.delegation !== undefined ? { delegation: persisted.delegation } : {}),
    ctx: {
      actor: input.actor,
      threadId: input.threadId,
      runId: hooks.runId,
      requestId: hooks.runId,
      emitComponent: (name: string, data: unknown) => writer.write({ t: 'component', name, data }),
      ...(persona !== undefined ? { persona } : {}),
      ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
      ...(deps.host !== undefined ? { host: deps.host } : {}),
    },
  };
}

/**
 * Execute one claimed call. Asks for its checkpoint SYNCHRONOUSLY — nothing is awaited before
 * `hooks.step` — which is what lets a batch of these be launched together and still occupy
 * positions in call order (see {@link AgentLoopHooks.parallel}).
 *
 * A tool's own failure is an OUTCOME, not a throw: the model is handed it as a result and adapts.
 * Only the runner's control flow (a suspend / continue-as-new) and a replay-integrity refusal
 * escape — answering either of those with a `persist:toolfail` checkpoint would ask for a position
 * a diverged history has no room for, so the operator reads that second refusal instead of the
 * disagreement that caused it.
 *
 * The retry loop runs INSIDE the `tool:<call.id>` step so it stays replay-safe: a durable step
 * memoizes only its successful result, so on replay the whole step returns cached and the retries
 * never re-run (side effects happen exactly once). The span sits inside the step body for the same
 * reason, and covers all in-place attempts; the tool's output never rides it.
 */
/**
 * The span's narrower tool vocabulary. An `ask` is settled against a human and a `skill` is read out
 * of the journal, so neither reaches a registry invocation; each maps to the kind whose control flow
 * it shares, for a reader of a trace who only ever sees the three.
 */
function spanToolType(kind: ToolKind): 'read' | 'action' | 'agent' {
  if (kind === 'ask') {
    return 'action';
  }
  return kind === 'skill' ? 'read' : kind;
}

async function invokeClaimedTool(
  turn: ToolTurnContext,
  claimed: ClaimedToolCall,
): Promise<ToolOutcome> {
  const { deps, hooks } = turn;
  const { call, ctx, toolType } = claimed;
  try {
    const output = await hooks.step(`tool:${call.id}`, () =>
      spannedAgent(
        'tool.execution',
        hooks.runId,
        {
          runId: hooks.runId,
          toolCallId: call.id,
          toolName: call.name,
          toolType: spanToolType(toolType),
        },
        () =>
          invokeWithTransientRetry(
            () => deps.registry.invoke(call.name, call.input, ctx, deps.rolesPolicy),
            deps.toolTransientRetry ?? {},
            {
              ...(hooks.isControlFlowError !== undefined
                ? { isControlFlowError: hooks.isControlFlowError }
                : {}),
              onRetry: (attempt, retryError) => {
                publishAgentToolRetry({
                  runId: hooks.runId,
                  toolName: call.name,
                  toolCallId: call.id,
                  attempt,
                  message: retryError instanceof Error ? retryError.message : String(retryError),
                });
              },
            },
          ),
        () => ({}),
      ),
    );
    return { status: 'executed', output };
  } catch (error) {
    if (isReplayIntegrityError(error) || hooks.isControlFlowError?.(error) === true) {
      throw error;
    }
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

/** Persist one settled invocation and shape the result the model is fed. */
async function recordToolOutcome(
  turn: ToolTurnContext,
  claimed: ClaimedToolCall,
  outcome: ToolOutcome,
): Promise<ToolResult> {
  const { deps, input, hooks } = turn;
  const { call } = claimed;
  // An `agent` call branches to delegation before reaching here, so anything that isn't an `action`
  // is a read — the same posture the kind fallback itself takes.
  const toolType = claimed.toolType === 'action' ? 'action' : 'read';
  if (outcome.status === 'failed') {
    await hooks.step(`persist:toolfail:${call.id}`, () =>
      deps.store.updateToolCall({ toolCallId: call.id, status: 'failed', error: outcome.error }),
    );
    publishAgentToolCall({ runId: hooks.runId, toolName: call.name, toolType, status: 'failed' });
    return { id: call.id, name: call.name, output: null, error: outcome.error };
  }
  await hooks.step(`persist:toolexec:${call.id}`, () =>
    deps.store.updateToolCall({
      toolCallId: call.id,
      status: 'executed',
      output: outcome.output,
      ...(toolType === 'action' ? { executedByRef: input.actor.id } : {}),
    }),
  );
  publishAgentToolCall({ runId: hooks.runId, toolName: call.name, toolType, status: 'executed' });
  return { id: call.id, name: call.name, output: outcome.output };
}

/**
 * Delegate to another agent (an `agent`-kind call). Dispatched at the LOOP level (not in a step)
 * because the durable runner maps it to `ctx.child`, a ctx-level suspend point.
 */
async function delegateToolCall(
  turn: ToolTurnContext,
  claimed: ClaimedToolCall,
): Promise<ToolResult> {
  const { deps, input, hooks } = turn;
  const { call } = claimed;
  const delegation =
    claimed.delegation ??
    (await resolveDelegation(deps, input, call, deps.registry.spec(call.name)));
  if (delegation.error !== undefined) {
    return { id: call.id, name: call.name, output: null, error: delegation.error };
  }
  const { targetAgent, task } = delegation;
  publishAgentDelegated({
    runId: hooks.runId,
    toAgent: targetAgent,
    ...(input.agentName !== undefined ? { fromAgent: input.agentName } : {}),
  });
  const sub = hooks.runAgent
    ? await hooks.runAgent(targetAgent, task)
    : { text: `(no multi-agent support wired; cannot reach "${targetAgent}")` };
  await hooks.step(`persist:toolexec:${call.id}`, () =>
    deps.store.updateToolCall({ toolCallId: call.id, status: 'executed', output: sub }),
  );
  return { id: call.id, name: call.name, output: sub };
}

/**
 * A call's declared kind, as settled inside `persist:toolcall` and journaled from there.
 *
 * The reserved `ask` name resolves from module CONFIG, never from the registry: `ask` has no handler
 * to register, and grounding its branch in config is what keeps a process with a partial registry
 * from disagreeing about it — the same property the registry lookup below has only because its
 * answer is written into the journal. Every other name is the registry's `ToolSpec`, as before.
 */
function declaredKind(deps: AgentLoopDeps, name: string): ToolKind {
  if (deps.ask === true && name === ASK_TOOL_NAME) {
    return 'ask';
  }
  if (deps.skills !== undefined && name === SKILL_TOOL_NAME) {
    return 'skill';
  }
  return deps.registry.spec(name)?.kind ?? 'read';
}

/**
 * Settle an `ask` call against a human. The model authored the questions, so unlike the configured
 * intake there is nothing to persist first — `persist:toolcall` already wrote the row, under the same
 * name and at the same position any other kind would have used.
 *
 * Costs nothing beyond the step that produced it: the question set arrived as the ARGUMENTS of a tool
 * call the model was already making, in a step already billed as `chat`. There is no second model
 * call and therefore no usage row of its own — the opposite of the structured-output pass.
 *
 * The two new positions here (`stream:elicitation:<id>`, and the wait) are reachable only when this
 * call's journaled kind is `ask`, which no run recorded before the kind existed. Every replay reads
 * that kind back rather than re-deciding it, so no run can disagree about whether they are there.
 */
async function elicitToolCall(
  turn: ToolTurnContext,
  claimed: ClaimedToolCall,
): Promise<ToolResult> {
  const { deps, hooks } = turn;
  const { call, ctx } = claimed;
  // Validated HERE rather than by the registry, which never sees this tool. Deterministic on the
  // same footing as `validateStructured`: a module-constant schema over an input the `llm:<i>`
  // checkpoint already holds, so every replay reaches the same verdict — and the same branch.
  const parsed = await askInputSchema['~standard'].validate(call.input);
  if (parsed.issues !== undefined) {
    const error = `invalid ask input: ${parsed.issues
      .map((each) => `${(each.path ?? []).join('.') || '(root)'}: ${each.message}`)
      .join('; ')}`;
    await hooks.step(`persist:toolfail:${call.id}`, () =>
      deps.store.updateToolCall({ toolCallId: call.id, status: 'failed', error }),
    );
    // A malformed question set is the model's mistake to fix, so it comes back as a tool failure —
    // the vocabulary the model already knows how to answer — rather than failing the run.
    return { id: call.id, name: call.name, output: null, error };
  }
  const request: ElicitationRequest = {
    id: call.id,
    source: 'ask',
    questions: parsed.value.questions,
    ...(parsed.value.preamble !== undefined ? { preamble: parsed.value.preamble } : {}),
  };
  await hooks.step(`stream:elicitation:${call.id}`, () =>
    Promise.resolve(turn.writer.write({ t: 'elicitation', id: call.id, request })),
  );
  const reply = await awaitElicitation({ hooks, request, ctx });
  const result = settleElicitation({ request, reply });
  await hooks.step(
    result.skipped ? `persist:toolreject:${call.id}` : `persist:toolexec:${call.id}`,
    () =>
      deps.store.updateToolCall({
        toolCallId: call.id,
        status: result.skipped ? 'rejected' : 'executed',
        output: result,
        ...(result.skipped ? { error: 'skipped by the user' } : {}),
        ...(reply.answeredByRef !== undefined ? { executedByRef: reply.answeredByRef } : {}),
      }),
  );
  publishAgentToolCall({
    runId: hooks.runId,
    toolName: call.name,
    toolType: 'action',
    status: result.skipped ? 'rejected' : 'executed',
  });
  return { id: call.id, name: call.name, output: result };
}

/** The turn's identity as the skills seam sees it — the same inputs the prompt is resolved from. */
function skillContext(input: AgentRunInput): SkillContext {
  return {
    actor: input.actor,
    threadId: input.threadId,
    ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
    ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
  };
}

/** What a served `skill` call hands back to the model — the procedure, and where it came from. */
interface LoadedSkillOutput {
  name: string;
  scope: string;
  body: string;
  /** Scopes of same-named skills this one overrode. Present only when it overrode something. */
  shadows?: string[];
}

/**
 * Serve one `skill` call: read the body and hand it to the model as an ordinary tool result.
 *
 * WHY THE BODY IS RETURNED FROM THE CHECKPOINT. Which instructions entered a turn's prompt is a
 * decision about the turn, and a decision about a turn has to be readable from its journal — the
 * same property `persist:toolcall` gives the read/action branch. A replay that re-read the provider
 * would compose a DIFFERENT prompt from a skill edited in between, at a transcript position the
 * history already holds: the model would then be answering something nobody can reconstruct from the
 * record. Inside `tool:<callId>` the first attempt's text is the only text there ever was.
 *
 * The positions are a read tool's, exactly (`persist:toolcall` before, `tool:<id>` here,
 * `persist:toolexec:<id>` / `persist:toolfail:<id>` after), so nothing about the shape of a turn
 * depends on whether a call was a skill — only on the kind the journal recorded.
 */
async function loadSkillIntoTurn(
  turn: ToolTurnContext,
  claimed: ClaimedToolCall,
): Promise<ToolOutcome> {
  const { deps, input, hooks } = turn;
  const { call } = claimed;
  const config = deps.skills;
  const offer = turn.skills;
  const outcome = await hooks.step(
    `tool:${call.id}`,
    async (): Promise<{ ok: true; output: LoadedSkillOutput } | { ok: false; error: string }> => {
      if (config === undefined || offer === undefined) {
        // Reachable where a call's journaled kind is `skill` but this process has no skills
        // configured. A tool failure, because it is the one vocabulary the model can act on, and
        // because failing the run would strand a turn over a lookup.
        return { ok: false, error: 'Skills are not available in this deployment.' };
      }
      const parsed = await skillInputSchema['~standard'].validate(call.input);
      if (parsed.issues !== undefined) {
        return {
          ok: false,
          error: `invalid skill input: ${parsed.issues
            .map((each) => `${(each.path ?? []).join('.') || '(root)'}: ${each.message}`)
            .join('; ')}`,
        };
      }
      const loaded = await loadSkill({
        config,
        offer,
        name: parsed.value.name,
        ctx: skillContext(input),
      });
      if (!loaded.ok) {
        return { ok: false, error: loaded.error };
      }
      return {
        ok: true,
        output: {
          name: loaded.skill.name,
          scope: loaded.skill.scope,
          body: loaded.skill.body,
          ...(loaded.shadows !== undefined ? { shadows: loaded.shadows } : {}),
        },
      };
    },
  );
  return outcome.ok
    ? { status: 'executed', output: outcome.output }
    : { status: 'failed', error: outcome.error };
}

/**
 * Run one claimed call's INVOCATION, whatever kind it is. A `skill` reads the catalog the journal
 * holds instead of the registry; everything that reaches here spends the same `tool:<id>` position
 * either way, which is what lets the two be batched together.
 */
function invokeClaimed(turn: ToolTurnContext, claimed: ClaimedToolCall): Promise<ToolOutcome> {
  return claimed.toolType === 'skill'
    ? loadSkillIntoTurn(turn, claimed)
    : invokeClaimedTool(turn, claimed);
}

/** Everything a claimed call still needs, on its own: delegation or approval, then execute. */
async function runClaimedToolCall(
  turn: ToolTurnContext,
  claimed: ClaimedToolCall,
): Promise<ToolResult> {
  const { deps, hooks } = turn;
  const { call, toolType, ctx } = claimed;
  if (toolType === 'agent') {
    return delegateToolCall(turn, claimed);
  }
  if (toolType === 'ask') {
    return elicitToolCall(turn, claimed);
  }

  if (toolType === 'action') {
    const decision = await hooks.awaitApproval(call, ctx);
    if (!decision.approved) {
      await hooks.step(`persist:toolreject:${call.id}`, () =>
        deps.store.updateToolCall({
          toolCallId: call.id,
          status: 'rejected',
          ...(decision.reason !== undefined ? { error: decision.reason } : {}),
        }),
      );
      publishAgentToolCall({
        runId: hooks.runId,
        toolName: call.name,
        toolType,
        status: 'rejected',
      });
      return {
        id: call.id,
        name: call.name,
        output: { rejected: true, reason: decision.reason ?? 'rejected by user' },
        error: 'rejected',
      };
    }
  }
  return recordToolOutcome(turn, claimed, await invokeClaimed(turn, claimed));
}

/**
 * Overlap the INVOCATIONS of a batch of claimed calls, and only those. The persist checkpoints on
 * either side stay strictly sequential, in call order — they are asked for after their neighbours'
 * positions are already spent, so nothing about them depends on which tool finished first.
 *
 * A rejection here is the runner unwinding the turn, never a tool's own failure
 * ({@link invokeClaimedTool} reports those). Rethrow the first one in call order and persist
 * NOTHING: the resume replays this whole block, and a `persist:toolexec` written now would sit at
 * the position the replay computes for an earlier call's.
 */
async function invokeClaimedToolsTogether(
  turn: ToolTurnContext,
  parallel: NonNullable<AgentLoopHooks['parallel']>,
  claimed: ClaimedToolCall[],
): Promise<ToolResult[]> {
  const settled = await parallel(claimed.map((entry) => () => invokeClaimed(turn, entry)));
  for (const outcome of settled) {
    if (!outcome.ok) {
      throw outcome.error;
    }
  }
  const results: ToolResult[] = [];
  for (const [index, entry] of claimed.entries()) {
    const outcome = settled[index];
    if (outcome?.ok === true) {
      results.push(await recordToolOutcome(turn, entry, outcome.value));
    }
  }
  return results;
}

/**
 * What the formatting pass is shown. By default the QUESTION and the ANSWER — the pass is a
 * translation of the answer, and its own instruction tells the model to use only what the
 * conversation already contains, so handing it the whole transcript again would roughly double what
 * a turn with an `outputSchema` costs for nothing. See {@link AgentLoopDeps.outputFromTranscript}
 * for the agent that genuinely needs more, and why it is off by default.
 *
 * The question comes off the PROCESSED prompt rather than `AgentRunInput.userText`: this pass is a
 * second route out of the model and has to stand behind the same input chain the streamed turn did,
 * so a question a processor masked cannot reappear in the clear here.
 */
function restatementPrompt(args: {
  messages: ModelMessage[];
  answer: string;
  fromTranscript: boolean;
}): ModelMessage[] {
  const restated: ModelMessage = { role: 'assistant', content: args.answer };
  if (args.fromTranscript) {
    return [...args.messages, restated];
  }
  // The last user message that actually SAYS something. The loop feeds a step's tool results back
  // as an empty `user` message carrying `toolResults`, so scanning for the last `user` role alone
  // would hand the pass a blank question on every turn that called a tool.
  for (let index = args.messages.length - 1; index >= 0; index -= 1) {
    const message = args.messages[index];
    if (message?.role === 'user' && message.content.length > 0) {
      return [message, restated];
    }
  }
  return [restated];
}

/** One attempt of the formatting pass: what the model replied, and what it cost. */
interface StructuredAttempt {
  text: string;
  object?: unknown;
  usage: MessageUsage;
  modelId?: string;
}

/**
 * Restate a finished answer as `deps.outputSchema`, repairing a rejected reply up to
 * `outputRepairAttempts` times. Every model call is its own checkpoint (`structured:<step>:<n>`)
 * with its own usage row, so a suspend between two attempts resumes on the reply the first one got
 * rather than paying for a third.
 *
 * Validation itself sits OUTSIDE the checkpoints, on the same footing as `HistoryWindow.select`: its
 * inputs are the schema (module config, identical on every process of a deployment) and a reply a
 * checkpoint already holds, so every replay reaches the same verdict — and therefore the same number
 * of attempts — without a checkpoint of its own.
 *
 * THE OUTPUT CHAIN RULES ON EACH ATTEMPT, before the schema does. This pass is a second route out of
 * the model, so anything the chain held back from the prose must not be able to leave through here.
 * It is gated on the WHOLE reply regardless of what the chain declared, because nothing here is
 * streamed — there is no prefix for an `incremental` processor to release.
 */
async function structureAnswer<TOutput>(args: {
  schema: StandardSchemaV1<unknown, TOutput>;
  deps: AgentLoopDeps<TOutput>;
  input: AgentRunInput;
  hooks: AgentLoopHooks;
  messages: ModelMessage[];
  step: number;
  ctx: ProcessorContext;
}): Promise<TOutput> {
  const { schema, deps, input, hooks, messages, step, ctx } = args;
  const instruction = deps.outputInstruction ?? DEFAULT_STRUCTURED_OUTPUT_INSTRUCTION;
  const maxAttempts = 1 + (deps.outputRepairAttempts ?? 1);
  const outputProcessors = deps.outputProcessors ?? [];
  let issues: readonly StandardSchemaV1.Issue[] = [];
  let text = '';
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const system = attempt === 0 ? instruction : repairInstruction({ instruction, issues });
    const reply = await hooks.step(
      `structured:${step}:${attempt}`,
      async (): Promise<StructuredAttempt> => {
        // A sink that drops every frame: this call is not the turn's answer, so its tokens must never
        // reach the reader's stream alongside the prose they are restating.
        const discard: SinkWriter = { write: () => {}, end: () => {} };
        const turn = await deps.model.runTurn({
          system,
          messages,
          tools: [],
          sink: discard,
          outputSchema: schema,
        });
        return {
          text: turn.text,
          usage: turn.usage,
          ...(turn.object !== undefined ? { object: turn.object } : {}),
          ...(turn.modelId !== undefined ? { modelId: turn.modelId } : {}),
        };
      },
    );
    await hooks.step(`persist:usage:structured:${step}:${attempt}`, () =>
      deps.store.recordUsage({
        threadId: input.threadId,
        actorRef: input.actor.id,
        runId: hooks.runId,
        modelId: reply.modelId ?? deps.modelId ?? 'unknown',
        purpose: 'structured_output',
        usage: reply.usage,
      }),
    );
    text = reply.text;
    if (outputProcessors.length > 0) {
      // Its own checkpoint, after the usage row: the tokens were spent either way, and a refusal
      // that also hid its own cost would let a mis-tuned gate burn a budget invisibly — the same
      // ordering the streamed answer's gate takes.
      const gate = await hooks.step(`process:output:structured:${step}:${attempt}`, () =>
        runOutputProcessors({
          processors: outputProcessors,
          answer: { text: reply.text, toolCalls: [] },
          ctx,
        }),
      );
      if (gate.rejection !== undefined) {
        throw new OutputRejectedError(gate.rejection.processor, gate.rejection.reason);
      }
      text = gate.text;
    }
    // A provider that constrained its own generation reports a parsed `object`, but that object
    // describes the reply the chain has just rewritten. Once the two disagree, the gated text is the
    // only version anything downstream may see, so it is re-parsed rather than trusted.
    const reported = text === reply.text ? reply.object : undefined;
    const outcome = await validateStructured({ schema, text, reported });
    if (outcome.ok) {
      return outcome.value;
    }
    issues = outcome.issues;
  }
  throw new StructuredOutputError(issues, text, maxAttempts);
}

/** What a turn answered with: the assistant text, plus the validated `outputSchema` value if any. */
export interface AgentLoopResult<TOutput = unknown> {
  text: string;
  /** Present only when {@link AgentLoopDeps.outputSchema} was set — the validated structured answer. */
  object?: TOutput;
}

/**
 * The provider-agnostic agent turn, reused by both the inline and durable runners.
 * It drives the model→tools→model iteration; the runner supplies the `step`/`awaitApproval`
 * hooks that make the same loop body either in-process or a replay-safe durable workflow.
 */
export async function runAgentLoop<TOutput = unknown>(
  deps: AgentLoopDeps<TOutput>,
  input: AgentRunInput,
  hooks: AgentLoopHooks,
): Promise<AgentLoopResult<TOutput>> {
  const maxSteps = deps.maxSteps ?? 8;
  const persona = input.persona;
  let system = await resolveSystemPrompt(deps, input);
  const inputProcessors = deps.inputProcessors ?? [];
  const outputProcessors = deps.outputProcessors ?? [];
  const gateMode = resolveOutputGateMode(outputProcessors);
  const gateLookback = resolveGateLookback(outputProcessors);
  const processorContext = (step: number): ProcessorContext => ({
    threadId: input.threadId,
    actor: input.actor,
    step,
    ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
    ...(persona !== undefined ? { persona: persona.id } : {}),
  });

  // Open the run (turn) row FIRST — before the quota gate — so even a quota-rejected run is tracked
  // (the runner settles it `failed`). A checkpointed step so a durable replay reuses the ONE row (no
  // duplicate on resume); `run_id` is then stamped onto every message / tool call / usage row below.
  await hooks.step('persist:run:start', () =>
    deps.store.recordRunStart({
      runId: hooks.runId,
      threadId: input.threadId,
      actor: input.actor,
      durable: hooks.durable ?? false,
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
    }),
  );

  if (deps.quota !== undefined) {
    const quota = deps.quota;
    const state = await hooks.step('quota:check', () => quota.check(input.actor.id, deps.day));
    if (!state.withinLimit) {
      throw new QuotaExceededError();
    }
  }

  // Attachments arrive already staged (the upload route + AttachmentStagingStore turned bytes into a
  // model-fetchable url), so persisting them here is a plain field write — no IO to wrap in a step.
  // The multimodal content parts are built by the model adapter at turn time from the url.
  await hooks.step('persist:user', () =>
    deps.store.appendMessage({
      threadId: input.threadId,
      role: 'user',
      content: input.userText,
      runId: hooks.runId,
      ...(persona !== undefined ? { persona: persona.id } : {}),
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
    }),
  );

  const thread = await hooks.step('load:thread', () => deps.store.getThread(input.threadId));
  // Whether this thread had already been answered when the turn began — the one fact a
  // `thread-start` intake is decided from, taken off `load:thread`'s CACHED result so a replay
  // reads the same answer the first attempt did. See {@link runIntake}.
  const threadHasAssistant = (thread?.messages ?? []).some(
    (message) => message.role === 'assistant',
  );
  const fullHistory: ModelMessage[] = (thread?.messages ?? []).map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolResults !== undefined ? { toolResults: message.toolResults } : {}),
    ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
  }));
  // With no window configured this whole block is skipped, so an existing deployment sends
  // byte-identical history and records byte-identical checkpoints.
  let modelMessages: ModelMessage[] = fullHistory;
  if (deps.historyWindow !== undefined) {
    const window = deps.historyWindow;
    modelMessages = (await (hooks.patched?.(HISTORY_SELECT_PATCH) ?? Promise.resolve(true)))
      ? await applyHistoryWindow(window, deps, input, hooks, fullHistory, hooks.step)
      : // A run whose history holds the single `history:window` checkpoint replays against it: a
        // completed one returns its recorded messages without re-running anything, and one that has
        // yet to reach it runs the whole fold INSIDE that one checkpoint — nested checkpoints would
        // take positions the recorded shape never had, and go missing the moment the outer one
        // replays from cache.
        await hooks.step('history:window', () =>
          applyHistoryWindow(window, deps, input, hooks, fullHistory, (_name, fn) => fn()),
        );
  }

  const writer = await hooks.openSink();
  let lastText = '';
  let steps = 0;
  let totalInput = 0;
  let totalOutput = 0;
  // Run-level cost rollup: sum only the steps whose cost we actually know (provider-reported or
  // priced). If NO step had a cost, the run's `cost_usd` stays `null` — never a fabricated `0`.
  let totalCost = 0;
  let hasCost = false;
  let structured: TOutput | undefined;

  publishAgentRunStarted({
    runId: hooks.runId,
    threadId: input.threadId,
    actorId: input.actor.id,
    ...(persona !== undefined ? { persona: persona.id } : {}),
  });

  // Inject-mode RAG: retrieve once for the user message and fold the passages into the system prompt.
  // Wrapped in `hooks.step` so a durable replay reuses the SAME passages (no re-query, deterministic
  // prompt). Recorded below as a synthetic auto-executed `retrieve` tool call on the first assistant
  // message, so citations surface through the same machinery as an agentic search would.
  let injectedPassages: Passage[] | undefined;
  if (deps.retriever !== undefined) {
    const retriever = deps.retriever;
    const topK = deps.retrievalTopK ?? 5;
    // Span the retrieval INSIDE the step body so durable replay (which returns the cached passages)
    // never re-emits it. traceId = runId correlates it into the turn's waterfall.
    //
    // The filter is derived HERE, inside the step body, not before `hooks.step` is called: durable
    // replay must reuse the cached passages rather than recomputing a filter that might have
    // changed since. `retrievalFilter` is called synchronously — if it throws, that throw
    // propagates out of the step (the `async` wrapper below turns a synchronous throw into a
    // rejection) and fails the turn. It must NEVER be caught here and treated as "no filter": a
    // filter that fails open is worse than no filter, because the operator believes it is on.
    // With no hook configured, `filter` is omitted from `options` entirely (not set to
    // `undefined`) so existing single-tenant deployments send byte-identical options.
    const retrieved = await hooks.step('retrieve', async () => {
      const options: RetrieveOptions = {
        topK,
        ...(deps.retrievalFilter !== undefined
          ? { filter: deps.retrievalFilter(input.actor) }
          : {}),
      };
      return spannedAgent(
        'retrieval',
        hooks.runId,
        { runId: hooks.runId, queryLength: input.userText.length, topK },
        // `retrieveWithUsage` quando o retriever sabe contar; senão o `retrieve` de sempre,
        // embrulhado no mesmo formato. É assim que um retriever de terceiro, escrito antes desta
        // capacidade, continua funcionando sem mudar uma linha.
        async (): Promise<RetrievalResult> =>
          typeof retriever.retrieveWithUsage === 'function'
            ? retriever.retrieveWithUsage(input.userText, options)
            : { passages: await retriever.retrieve(input.userText, options) },
        (result) => ({ count: result.passages.length }),
      );
    });
    const passages = retrieved.passages;

    // O embedding da consulta é gasto, e vai para o ledger como qualquer outro. Dentro de um
    // `hooks.step` porque uma retomada durable NÃO pode cobrar duas vezes pelo mesmo embedding.
    //
    // O `modelId` vem do que o provider REPORTOU; sem ele não há como precificar, e gravar um
    // placeholder faria a linha parecer precificável e sair como $0.00 — pior do que a ausência.
    if (retrieved.usage !== undefined && retrieved.usage.inputTokens > 0) {
      const embeddingUsage = retrieved.usage;
      await hooks.step('persist:usage:embedding', () =>
        deps.store.recordUsage({
          threadId: input.threadId,
          actorRef: input.actor.id,
          runId: hooks.runId,
          modelId: embeddingUsage.modelId ?? 'unknown',
          purpose: 'embedding',
          // Embedding só tem lado de entrada. `outputTokens: 0` é o fato, não um placeholder.
          usage: { inputTokens: embeddingUsage.inputTokens, outputTokens: 0 },
        }),
      );
    }

    if (passages.length > 0) {
      injectedPassages = passages;
      system = `${system}\n\n${buildContextBlock(passages)}`;
    }
    publishAgentRetrieved({
      runId: hooks.runId,
      queryLength: input.userText.length,
      count: passages.length,
    });
  }

  // The skills catalog, LAST of the things that write the system block (base prompt, persona,
  // retrieved context, this) — so a reader of the assembled prompt meets the agent's own
  // instructions before the menu of ones it could go and fetch.
  //
  // One checkpoint, holding the WHOLE offer: the scopes the resolver returned and the entries that
  // survived precedence. That payload is what the block is rendered from and what a later `skill`
  // call is served against, so the two things a turn's prompt depends on — which scopes applied, and
  // which skills they yielded — are facts the journal holds rather than answers a replaying
  // process's provider would give afresh.
  let skillOffer: SkillOffer | undefined;
  if (deps.skills !== undefined) {
    const config = deps.skills;
    skillOffer = await hooks.step('skills:catalog', () => offerSkills(config, skillContext(input)));
    // No entries, no block: an actor whose scopes yield nothing pays nothing, rather than reading a
    // heading over an empty list and wondering what it was for.
    if (skillOffer.entries.length > 0) {
      system = `${system}\n\n${buildSkillsBlock(skillOffer.entries)}`;
    }
  }

  // Fetched ONCE per run (not per step) and reused for every step's cost estimate below. Returned as
  // a plain array (not the Map built from it) so a durable runner can JSON-cache the step's result.
  let prices: CurrentModelPrice[] = [];
  if (deps.pricingStore !== undefined) {
    const pricingStore = deps.pricingStore;
    prices = await hooks.step('pricing:list', () => pricingStore.listCurrentPrices());
  }
  const priceByModel = new Map(prices.map((price) => [price.modelId, price]));

  // The configured intake, LAST before the first model call: everything the run records about itself
  // (the run row, retrieval, prices) is settled before the turn parks on a person, who may take a
  // day. The whole block is reachable only through `deps.intake`.
  if (deps.intake !== undefined) {
    const asked = await runIntake({
      intake: deps.intake,
      deps,
      input,
      hooks,
      writer,
      threadHasAssistant,
    });
    if (asked !== null) {
      modelMessages.push(asked);
    }
  }

  // NOTE: no try/finally around this loop. A durable runner suspends by THROWING through the stack
  // at `awaitApproval` (ctx.waitForSignal); a finally would then call writer.end() on every suspend
  // and prematurely close the live stream. We only end on normal completion — the throw propagates
  // to the engine, and the resumed replay reaches the writer.end() below.
  for (let i = 0; i < maxSteps; i += 1) {
    const tools = withBuiltInTools({
      tools: await deps.registry.definitionsFor(
        input.actor,
        deps.rolesPolicy,
        intersectAllow(persona?.allowedTools, deps.toolAllowList),
      ),
      ask: deps.ask,
      skills: skillOffer !== undefined,
    });

    // Every step, not once per run: the transcript grows between steps, so a processor that only saw
    // the opening prompt would wave through whatever a tool result carried back. The result is a
    // per-step DERIVED prompt — `modelMessages` stays the loop's canonical transcript, so a redaction
    // never becomes the thread's own memory of what was said.
    let prompt: ProcessedPrompt = { system, messages: modelMessages };
    if (inputProcessors.length > 0) {
      prompt = await hooks.step(`process:input:${i}`, () =>
        runInputProcessors({ processors: inputProcessors, prompt, ctx: processorContext(i) }),
      );
    }

    // Span the model call INSIDE the step body (replay-safe). The turn's raw text/output never rides
    // the span — only token counts + name/length metadata (the point events' redaction posture).
    let turn: BufferedModelTurnResult = await hooks.step(`llm:${i}`, () =>
      spannedAgent(
        'llm.turn',
        hooks.runId,
        { runId: hooks.runId, step: i },
        async (): Promise<BufferedModelTurnResult> => {
          const incremental =
            gateMode === 'incremental'
              ? createIncrementalGate({
                  processors: outputProcessors,
                  ctx: processorContext(i),
                  lookbackChars: gateLookback,
                  writer,
                })
              : undefined;
          const buffer = gateMode === 'whole' ? createFrameBuffer() : undefined;
          const result = await deps.model.runTurn({
            system: prompt.system,
            messages: prompt.messages,
            tools,
            sink: incremental?.writer ?? buffer?.writer ?? writer,
          });
          if (incremental !== undefined) {
            await incremental.settled();
            const refusal = incremental.rejection();
            return {
              ...result,
              releasedText: incremental.released(),
              ...(refusal !== undefined ? { gateRejection: refusal } : {}),
            };
          }
          return buffer === undefined ? result : { ...result, bufferedFrames: buffer.frames() };
        },
        (result) => ({
          ...(result.modelId !== undefined ? { modelId: result.modelId } : {}),
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          textLength: result.text.length,
          toolCalls: result.toolCalls.length,
        }),
      ),
    );

    // The gate runs before ANYTHING downstream: before the held frames reach the subscriber, before
    // the assistant message is persisted, before this text becomes the next step's context.
    let rejection: GateRejection | undefined;
    if (gateMode !== 'off') {
      const gate = await hooks.step(`process:output:${i}`, async () => {
        // Which release this turn still owes is read from the JOURNALED model result, never from the
        // chain configured on whichever process is running now: `releasedText` is the record that a
        // prefix already reached the reader, so a run that resumes under a re-declared chain cannot
        // flush the same answer a second time.
        const released = turn.releasedText;
        // A refusal an incremental gate already reached. Re-running the chain would bill the same
        // verdict twice.
        if (turn.gateRejection !== undefined) {
          return { text: turn.text, rejection: turn.gateRejection };
        }
        const settled = await runOutputProcessors({
          processors: outputProcessors,
          answer: { text: turn.text, toolCalls: turn.toolCalls },
          ctx: processorContext(i),
        });
        // Releasing inside the same checkpoint as the verdict is what makes "refused" and "nothing
        // was streamed" one fact rather than two that a suspend could separate. For an incremental
        // turn the second half of that is weaker by construction — a prefix is already out — and the
        // whole-answer pass stays authoritative for both the stream and the store.
        if (settled.rejection === undefined) {
          if (released === undefined) {
            for (const frame of releaseGatedFrames({
              frames: turn.bufferedFrames ?? [],
              text: settled.text,
            })) {
              await writer.write(frame);
            }
          } else {
            const tail = gateTail({ processors: outputProcessors, released, text: settled.text });
            if (tail.length > 0) {
              await writer.write({ t: 'text', v: tail });
            }
          }
        }
        return settled;
      });
      rejection = gate.rejection;
      turn = { ...turn, text: gate.text };
    }

    // provider-reported model wins over the configured fallback, so cost can't misattribute
    const resolvedModelId = turn.modelId ?? deps.modelId ?? 'unknown';
    // Provider-reported spend wins; else an estimate from the (once-per-run cached) price list; else
    // `null` — stamped onto the persisted assistant message's `usage.costUsd` below.
    // `resolveModelPrice` e não `priceByModel.get`: o provider responde com o snapshot datado
    // (`gpt-4o-mini-2024-07-18`) e o operador precifica o alias (`gpt-4o-mini`). Ver o helper.
    const costUsd = resolveCostUsd(
      turn.usage,
      turn.costUsd,
      resolveModelPrice(priceByModel, resolvedModelId),
    );

    await hooks.step(`persist:usage:${i}`, () =>
      deps.store.recordUsage({
        threadId: input.threadId,
        actorRef: input.actor.id,
        runId: hooks.runId,
        modelId: resolvedModelId,
        purpose: 'chat',
        usage: turn.usage,
        // persist the provider's actual cost when reported; the read-model prefers it over pricing
        ...(turn.costUsd !== undefined ? { costUsd: turn.costUsd } : {}),
      }),
    );
    if (costUsd !== null) {
      totalCost += costUsd;
      hasCost = true;
    }
    if (deps.quota !== undefined) {
      const quota = deps.quota;
      await hooks.step(`quota:bump:${i}`, () =>
        quota.bump(input.actor.id, deps.day, turn.usage.inputTokens + turn.usage.outputTokens),
      );
    }

    // Thrown only AFTER the two accounting checkpoints above: those tokens were genuinely spent, and
    // a refusal that also hid its own cost would let a mis-tuned gate burn a budget invisibly.
    if (rejection !== undefined) {
      throw new OutputRejectedError(rejection.processor, rejection.reason);
    }

    steps += 1;
    totalInput += turn.usage.inputTokens;
    totalOutput += turn.usage.outputTokens;
    lastText = turn.text;

    // Restating the GATED text, never the model's raw reply: the formatting pass is a translation of
    // the answer that survived the output chain, not a second route out of the model.
    if (turn.toolCalls.length === 0 && deps.outputSchema !== undefined) {
      structured = await structureAnswer({
        schema: deps.outputSchema,
        deps,
        input,
        hooks,
        messages: restatementPrompt({
          messages: prompt.messages,
          answer: turn.text,
          fromTranscript: deps.outputFromTranscript === true,
        }),
        step: i,
        ctx: processorContext(i),
      });
    }

    publishAgentMessage({
      runId: hooks.runId,
      threadId: input.threadId,
      role: 'assistant',
      textLength: turn.text.length,
    });
    // Inject-mode retrieval and the structured answer both reach a reader as ordinary tool calls.
    // Their ids come off the RUN rather than the message they hang from, because the message does
    // not exist yet and both have to be on the append below: a reader pairs a call with its result
    // off the message, so a call added afterwards renders as a tool still running. Every value here
    // is already settled by a checkpoint this turn ran (`retrieve`, `structured:<step>:<n>`), so a
    // replay rebuilds the same pair rather than minting one.
    const synthetic: SyntheticToolCall[] = [];
    if (i === 0 && injectedPassages !== undefined) {
      const call: ToolCallRequest = {
        id: `retrieve-${hooks.runId}`,
        name: 'retrieve',
        input: { query: input.userText },
      };
      const output = { passages: injectedPassages };
      synthetic.push({
        step: 'persist:retrieval',
        call,
        result: { id: call.id, name: call.name, output },
      });
    }
    if (structured !== undefined) {
      const call: ToolCallRequest = {
        id: `structured-${hooks.runId}`,
        name: 'structured_output',
        input: {},
      };
      synthetic.push({
        step: 'persist:structured',
        call,
        result: { id: call.id, name: call.name, output: structured },
      });
    }
    const messageCalls = [...turn.toolCalls, ...synthetic.map((entry) => entry.call)];
    const syntheticResults = synthetic.map((entry) => entry.result);

    const assistant = await hooks.step(`persist:assistant:${i}`, () =>
      deps.store.appendMessage({
        threadId: input.threadId,
        role: 'assistant',
        content: turn.text,
        runId: hooks.runId,
        usage: { ...turn.usage, costUsd },
        ...(persona !== undefined ? { persona: persona.id } : {}),
        ...(messageCalls.length > 0 ? { toolCalls: messageCalls } : {}),
        ...(syntheticResults.length > 0 ? { toolResults: syntheticResults } : {}),
      }),
    );
    modelMessages.push({
      role: 'assistant',
      content: turn.text,
      ...(messageCalls.length > 0 ? { toolCalls: messageCalls } : {}),
      ...(syntheticResults.length > 0 ? { toolResults: syntheticResults } : {}),
    });

    for (const entry of synthetic) {
      const { call, result } = entry;
      await hooks.step(`${entry.step}:${assistant.id}`, async () => {
        await deps.store.recordToolCall({
          toolCallId: call.id,
          messageId: assistant.id,
          toolName: call.name,
          toolType: 'read',
          input: call.input,
          status: 'auto_executed',
          runId: hooks.runId,
        });
        await deps.store.updateToolCall({
          toolCallId: call.id,
          status: 'executed',
          output: result.output,
        });
      });
    }

    if (turn.toolCalls.length === 0) {
      break;
    }

    const results: ToolResult[] = [];
    const turnCalls: ToolTurnContext = {
      deps,
      input,
      hooks,
      messageId: assistant.id,
      writer,
      ...(skillOffer !== undefined ? { skills: skillOffer } : {}),
    };
    // A model routinely asks for several tools at once, and running them back to back makes the
    // turn cost their sum. Overlapping them is safe here because a checkpoint position is handed
    // out on the CALL, not when the work settles: launching every invocation in one tick — what
    // `hooks.parallel` promises — pins the `tool:` block in call order however the tools then
    // finish. The claim and persist checkpoints stay sequential around it.
    //
    // Only a turn whose every call is a plain `read` qualifies:
    //   - an `action` suspends on an approval signal, which is human time rather than I/O, so
    //     overlapping what follows it buys nothing — and reserving an invocation position for a
    //     call that may yet be REJECTED spends a position the rejected branch never fills.
    //   - an `agent` delegation is `ctx.child`, whose parallel form is the runtime's own `ctx.all`:
    //     one workflow ref over a reserved block, carrying the `parallelGroup` bookkeeping that
    //     makes a fan render as a fan. That is not N independent task closures, so it cannot ride
    //     this hook.
    // The kinds come from the `persist:toolcall` checkpoints, never from a local registry lookup,
    // so every process replaying this turn reaches the same verdict.
    const parallel = hooks.parallel;
    if (
      parallel !== undefined &&
      turn.toolCalls.length > 1 &&
      (await (hooks.patched?.(PARALLEL_TOOLS_PATCH) ?? Promise.resolve(true)))
    ) {
      // Claiming the whole turn first is what makes the kinds knowable before the first execution —
      // and it is also what moves the checkpoints, hence the `patched` gate above.
      const claimed: ClaimedToolCall[] = [];
      for (const call of turn.toolCalls) {
        claimed.push(await claimToolCall(turnCalls, call));
      }
      // A `skill` load qualifies alongside a `read`: it takes its position on the call exactly as a
      // read does, and spends a read's `tool:`/`persist:` names. What disqualifies the other kinds
      // is not that they have effects — it is that an `action` suspends on human time and an `agent`
      // delegation is the runtime's own child-workflow fan.
      if (claimed.every((entry) => entry.toolType === 'read' || entry.toolType === 'skill')) {
        results.push(...(await invokeClaimedToolsTogether(turnCalls, parallel, claimed)));
      } else {
        for (const entry of claimed) {
          results.push(await runClaimedToolCall(turnCalls, entry));
        }
      }
    } else {
      for (const call of turn.toolCalls) {
        results.push(await runClaimedToolCall(turnCalls, await claimToolCall(turnCalls, call)));
      }
    }
    // The outputs land on the assistant message that made the calls. A reader reopening the thread
    // pairs a call with its result off THAT message, so results that only reached the tool-call
    // table leave every tool in the turn rendering as one still running.
    //
    // A position of its own, hence the marker: a run that suspended mid-turn under the shape
    // without it has no room for a checkpoint between the last tool's persist and the next `llm:`.
    // Every value written here comes from a checkpoint above, so a replay writes the same list.
    if (await (hooks.patched?.(MESSAGE_TOOL_RESULTS_PATCH) ?? Promise.resolve(true))) {
      await hooks.step(`persist:toolresults:${i}`, () =>
        deps.store.setMessageToolResults(assistant.id, [...results, ...syntheticResults]),
      );
    }
    modelMessages.push({ role: 'user', content: '', toolResults: results });
  }

  if (thread !== null && (thread.title === '' || thread.title === 'New chat')) {
    await hooks.step('persist:title', () =>
      deps.store.setTitle(input.threadId, deriveTitle(input.userText)),
    );
  }

  // Settle the run `completed` with its rollup. Normal completion only — the loop never records a
  // failure (it doesn't catch its own crash; that's the runner's job). A checkpointed step so a
  // resumed durable replay settles the ONE row exactly once, and `recordRunEnd` is first-terminal so
  // this can never overwrite a `failed`/`cancelled` a concurrent cancel already wrote.
  await hooks.step('persist:run:end', () =>
    deps.store.recordRunEnd({
      runId: hooks.runId,
      status: 'completed',
      finishedAt: Date.now(),
      stepCount: steps,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      ...(hasCost ? { costUsd: totalCost } : {}),
    }),
  );

  await writer.end();
  publishAgentRunFinished({
    runId: hooks.runId,
    threadId: input.threadId,
    steps,
    inputTokens: totalInput,
    outputTokens: totalOutput,
  });
  return { text: lastText, ...(structured !== undefined ? { object: structured } : {}) };
}
