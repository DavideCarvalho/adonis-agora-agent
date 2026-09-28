/**
 * Guardrails on the agent loop's own seams: an {@link InputProcessor} that scans (and redacts) every
 * prompt — including the tool results riding in it — an {@link OutputProcessor} that scans every
 * answer and the tool calls it asks for, a tool-handler wrapper, and a tool-definition screen.
 *
 * Built only on the processor SPI, so it is a consumer of the loop rather than a part of it: the
 * same rules and detectors run standalone through `scan` for traffic that never meets the loop.
 */

import type {
  InputProcessor,
  ModelAnswer,
  OutputProcessor,
  OutputVerdict,
  ProcessedPrompt,
  ProcessorContext,
} from '../spi/processors.js';
import type { AiToolCtx, ToolHandler } from '../spi/tool.js';
import type { Actor, ModelMessage, ToolResult } from '../types.js';
import { scoreToolText, type ToolDefinitionText, toolText } from './detectors/tool-poisoning.js';
import { type GuardHit, type ScanOptions, type ScanResult, scan } from './engine.js';
import { jsonSlots, type Slot } from './segments.js';
import type {
  Finding,
  GuardContext,
  GuardrailAction,
  GuardrailRule,
  GuardrailStage,
  PiiType,
  SecretType,
  Segment,
  SegmentSource,
} from './types.js';
import { Vault } from './vault.js';

/** What a rule's `when` and a custom detector see when the guardrails run inside the loop. */
export interface AgentGuardContext extends GuardContext {
  /** Undefined only for a tool definition screened outside any turn. */
  threadId?: string;
  actor?: Actor;
  agentName?: string;
  /** Model step within the run; undefined outside a processor. */
  step?: number;
  /** The tool server a screened definition came from (e.g. the MCP server's name). */
  server?: string;
}

type Stages = readonly GuardrailStage[];

export interface PiiShorthand {
  action: GuardrailAction;
  types?: readonly PiiType[];
  /**
   * Put the original values back into the answer and into tool arguments (the model only sees
   * placeholders). Covers values from the prompt and from tool results. Default true.
   */
  restore?: boolean;
  stages?: Stages;
}

export interface SecretsShorthand {
  action: GuardrailAction;
  types?: readonly SecretType[];
  stages?: Stages;
}

export interface InjectionShorthand {
  /** Default `block`. */
  action?: GuardrailAction;
  /** Noisy-OR score (0-1) at which the heuristics fire. Default 0.5. */
  threshold?: number;
  stages?: Stages;
}

export interface ToolPoisoningShorthand {
  /** `block` (default) refuses the tool in {@link Guardrails.screenTool}; `log` only reports it. */
  action?: 'block' | 'log';
  threshold?: number;
}

/** One decision worth auditing. Never carries the matched values themselves. */
export interface GuardrailEvent {
  stage: GuardrailStage;
  /** The effective action (`approve` is reported as it was configured, and enforced as a block). */
  action: GuardrailAction;
  decisive?: { id: string; name: string; message: string };
  /** Hits in the newest content only — history re-sent every step is not reported again. */
  hits: GuardrailEventHit[];
  redactions: number;
  latencyMs: number;
  context: AgentGuardContext;
}

export type GuardrailEventHit = Omit<GuardHit, 'values'> & {
  /** {@link GuardrailsOptions.fingerprint} of each distinct value; empty without one. */
  fingerprints: string[];
};

/** Where a thread's reversible placeholders live between the prompt and the answer. */
export interface VaultStore {
  load(threadId: string): Vault | undefined | Promise<Vault | undefined>;
  save(threadId: string, vault: Vault): void | Promise<void>;
}

/**
 * The default {@link VaultStore}: this process's memory, bounded to the most recent threads. A run
 * resumed in ANOTHER process finds no vault, so its placeholders reach the reader unrestored — the
 * values still never reach the model. Supply a shared store (with {@link Vault.toJSON}) to restore
 * across processes; it then holds the raw values.
 */
