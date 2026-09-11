/**
 * Running the processor chains, and the stream buffering an output gate requires. See
 * `./spi/processors.ts` for the seams themselves and the boundary against `HistoryWindow`.
 */

import {
  DEFAULT_INCREMENTAL_LOOKBACK_CHARS,
  type InputProcessor,
  type ModelAnswer,
  type OutputProcessor,
  type OutputVerdict,
  type ProcessedPrompt,
  type ProcessorContext,
  ProcessorFailedError,
} from './spi/processors.js';
import type { SinkWriter, StreamFrame } from './spi/token-stream-sink.js';

/**
 * Holds a model call's stream frames instead of letting them reach the subscriber. `end` is
 * swallowed because the loop owns the run's stream lifecycle across however many steps the turn
 * takes, and the model call is one step of it.
 *
 * A {@link StreamFrame} is a plain typed object, so the buffer rides a durable checkpoint as-is —
 * which it has to, since the gate must survive a suspend between the model call and the verdict.
 */
export interface FrameBuffer {
  writer: SinkWriter;
  /** Everything written so far, in write order. */
  frames(): StreamFrame[];
}

export function createFrameBuffer(): FrameBuffer {
  const frames: StreamFrame[] = [];
  return {
    writer: {
      write: (frame) => {
        frames.push(frame);
      },
      end: () => {},
    },
    frames: () => frames,
  };
}

/**
 * The frames a passed gate releases to the live stream: the held ones, with every text frame
 * collapsed into ONE carrying `text` — the answer as the chain left it, which is the only version
 * anything downstream is allowed to see. The substitution happens in place, so the answer keeps its
 * position relative to any non-text frame the provider interleaved with it.
 */
export function releaseGatedFrames(args: {
  frames: readonly StreamFrame[];
  text: string;
}): StreamFrame[] {
  const { frames, text } = args;
  const released: StreamFrame[] = [];
  let emitted = false;
  for (const frame of frames) {
    if (frame.t === 'text') {
      if (!emitted && text.length > 0) {
        released.push({ t: 'text', v: text });
        emitted = true;
      }
      continue;
    }
    released.push(frame);
  }
  if (!emitted && text.length > 0) {
    released.push({ t: 'text', v: text });
  }
  return released;
}

/**
 * Fold the prompt through each processor in order, every one seeing what the previous one produced.
 * A throw is wrapped so it cannot read as the model call failing — see {@link ProcessorFailedError}.
 */
export async function runInputProcessors(args: {
  processors: readonly InputProcessor[];
  prompt: ProcessedPrompt;
  ctx: ProcessorContext;
}): Promise<ProcessedPrompt> {
  let current = args.prompt;
  for (const processor of args.processors) {
    try {
      current = await processor.process(current, args.ctx);
    } catch (error) {
      throw new ProcessorFailedError('input', processor.name, error);
    }
  }
  return current;
}

/** Who refused an answer, and why. Carried out of a checkpoint, so it stays JSON-round-trippable. */
export interface GateRejection {
  processor: string;
  reason: string;
}

/** A settled output chain: the answer as the chain left it, plus who refused it if anyone did. */
export interface OutputGateResult {
  /** The text every downstream consumer sees — the stream, the persisted message, the next step. */
  text: string;
  /** Set only on a refusal; the run ends with an `OutputRejectedError` naming these. */
  rejection?: GateRejection;
}

/**
 * Fold the answer through each processor in order. The FIRST rejection ends the chain: a later
 * processor has nothing to add about text that is never going anywhere, and running it would bill a
 * moderation call for a turn already refused.
 */
export async function runOutputProcessors(args: {
  processors: readonly OutputProcessor[];
  answer: ModelAnswer;
  ctx: ProcessorContext;
}): Promise<OutputGateResult> {
  const { processors, answer, ctx } = args;
  let text = answer.text;
  for (const processor of processors) {
    let verdict: OutputVerdict;
    try {
      verdict = await processor.process({ text, toolCalls: answer.toolCalls }, ctx);
    } catch (error) {
      throw new ProcessorFailedError('output', processor.name, error);
    }
    if (verdict.action === 'reject') {
      return { text, rejection: { processor: processor.name, reason: verdict.reason } };
    }
    if (verdict.action === 'replace') {
      text = verdict.text;
    }
  }
  return { text };
}

/**
 * How much of a turn's stream an output chain costs the reader.
 *
 * `off` — nothing registered, the model writes straight to the run's sink.
 * `whole` — at least one processor needs the complete answer, so every frame is held until the chain
 * has passed and the answer arrives as one `text` frame.
 * `incremental` — every processor declared {@link import('./spi/processors.js').IncrementalGating},
 * so a lookback-bounded prefix is released while the call streams.
 */
export type OutputGateMode = 'off' | 'whole' | 'incremental';

/**
 * ALL or nothing: one undeclared processor puts the whole chain on the whole-answer path. Its author
 * wrote `process` against the complete text, and a chain that ran it on a prefix because a neighbour
 * opted in would be handing it an input it never agreed to read.
 */
export function resolveOutputGateMode(processors: readonly OutputProcessor[]): OutputGateMode {
  if (processors.length === 0) {
    return 'off';
  }
  return processors.every((processor) => processor.incremental !== undefined)
    ? 'incremental'
    : 'whole';
}

