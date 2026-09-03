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
import type { AgentStore } from './spi/agent-store.js';
import type { ModelProvider } from './spi/model-provider.js';
import {
  type AgentPricingStore,
  type CurrentModelPrice,
  estimateCost,
  resolveModelPrice,
} from './spi/pricing-store.js';
import type { QuotaStore } from './spi/quota-store.js';
import type { Passage, RetrievalResult, RetrieveOptions, Retriever } from './spi/retriever.js';
import type { RolesPolicy } from './spi/roles-policy.js';
import type { SinkWriter } from './spi/token-stream-sink.js';
import type { AiToolCtx } from './spi/tool.js';
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
  ToolResult,
} from './types.js';

export interface AgentLoopDeps {
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

/**
 * The provider-agnostic agent turn, reused by both the inline and durable runners.
 * It drives the model→tools→model iteration; the runner supplies the `step`/`awaitApproval`
 * hooks that make the same loop body either in-process or a replay-safe durable workflow.
 */
export async function runAgentLoop(
  deps: AgentLoopDeps,
  input: AgentRunInput,
  hooks: AgentLoopHooks,
): Promise<{ text: string }> {
  const maxSteps = deps.maxSteps ?? 8;
  const persona = input.persona;
  let system = await resolveSystemPrompt(deps, input);

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
  const modelMessages: ModelMessage[] = (thread?.messages ?? []).map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolResults !== undefined ? { toolResults: message.toolResults } : {}),
    ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
  }));

  const writer = await hooks.openSink();
  let lastText = '';
  let steps = 0;
  let totalInput = 0;
  let totalOutput = 0;
  // Run-level cost rollup: sum only the steps whose cost we actually know (provider-reported or
  // priced). If NO step had a cost, the run's `cost_usd` stays `null` — never a fabricated `0`.
  let totalCost = 0;
  let hasCost = false;

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

  // Fetched ONCE per run (not per step) and reused for every step's cost estimate below. Returned as
  // a plain array (not the Map built from it) so a durable runner can JSON-cache the step's result.
  let prices: CurrentModelPrice[] = [];
  if (deps.pricingStore !== undefined) {
    const pricingStore = deps.pricingStore;
    prices = await hooks.step('pricing:list', () => pricingStore.listCurrentPrices());
  }
  const priceByModel = new Map(prices.map((price) => [price.modelId, price]));

  // NOTE: no try/finally around this loop. A durable runner suspends by THROWING through the stack
  // at `awaitApproval` (ctx.waitForSignal); a finally would then call writer.end() on every suspend
  // and prematurely close the live stream. We only end on normal completion — the throw propagates
  // to the engine, and the resumed replay reaches the writer.end() below.
  for (let i = 0; i < maxSteps; i += 1) {
    const tools = await deps.registry.definitionsFor(
      input.actor,
      deps.rolesPolicy,
      intersectAllow(persona?.allowedTools, deps.toolAllowList),
    );

    // Span the model call INSIDE the step body (replay-safe). The turn's raw text/output never rides
    // the span — only token counts + name/length metadata (the point events' redaction posture).
    const turn = await hooks.step(`llm:${i}`, () =>
      spannedAgent(
        'llm.turn',
        hooks.runId,
        { runId: hooks.runId, step: i },
        () => deps.model.runTurn({ system, messages: modelMessages, tools, sink: writer }),
        (result) => ({
          ...(result.modelId !== undefined ? { modelId: result.modelId } : {}),
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          textLength: result.text.length,
          toolCalls: result.toolCalls.length,
        }),
      ),
    );

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

    steps += 1;
    totalInput += turn.usage.inputTokens;
    totalOutput += turn.usage.outputTokens;
    lastText = turn.text;
    publishAgentMessage({
      runId: hooks.runId,
      threadId: input.threadId,
      role: 'assistant',
      textLength: turn.text.length,
    });
    const assistant = await hooks.step(`persist:assistant:${i}`, () =>
      deps.store.appendMessage({
        threadId: input.threadId,
        role: 'assistant',
        content: turn.text,
        runId: hooks.runId,
        usage: { ...turn.usage, costUsd },
        ...(persona !== undefined ? { persona: persona.id } : {}),
        ...(turn.toolCalls.length > 0 ? { toolCalls: turn.toolCalls } : {}),
      }),
    );
    modelMessages.push({
      role: 'assistant',
      content: turn.text,
      ...(turn.toolCalls.length > 0 ? { toolCalls: turn.toolCalls } : {}),
    });

    // Record inject-mode retrieval as a synthetic auto-executed `retrieve` tool call on the assistant
    // message it informed — so its passages persist and render as citations exactly like an agentic
    // search would, without a new message field. One durable step keeps replay from re-writing it.
    if (i === 0 && injectedPassages !== undefined) {
      const passages = injectedPassages;
      const toolCallId = `retrieve-${assistant.id}`;
      await hooks.step(`persist:retrieval:${assistant.id}`, async () => {
        await deps.store.recordToolCall({
          toolCallId,
          messageId: assistant.id,
          toolName: 'retrieve',
          toolType: 'read',
          input: { query: input.userText },
          status: 'auto_executed',
          runId: hooks.runId,
        });
        await deps.store.updateToolCall({ toolCallId, status: 'executed', output: { passages } });
      });
    }

    if (turn.toolCalls.length === 0) {
      break;
    }

    const results: ToolResult[] = [];
    for (const call of turn.toolCalls) {
      const spec = deps.registry.spec(call.name);
      const toolType = spec?.kind ?? 'read';
      const ctx: AiToolCtx = {
        actor: input.actor,
        threadId: input.threadId,
        runId: hooks.runId,
        requestId: hooks.runId,
        emitComponent: (name: string, data: unknown) =>
          writer.write({ t: 'component', name, data }),
        ...(persona !== undefined ? { persona } : {}),
        ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
        ...(deps.host !== undefined ? { host: deps.host } : {}),
      };

      // Delegation: an `agent`-kind tool runs another agent. Handled at the LOOP level (not in a
      // step) because the durable runner maps it to `ctx.child`, a ctx-level suspend point.
      //
      // This bypasses `ToolRegistry.invoke`, so it must apply the same two gates `invoke` applies
      // itself — the role/ability re-check AND the offered-tools (persona/agent allow-list) filter
      // — BEFORE any persistence or event publication. A synthesized delegate spec
      // (`registerDelegateTools` in agent-deps-factory.ts) carries whatever `roles`/`ability` its
      // `delegatesTo` edge declared, and nothing when the edge is a bare string — under
      // `DefaultRolesPolicy` that is ADMIN-only, under an authz posture a tool with no `ability` is
      // always denied — so an unauthorized delegate call must fail closed here exactly like
      // `ToolRegistry.invoke` fails closed for every other tool kind.
      if (toolType === 'agent') {
        const targetAgent = spec?.targetAgent ?? call.name;
        let task: string;

        try {
          if (spec === undefined) {
            // Never actually reachable today (an unresolved name defaults `toolType` to 'read'
            // above), but an `agent`-kind call with no resolvable spec must fail closed rather than
            // fall through — and this narrows `spec` to `ToolSpec` for the `rolesPolicy.can` call
            // below.
            throw new ToolForbiddenError(call.name);
          }
          const offeredAllow = intersectAllow(persona?.allowedTools, deps.toolAllowList);
          if (offeredAllow !== undefined && !offeredAllow.includes(call.name)) {
            // A tool the model was not offered must not run, even if the model names it anyway.
            throw new ToolForbiddenError(call.name);
          }
          if (!(await deps.rolesPolicy.can(input.actor, spec))) {
            throw new ToolForbiddenError(call.name);
          }
          // The third gate `ToolRegistry.invoke` applies, in the same order: authorization first,
          // then shape. Delegation bypasses `invoke` (it is a ctx-level suspend point), so the gate
          // has to be re-applied here or a malformed input is silently coerced instead of rejected.
          const validation = await spec.inputSchema['~standard'].validate(call.input);
          if (validation.issues !== undefined) {
            throw new ToolInputInvalidError(call.name, validation.issues);
          }
          task = extractTask(validation.value);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // A denied delegation is recorded `failed` directly — never `auto_executed` even
          // transiently — and never emits `agent.delegated`.
          await hooks.step(`persist:toolcall:${call.id}`, () =>
            deps.store.recordToolCall({
              toolCallId: call.id,
              messageId: assistant.id,
              toolName: call.name,
              toolType: 'read',
              input: call.input,
              status: 'failed',
              runId: hooks.runId,
            }),
          );
          results.push({ id: call.id, name: call.name, output: null, error: message });
          continue;
        }

        await hooks.step(`persist:toolcall:${call.id}`, () =>
          deps.store.recordToolCall({
            toolCallId: call.id,
            messageId: assistant.id,
            toolName: call.name,
            toolType: 'read',
            input: call.input,
            status: 'auto_executed',
            runId: hooks.runId,
          }),
        );
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
        results.push({ id: call.id, name: call.name, output: sub });
        continue;
      }

      if (toolType === 'action') {
        await hooks.step(`persist:toolcall:${call.id}`, () =>
          deps.store.recordToolCall({
            toolCallId: call.id,
            messageId: assistant.id,
            toolName: call.name,
            toolType: 'action',
            input: call.input,
            status: 'pending_approval',
            runId: hooks.runId,
          }),
        );
        const decision = await hooks.awaitApproval(call, ctx);
        if (!decision.approved) {
          await hooks.step(`persist:toolreject:${call.id}`, () =>
            deps.store.updateToolCall({
              toolCallId: call.id,
              status: 'rejected',
              ...(decision.reason !== undefined ? { error: decision.reason } : {}),
            }),
          );
          results.push({
            id: call.id,
            name: call.name,
            output: { rejected: true, reason: decision.reason ?? 'rejected by user' },
            error: 'rejected',
          });
          publishAgentToolCall({
            runId: hooks.runId,
            toolName: call.name,
            toolType,
            status: 'rejected',
          });
          continue;
        }
      } else {
        await hooks.step(`persist:toolcall:${call.id}`, () =>
          deps.store.recordToolCall({
            toolCallId: call.id,
            messageId: assistant.id,
            toolName: call.name,
            toolType: 'read',
            input: call.input,
            status: 'auto_executed',
            runId: hooks.runId,
          }),
        );
      }

      try {
        // The retry loop runs INSIDE the `tool:<call.id>` step so it stays replay-safe: a durable
        // step memoizes only its successful result, so on replay the whole step returns cached and
        // the retries never re-run (side effects happen exactly once). A classified-transient error
        // (DB deadlock / lock-wait timeout / serialization failure) is retried in place; any other
        // failure surfaces immediately as before. `false` disables retry entirely.
        // Span the tool execution INSIDE the step body (replay-safe). The transient-retry loop runs
        // within the span, so the span covers all in-place attempts; the tool's output never rides it.
        const output = await hooks.step(`tool:${call.id}`, () =>
          spannedAgent(
            'tool.execution',
            hooks.runId,
            { runId: hooks.runId, toolCallId: call.id, toolName: call.name, toolType },
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
                      message:
                        retryError instanceof Error ? retryError.message : String(retryError),
                    });
                  },
                },
              ),
            () => ({}),
          ),
        );
        await hooks.step(`persist:toolexec:${call.id}`, () =>
          deps.store.updateToolCall({
            toolCallId: call.id,
            status: 'executed',
            output,
            ...(toolType === 'action' ? { executedByRef: input.actor.id } : {}),
          }),
        );
        results.push({ id: call.id, name: call.name, output });
        publishAgentToolCall({
          runId: hooks.runId,
          toolName: call.name,
          toolType,
          status: 'executed',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await hooks.step(`persist:toolfail:${call.id}`, () =>
          deps.store.updateToolCall({ toolCallId: call.id, status: 'failed', error: message }),
        );
        results.push({ id: call.id, name: call.name, output: null, error: message });
        publishAgentToolCall({
          runId: hooks.runId,
          toolName: call.name,
          toolType,
          status: 'failed',
        });
      }
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
  return { text: lastText };
}