export class InMemoryVaultStore implements VaultStore {
  private readonly vaults = new Map<string, Vault>();

  constructor(private readonly maxThreads = 1_000) {}

  load(threadId: string): Vault | undefined {
    const vault = this.vaults.get(threadId);
    if (vault !== undefined) {
      // Re-inserted so the map's order is recency.
      this.vaults.delete(threadId);
      this.vaults.set(threadId, vault);
    }
    return vault;
  }

  save(threadId: string, vault: Vault): void {
    this.vaults.delete(threadId);
    this.vaults.set(threadId, vault);
    while (this.vaults.size > this.maxThreads) {
      const oldest = this.vaults.keys().next().value;
      if (oldest === undefined) break;
      this.vaults.delete(oldest);
    }
  }
}

export type GuardrailRulesSource =
  | readonly GuardrailRule<AgentGuardContext>[]
  | ((
      ctx: AgentGuardContext,
    ) =>
      | readonly GuardrailRule<AgentGuardContext>[]
      | Promise<readonly GuardrailRule<AgentGuardContext>[]>);

export interface GuardrailsOptions {
  /** PII (email, phone, CPF/CNPJ, SSN, cards with Luhn, IBAN, IPv4). */
  pii?: GuardrailAction | PiiShorthand;
  /** API keys, tokens and private keys. */
  secrets?: GuardrailAction | SecretsShorthand;
  /** Prompt-injection / jailbreak heuristics. */
  injection?: GuardrailAction | InjectionShorthand;
  /** Screen tool definitions for hidden instructions — see {@link Guardrails.screenTool}. */
  toolPoisoning?: boolean | ToolPoisoningShorthand;
  /**
   * More rules, evaluated alongside the shorthands. A function is called per scan with the turn's
   * context, which is the seam for per-tenant policy: look the tenant's rules up by `ctx.actor`.
   */
  rules?: GuardrailRulesSource;
  /** Audit hook. Awaited; a throw is swallowed so an audit sink can never change a decision. */
  onEvent?: (event: GuardrailEvent) => void | Promise<void>;
  /** Keyed hash (or any stable digest) of a matched value, reported on events instead of it. */
  fingerprint?: (value: string) => string;
  /** Per-stage refusal messages for rules that set none. */
  messages?: ScanOptions['messages'];
  /** Where reversible placeholders live between prompt and answer. Default {@link InMemoryVaultStore}. */
  vaults?: VaultStore;
  /**
   * Keep the turn streaming: the output processor declares `incremental` with this lookback, so
   * the loop releases a prefix while holding the last `lookbackChars` characters. `false` gates the
   * whole answer instead. Default `{ lookbackChars: 256 }` — wide enough for every built-in
   * pattern and placeholder; widen it for custom patterns that match longer text.
   */
  incremental?: false | { lookbackChars?: number };
  /** Processor name (user-visible on a refusal). Default `guardrails`. */
  name?: string;
}

/** A guardrail refused content the loop cannot rewrite around: a prompt, or a tool call. */
export class GuardrailBlockedError extends Error {
  constructor(
    readonly stage: GuardrailStage,
    /** The message for the person — the rule's own, or the stage default. */
    readonly userMessage: string,
    readonly rule?: { id: string; name: string },
  ) {
    super(userMessage);
    this.name = 'GuardrailBlockedError';
  }
}

const ALL_CONTENT: Stages = ['llm_request', 'tool_args', 'tool_result', 'llm_response'];
/**
 * PII is redacted where it would reach the MODEL (and in what the model writes), not in the
 * arguments of a tool: those are restored for the tool on purpose — see {@link Guardrails.wrapTool}.
 */
const RESTORABLE_STAGES: Stages = ['llm_request', 'tool_result'];

const PII_STAGES: Stages = ['llm_request', 'tool_result', 'llm_response'];