/**
 * The chain's window is the WIDEST any member asked for: a release safe for the shortest-sighted
 * processor is not safe for the one that matches longer patterns, and the gate makes one release
 * decision for all of them.
 *
 * An undeclared processor contributes nothing rather than the default — it has no window, because a
 * chain containing one never reaches the incremental path at all.
 */
export function resolveGateLookback(processors: readonly OutputProcessor[]): number {
  let lookback = 0;
  for (const processor of processors) {
    if (processor.incremental !== undefined) {
      lookback = Math.max(
        lookback,
        processor.incremental.lookbackChars ?? DEFAULT_INCREMENTAL_LOOKBACK_CHARS,
      );
    }
  }
  return lookback;
}

/** A live gate over one model call: the sink the model writes to, plus what it let through. */
export interface IncrementalGate {
  /** Hand this to the model instead of the run's writer. */
  writer: SinkWriter;
  /** Resolves once every frame handed to {@link IncrementalGate.writer} has been ruled on. */
  settled(): Promise<void>;
  /** The transformed prefix already written to the run's sink. */
  released(): string;
  /** Set once a prefix was refused; nothing further was released after that. */
  rejection(): GateRejection | undefined;
}

/**
 * Releases a model call's answer to `writer` as it arrives, holding back the last `lookbackChars`
 * characters of what the chain produces so a processor can still change them.
 *
 * The chain runs over the whole PREFIX accumulated so far rather than over each new frame, so a
 * processor always sees well-formed text and never has to reassemble a pattern split across frames —
 * which is what makes {@link import('./spi/processors.js').IncrementalGating}'s promise a claim
 * about prefixes. It runs once per streamed text frame.
 *
 * Only an EXTENSION of what the reader already has is ever written: a chain whose output stops
 * agreeing with its earlier output has broken its promise, and the loop's whole-answer pass reports
 * that rather than this gate papering over it by re-sending a different answer.
 *
 * Frames that are not text are forwarded live, in arrival order — they are not the answer, so the
 * gate does not own them.
 */
export function createIncrementalGate(args: {
  processors: readonly OutputProcessor[];
  ctx: ProcessorContext;
  lookbackChars: number;
  writer: SinkWriter;
}): IncrementalGate {
  const { processors, ctx, lookbackChars, writer } = args;
  let raw = '';
  let released = '';
  let rejection: GateRejection | undefined;
  /** A prefix the chain could not rule on. Text stops flowing; the whole-answer pass decides. */
  let stalled = false;
  // The model is free to write without awaiting, and a verdict is asynchronous — serialize, or two
  // prefixes race and the reader gets the answer out of order.
  let queue: Promise<void> = Promise.resolve();

  async function advance(): Promise<void> {
    if (raw.length === 0) {
      return;
    }
    let settled: OutputGateResult;
    try {
      settled = await runOutputProcessors({
        processors,
        answer: { text: raw, toolCalls: [] },
        ctx,
      });
    } catch {
      // Swallowed HERE only: a prefix pass is an early release, not the verdict. The whole-answer
      // pass runs the same chain and surfaces the failure with the processor's name on it.
      stalled = true;
      return;
    }
    if (settled.rejection !== undefined) {
      rejection = settled.rejection;
      return;
    }
    // The window is trimmed off the chain's OUTPUT, not off the text fed to it: a processor that
    // only saw `raw` minus a tail could not match a pattern straddling that cut, and would release
    // the very text it exists to rewrite.
    const candidate = settled.text.slice(0, Math.max(0, settled.text.length - lookbackChars));
    if (candidate.length <= released.length || !candidate.startsWith(released)) {
      return;
    }
    const delta = candidate.slice(released.length);
    released = candidate;
    await writer.write({ t: 'text', v: delta });
  }

  async function handle(frame: StreamFrame): Promise<void> {
    if (rejection !== undefined) {
      return;
    }
    if (frame.t === 'text') {
      raw += frame.v;
      if (!stalled) {
        await advance();
      }
      return;
    }
    await writer.write(frame);
  }

  return {
    writer: {
      write: (frame) => {
        queue = queue.then(() => handle(frame));
        return queue;
      },
      end: () => {},
    },
    settled: () => queue,
    released: () => released,
    rejection: () => rejection,
  };
}

/**
 * The tail an incremental gate still owes the reader once the whole-answer pass has settled: the
 * authoritative text minus the prefix already released.
 *
 * Throws when the settled answer is not an extension of that prefix. That check is the reason the
 * final pass stays authoritative for both the stream and the store rather than the stream being
 * stitched together from per-prefix results: agreement between what was streamed and what was stored
 * becomes structural instead of assumed.
 */
export function gateTail(args: {
  processors: readonly OutputProcessor[];
  released: string;
  text: string;
}): string {
  const { processors, released, text } = args;
  if (!text.startsWith(released)) {
    throw new ProcessorFailedError(
      'output',
      processors.map((processor) => processor.name).join(' → '),
      new Error(
        `the gated answer is not an extension of the ${released.length} characters this chain already released — a processor that declares "incremental" promises its result on a prefix stays a prefix of its result on the whole answer, outside the last lookbackChars`,
      ),
    );
  }
  return text.slice(released.length);
}
