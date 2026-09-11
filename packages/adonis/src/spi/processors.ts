/**
 * The two seams that see a turn's traffic to and from the model: an {@link InputProcessor} rewrites
 * the prompt on its way out, an {@link OutputProcessor} inspects the answer on its way back and may
 * redact, replace or refuse it. Wire them as `AgentLoopDeps.inputProcessors` / `outputProcessors`.
 *
 * WHAT THESE ARE NOT: a second way to decide what enters the context. {@link
 * import('./history-window.js').HistoryWindow} owns SELECTION — which of the thread's messages ride
 * into the turn, and what stands in for the rest. Processors run on whatever selection produced and
 * own TRANSFORMATION — what those messages say. The distinction is load-bearing rather than
 * stylistic: `select` is contractually pure and runs outside any checkpoint, while a processor is
 * allowed to call a model, runs in a checkpoint of its own per step, and rewrites a DERIVED prompt
 * that never becomes the thread's own memory of what was said.
 */

import type { Actor, ModelMessage, ToolCallRequest } from '../types.js';

/** Which turn, and which model step of it, a processor is looking at. */
export interface ProcessorContext {
  threadId: string;
  actor: Actor;
  /** The agent running this turn. Undefined → the default/single agent. */
  agentName?: string;
  /** The persona the request selected, when it selected one. */
  persona?: string;
  /** 0-based model step within the run — the same index the `llm:<step>` checkpoint carries. */
  step: number;
}

/** Everything the model is about to be sent, as the previous processor in the chain left it. */
export interface ProcessedPrompt {
  /** The composed system prompt (agent base + persona + any injected retrieval block). */
  system: string;
  /** The turn's messages, oldest-first, already through the history ceiling. */
  messages: ModelMessage[];
}

/**
 * Rewrites the prompt before each model call of a turn — masking identifiers, stamping a policy
 * preamble, collapsing an oversized tool result. Runs on EVERY step, not once per run, because the
 * transcript grows between steps: a redactor that only saw the opening prompt would wave through
 * whatever a tool result carried back.
 *
 * Runs inside the loop's `process:input:<step>` checkpoint and its result is journaled, so a
 * processor may call a model or hit the network — a resumed run reads back the prompt the suspended
 * attempt built rather than composing a different one.
 */
export interface InputProcessor {
  /** Identifies this processor in a failure. Keep it stable — it is user-visible on an error. */
  readonly name: string;
  process(
    prompt: ProcessedPrompt,
    ctx: ProcessorContext,
  ): ProcessedPrompt | Promise<ProcessedPrompt>;
}

/** One model step's answer, as the previous processor in the chain left it. */
export interface ModelAnswer {
  /** The assembled assistant text for this step. */
  text: string;
  /**
   * The tool calls the same step asked for. Read-only context — a processor cannot change them.
   * A provider reports its calls when `runTurn` RETURNS, so on the incremental path (where the chain
   * rules on a prefix while the call is still streaming) this is empty until the authoritative
   * whole-answer pass, which always sees them.
   */
  toolCalls: readonly ToolCallRequest[];
}

/**
 * What an {@link OutputProcessor} decided. `pass` hands the text to the next processor unchanged;
 * `replace` hands it on rewritten (a redaction is a replacement); `reject` ends the chain AND the
 * run — the text is never streamed, never persisted, and the caller gets an
 * {@link OutputRejectedError} rather than an answer.
 */
export type OutputVerdict =
  | { action: 'pass' }
  | { action: 'replace'; text: string }
  | { action: 'reject'; reason: string };

/**
 * Characters an incremental gate keeps holding at the end of the transformed answer, when a
 * processor declares {@link IncrementalGating} without naming its own window. Wide enough for the
 * patterns a redactor is usually written against — an SSN, an email address, a card number — and
 * deliberately not wider: the window IS the answer's minimum latency tail, since those characters
 * are only released once the whole-answer pass runs.
 */
export const DEFAULT_INCREMENTAL_LOOKBACK_CHARS = 64;