/** The rules the shorthand options stand for. Exported so a caller can inspect or extend them. */
export function shorthandRules(options: GuardrailsOptions): GuardrailRule<AgentGuardContext>[] {
  const rules: GuardrailRule<AgentGuardContext>[] = [];
  if (options.pii !== undefined) {
    const pii: PiiShorthand =
      typeof options.pii === 'string' ? { action: options.pii } : options.pii;
    rules.push({
      id: 'pii',
      name: 'PII',
      stages: pii.stages ?? PII_STAGES,
      detectors: [{ kind: 'pii', ...(pii.types !== undefined ? { types: pii.types } : {}) }],
      action: pii.action,
      options: { restore: pii.restore ?? true },
    });
  }
  if (options.secrets !== undefined) {
    const secrets: SecretsShorthand =
      typeof options.secrets === 'string' ? { action: options.secrets } : options.secrets;
    rules.push({
      id: 'secrets',
      name: 'Secrets',
      stages: secrets.stages ?? ALL_CONTENT,
      detectors: [
        { kind: 'secrets', ...(secrets.types !== undefined ? { types: secrets.types } : {}) },
      ],
      action: secrets.action,
      // A secret sent to a model is not handed back: the reader should not see it echoed either.
      options: { restore: false },
    });
  }
  if (options.injection !== undefined) {
    const injection: InjectionShorthand =
      typeof options.injection === 'string' ? { action: options.injection } : options.injection;
    rules.push({
      id: 'injection',
      name: 'Prompt injection',
      // The prompt (a jailbreak typed by the user) and tool results (indirect injection).
      stages: injection.stages ?? ['llm_request', 'tool_result'],
      detectors: [
        {
          kind: 'injection',
          ...(injection.threshold !== undefined ? { threshold: injection.threshold } : {}),
        },
      ],
      action: injection.action ?? 'block',
      // What the user typed and what tools returned. Not the system prompt — the app's own text,
      // which legitimately carries role tags and imperatives — nor the model's earlier answers.
      match: { sources: ['user', 'tool'] },
    });
  }
  if (options.toolPoisoning !== undefined && options.toolPoisoning !== false) {
    const poisoning: ToolPoisoningShorthand =
      options.toolPoisoning === true ? {} : options.toolPoisoning;
    rules.push({
      id: 'tool_poisoning',
      name: 'Tool poisoning',
      stages: ['tool_description'],
      detectors: [
        {
          kind: 'tool_poisoning',
          ...(poisoning.threshold !== undefined ? { threshold: poisoning.threshold } : {}),
        },
      ],
      action: poisoning.action ?? 'block',
    });
  }
  return rules;
}

const isRefusal = (action: GuardrailAction) => action === 'block' || action === 'approve';

function sourceOf(role: ModelMessage['role']): SegmentSource {
  return role === 'system' ? 'system' : role === 'assistant' ? 'assistant' : 'user';
}

/**
 * Index of the newest user message: it and everything after it are this turn. One with no text is
 * skipped — a loop may carry tool results back on an empty `user` message, which is not a new turn.
 */
function turnStart(messages: readonly ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'user' && message.content) return i;
  }
  return 0;
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : (structuredClone(value) as T);
}

/** Scans segments, and writes the (redacted) texts back through their slots. */
function writeBack(slots: readonly Slot[], result: ScanResult): void {
  if (!result.changed) return;
  slots.forEach((slot, i) => {
    const text = result.segments[i];
    if (text !== undefined && text !== slot.segment.text) slot.set(text);
  });
}

/**
 * Guardrails for the agent loop. Register the two processors, optionally wrap tool handlers, and
 * hand {@link screenTool} to whatever imports remote tool definitions:
 *
 * ```ts
 * const guardrails = createGuardrails({ pii: 'redact', secrets: 'block', injection: { threshold: 0.6 }, toolPoisoning: true });
 * // config/agent.ts
 * defineConfig({ inputProcessors: [guardrails.input], outputProcessors: [guardrails.output], … });
 * ```
 */
export class Guardrails {
  /** Scans every prompt; redacts in place, withholds tool results, throws on a blocked prompt. */
  readonly input: InputProcessor;
  /** Scans every answer and the tool calls it asks for; redacts, restores placeholders, or rejects. */
  readonly output: OutputProcessor;

  private readonly shorthand: GuardrailRule<AgentGuardContext>[];
  private readonly vaults: VaultStore;
  /** Per thread: hits already reported this turn, so re-scans of the same content stay quiet. */
  private readonly reported = new Map<string, Set<string>>();

  constructor(private readonly options: GuardrailsOptions = {}) {
    this.shorthand = shorthandRules(options);
    this.vaults = options.vaults ?? new InMemoryVaultStore();
    const name = options.name ?? 'guardrails';
    this.input = { name, process: (prompt, ctx) => this.processInput(prompt, ctx) };
    const incremental =
      options.incremental === false
        ? undefined
        : { lookbackChars: options.incremental?.lookbackChars ?? 256 };
    this.output = {
      name,
      ...(incremental !== undefined ? { incremental } : {}),
      process: (answer, ctx) => this.processOutput(answer, ctx),
    };
  }

  /** Every rule in force for `ctx`: the shorthands, then {@link GuardrailsOptions.rules}. */
  async rulesFor(ctx: AgentGuardContext): Promise<GuardrailRule<AgentGuardContext>[]> {
    const extra = this.options.rules;
    const resolved = typeof extra === 'function' ? await extra(ctx) : (extra ?? []);
    return [...this.shorthand, ...resolved];
  }

  /**
   * Scans arbitrary segments at one stage with the configured rules, reporting through `onEvent`.
   * What the processors use; also the entry point for traffic that never meets the loop.
   */
  async scan(
    ctx: AgentGuardContext,
    segments: readonly Segment[],
    vault: Vault = new Vault(),
  ): Promise<ScanResult> {
    const rules = await this.rulesFor(ctx);
    const result = await scan(rules, ctx, segments, vault, {
      ...(this.options.messages !== undefined ? { messages: this.options.messages } : {}),
      // A tool result is the app's own data: a value redacted out of it is handed back to the
      // reader and to the next tool call like one the user typed. `restore: false` opts a rule out.
      restorableStages: RESTORABLE_STAGES,
    });
    await this.report(ctx, result);
    return result;
  }