/**
 * A processor's statement that its verdict on a PREFIX of an answer is worth acting on, which is
 * what lets the loop release that prefix to the reader instead of holding the whole answer.
 *
 * Declaring it is a promise about every prefix `P` of the final answer, and the loop takes it at
 * face value on the streaming path:
 *
 * 1. REJECTION IS PREFIX-DECIDABLE. The refusal this processor would return for the whole answer is
 *    already returned for the first prefix that contains the reason. A refusal that only emerges
 *    from the complete answer still fails the run, but by then the reader has seen a prefix — there
 *    is no un-sending frames, and that is the cost of opting in.
 * 2. REPLACEMENT IS PREFIX-STABLE UP TO THE WINDOW. Once a character of `process(P)`'s output is
 *    more than {@link IncrementalGating.lookbackChars} from the end of that output, it never changes
 *    as `P` grows.
 *
 * A broken second promise is caught, not tolerated: the whole-answer pass stays authoritative, and
 * the loop raises a {@link ProcessorFailedError} when its result is not an extension of what the
 * chain already released. So a window too short for a pattern fails loudly rather than streaming the
 * text it was supposed to redact.
 */
export interface IncrementalGating {
  /**
   * How many characters of this processor's own output stay held back. Undefined →
   * {@link DEFAULT_INCREMENTAL_LOOKBACK_CHARS}. Set it to the length of the longest pattern the
   * processor can act on — anything shorter is a run that fails on the pattern it was written for.
   */
  readonly lookbackChars?: number;
}

/**
 * Inspects each model step's answer before anything downstream sees it — before it reaches the live
 * stream, before it is persisted, before it becomes the next step's context.
 *
 * Gating an answer and streaming it as it is generated are mutually exclusive, so registering ANY
 * output processor switches the turn's model call off the run's sink: nothing reaches the subscriber
 * until this chain has ruled on it. How much of that costs the reader is what
 * {@link OutputProcessor.incremental} decides.
 *
 * Runs inside the loop's `process:output:<step>` checkpoint (which also performs the release), so a
 * processor may call a model — a moderation pass is the motivating case — and a replay reads the
 * verdict back instead of re-deciding it.
 */
export interface OutputProcessor {
  /** Identifies this processor in a rejection or a failure. User-visible; keep it stable. */
  readonly name: string;
  /**
   * Opt this processor into gating a PREFIX, so the turn keeps streaming — see
   * {@link IncrementalGating} for what declaring it promises. Undefined means the whole answer,
   * which is what a processor written against the complete text needs and therefore the only safe
   * default; a chain is incremental only when EVERY member of it declares this, so a neighbour can
   * never downgrade what another author was given.
   */
  readonly incremental?: IncrementalGating;
  process(answer: ModelAnswer, ctx: ProcessorContext): OutputVerdict | Promise<OutputVerdict>;
}

/**
 * The run ended because an output processor refused the answer — NOT because the model failed. The
 * two must stay distinguishable: a model failure is worth retrying and worth paging someone about, a
 * refusal is the control doing its job.
 */
export class OutputRejectedError extends Error {
  /** {@link OutputProcessor.name} of the processor that refused. */
  readonly processor: string;
  /** The reason it gave, verbatim. */
  readonly reason: string;

  constructor(processor: string, reason: string) {
    super(`Output rejected by "${processor}": ${reason}`);
    this.name = 'OutputRejectedError';
    this.processor = processor;
    this.reason = reason;
  }
}

/**
 * A processor threw. Wrapped so it can never be mistaken for the model call failing — the loop's
 * only other source of failure at that point in the turn — and so the failure names the processor
 * that produced it instead of surfacing a bare `TypeError` from someone else's code.
 */
export class ProcessorFailedError extends Error {
  /** Which seam it was on, so a reader knows whether the prompt or the answer was in flight. */
  readonly phase: 'input' | 'output';
  /** The processor's `name`. */
  readonly processor: string;

  constructor(phase: 'input' | 'output', processor: string, cause: unknown) {
    super(
      `${phase} processor "${processor}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'ProcessorFailedError';
    this.phase = phase;
    this.processor = processor;
    this.cause = cause;
  }
}