  /**
   * Screens one tool definition (name, title, description, and every description in its input
   * schema) for hidden instructions. `allowed: false` means a `block`/`approve` rule fired — leave
   * the tool out of the catalog. Shaped to be handed straight to an MCP importer's screen hook.
   */
  async screenTool(
    tool: ToolDefinitionText & { server?: string },
  ): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    const ctx: AgentGuardContext = {
      stage: 'tool_description',
      tool: tool.name,
      ...(tool.server !== undefined ? { server: tool.server } : {}),
    };
    const result = await this.scan(ctx, [{ text: toolText(tool) }]);
    if (isRefusal(result.action)) {
      const categories = [...new Set(result.hits.map((h) => h.category))].join(', ');
      return {
        allowed: false,
        reason: `${result.decisive?.message ?? 'quarantined by guardrails'} (${categories})`,
      };
    }
    return { allowed: true };
  }

  /**
   * Wraps a tool handler so its arguments are guarded where the loop cannot rewrite them: the
   * thread's placeholders are restored (the model only ever saw `[EMAIL_1]`, the tool needs the
   * address), then the `tool_args` rules run — `redact` rewrites what the tool receives, `block`
   * throws a {@link GuardrailBlockedError}, which the model reads as the tool's failure.
   */
  wrapTool<I, O>(toolName: string, handler: ToolHandler<I, O>): ToolHandler<I, O> {
    return {
      execute: async (input: I, ctx: AiToolCtx) => {
        const vault = (await this.vaults.load(ctx.threadId)) ?? new Vault();
        const box = { value: cloneJson(input) as unknown };
        const slots = jsonSlots(box.value, 'assistant', true, (text) => {
          box.value = text;
        });
        for (const slot of slots) slot.set(vault.restore(slot.segment.text));
        const guardCtx: AgentGuardContext = {
          stage: 'tool_args',
          tool: toolName,
          threadId: ctx.threadId,
          actor: ctx.actor,
        };
        const restoredSlots = jsonSlots(box.value, 'assistant', true, (text) => {
          box.value = text;
        });
        const result = await this.scan(
          guardCtx,
          restoredSlots.map((s) => s.segment),
          vault,
        );
        if (isRefusal(result.action)) {
          throw new GuardrailBlockedError(
            'tool_args',
            result.decisive?.message ?? 'blocked',
            result.decisive,
          );
        }
        writeBack(restoredSlots, result);
        return handler.execute(box.value as I, ctx);
      },
    };
  }

  private contextOf(
    stage: GuardrailStage,
    ctx: ProcessorContext,
    tool?: string,
  ): AgentGuardContext {
    return {
      stage,
      threadId: ctx.threadId,
      actor: ctx.actor,
      step: ctx.step,
      ...(ctx.agentName !== undefined ? { agentName: ctx.agentName } : {}),
      ...(tool !== undefined ? { tool } : {}),
    };
  }

  private async processInput(
    prompt: ProcessedPrompt,
    pctx: ProcessorContext,
  ): Promise<ProcessedPrompt> {
    if (pctx.step === 0) {
      // A new turn: whatever it contains is new, even if an earlier turn reported the same value.
      this.reported.delete(pctx.threadId);
    }
    const vault = (await this.vaults.load(pctx.threadId)) ?? new Vault();
    const out: ProcessedPrompt = { system: prompt.system, messages: cloneJson(prompt.messages) };
    const from = turnStart(out.messages);

    // The prompt proper: system, every message's text, and the arguments of earlier tool calls.
    const slots: Slot[] = [];
    if (out.system) {
      slots.push({
        segment: { text: out.system, source: 'system', fresh: true },
        set: (text) => {
          out.system = text;
        },
      });
    }
    out.messages.forEach((message, i) => {
      const fresh = i >= from;
      if (message.content) {
        slots.push({
          segment: { text: message.content, source: sourceOf(message.role), fresh },
          set: (text) => {
            message.content = text;
          },
        });
      }
      for (const call of message.toolCalls ?? []) {
        slots.push(
          ...jsonSlots(call.input, 'assistant', fresh, (text) => {
            call.input = text;
          }),
        );
      }
    });
    const request = await this.scan(
      this.contextOf('llm_request', pctx),
      slots.map((s) => s.segment),
      vault,
    );
    if (isRefusal(request.action)) {
      await this.vaults.save(pctx.threadId, vault);
      throw new GuardrailBlockedError(
        'llm_request',
        request.decisive?.message ?? 'blocked',
        request.decisive,
      );
    }
    writeBack(slots, request);

    // Tool results, one at a time so `match.tools` can tell them apart.
    for (const [i, message] of out.messages.entries()) {
      for (const result of message.toolResults ?? []) {
        await this.guardToolResult(result, i >= from, pctx, vault);
      }
    }
    await this.vaults.save(pctx.threadId, vault);
    return out;
  }

  private async guardToolResult(
    result: ToolResult,
    fresh: boolean,
    pctx: ProcessorContext,
    vault: Vault,
  ): Promise<void> {
    const slots = jsonSlots(result.output, 'tool', fresh, (text) => {
      result.output = text;
    });
    if (result.error) {
      slots.push({
        segment: { text: result.error, source: 'tool', fresh },
        set: (text) => {
          result.error = text;
        },
      });
    }
    if (slots.length === 0) return;
    const scanned = await this.scan(
      this.contextOf('tool_result', pctx, result.name),
      slots.map((s) => s.segment),
      vault,
    );
    if (isRefusal(scanned.action)) {
      // Withheld rather than failing the turn: the model is told why and can go on without it.
      result.output = scanned.decisive?.message ?? 'withheld';
      if (result.error !== undefined) result.error = result.output as string;
      return;
    }
    writeBack(slots, scanned);
  }

  private async processOutput(answer: ModelAnswer, pctx: ProcessorContext): Promise<OutputVerdict> {
    // Tool calls first: the loop cannot rewrite them, so all it can do is refuse the step.
    for (const call of answer.toolCalls) {
      const slots = jsonSlots(cloneJson(call.input), 'assistant', true);
      if (slots.length === 0) continue;
      const args = await this.scan(
        this.contextOf('tool_args', pctx, call.name),
        slots.map((s) => s.segment),
      );
      if (isRefusal(args.action)) {
        return { action: 'reject', reason: args.decisive?.message ?? 'blocked' };
      }
    }
    if (!answer.text) return { action: 'pass' };
    // A fresh vault per pass: one-way placeholders are then numbered by first appearance in THIS
    // text, so a prefix and its extension agree — what an incremental gate needs.
    const response = await this.scan(
      this.contextOf('llm_response', pctx),
      [{ text: answer.text, source: 'assistant' }],
      new Vault(),
    );
    if (isRefusal(response.action)) {
      return { action: 'reject', reason: response.decisive?.message ?? 'blocked' };
    }
    const vault = await this.vaults.load(pctx.threadId);
    const redacted = response.segments[0] ?? answer.text;
    const text = vault !== undefined ? vault.restore(redacted) : redacted;
    return text === answer.text ? { action: 'pass' } : { action: 'replace', text };
  }

  private async report(ctx: AgentGuardContext, result: ScanResult): Promise<void> {
    const onEvent = this.options.onEvent;
    if (onEvent === undefined || result.hits.length === 0) return;
    const seen =
      ctx.threadId !== undefined
        ? (this.reported.get(ctx.threadId) ??
          this.reported.set(ctx.threadId, new Set()).get(ctx.threadId))
        : undefined;
    const fingerprint = this.options.fingerprint;
    const hits: GuardrailEventHit[] = [];
    for (const { values, ...hit } of result.hits) {
      if (!hit.fresh) continue;
      // Scans repeat within a turn (every step re-sends the prompt; an incremental gate re-reads
      // the growing answer), so a hit is reported once per turn per stage, rule, category and value.
      const key = `${ctx.stage}\u0000${ctx.tool ?? ''}\u0000${hit.ruleId}\u0000${hit.category}\u0000${values.join('\u0001')}`;
      if (seen?.has(key)) continue;
      seen?.add(key);
      hits.push({ ...hit, fingerprints: fingerprint !== undefined ? values.map(fingerprint) : [] });
    }
    if (hits.length === 0) return;
    if (this.reported.size > 1_000) {
      const oldest = this.reported.keys().next().value;
      if (oldest !== undefined) this.reported.delete(oldest);
    }
    try {
      await onEvent({
        stage: result.stage,
        action: result.action,
        ...(result.decisive !== undefined ? { decisive: result.decisive } : {}),
        hits,
        redactions: result.redactions,
        latencyMs: result.latencyMs,
        context: ctx,
      });
    } catch {
      // An audit sink must never change a decision.
    }
  }
}

/** Shorthand for `new Guardrails(options)`. */
export function createGuardrails(options: GuardrailsOptions = {}): Guardrails {
  return new Guardrails(options);
}

/**
 * The tool-poisoning screen alone — no rules, no events. `score` is the noisy-OR of the signals
 * that fired; `findings` is empty below `threshold` (default 0.5).
 */
export function screenToolDefinition(
  tool: ToolDefinitionText,
  threshold = 0.5,
): { score: number; findings: Finding[] } {
  return scoreToolText(toolText(tool), threshold);
}
