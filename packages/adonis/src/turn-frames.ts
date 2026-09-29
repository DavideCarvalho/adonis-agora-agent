import type { ModelTurnResult } from './spi/model-provider.js';
import type { SinkWriter, StreamFrame } from './spi/token-stream-sink.js';
import type { AgentUiComponent } from './stream-events.js';

/** What a model turn streamed that the persisted message keeps, beyond its text and tool calls. */
export interface TurnFrameSummary {
  reasoning?: string;
  reasoningMs?: number;
  ui?: AgentUiComponent[];
}

export interface ObservedTurnFrames {
  /** Hand THIS to the provider: every write passes through to the wrapped writer unchanged. */
  writer: SinkWriter;
  /** What was seen so far. Closes an open thinking burst at the moment it is called. */
  summary(): TurnFrameSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Watch the frames a model turn writes, to learn what the stream showed that the provider's result
 * does not carry: the model's thinking (text and how long it took) and any pushed UI components.
 *
 * Derived from the FRAMES rather than asked of each provider, so every provider that streams
 * `reasoning` gets it persisted without implementing anything. Thinking time is the sum of each burst
 * of consecutive `reasoning` frames — from the first one to the next frame that is not reasoning (or
 * the end of the turn) — which is what a reader watched as "thinking".
 *
 * Call it inside the step that runs the model, so the summary rides that step's journaled result and
 * a replay reads the same numbers back instead of re-measuring a turn that is not happening. The same
 * derivation as `observeTurnFrames` in `@dudousxd/nestjs-agent-core`, over typed frames instead of
 * NDJSON bytes.
 */
export function observeTurnFrames(
  writer: SinkWriter,
  now: () => number = Date.now,
): ObservedTurnFrames {
  let reasoning = '';
  let reasoningMs = 0;
  let burstStartedAt: number | undefined;
  const ui = new Map<string, AgentUiComponent>();

  function closeBurst(): void {
    if (burstStartedAt !== undefined) {
      reasoningMs += Math.max(0, now() - burstStartedAt);
      burstStartedAt = undefined;
    }
  }

  function observe(frame: StreamFrame): void {
    if (frame.t === 'event' && frame.event.kind === 'reasoning') {
      burstStartedAt ??= now();
      reasoning += frame.event.text;
      return;
    }
    closeBurst();
    // A repeat id replaces the props but keeps the component where it first appeared, exactly as
    // the client's data part does.
    if (frame.t === 'event' && frame.event.kind === 'ui') {
      const { kind: _kind, ...component } = frame.event;
      ui.set(component.id, component);
    } else if (frame.t === 'component' && frame.id !== undefined) {
      ui.set(frame.id, {
        id: frame.id,
        component: frame.name,
        props: isRecord(frame.data) ? frame.data : { value: frame.data },
        ...(frame.toolCallId !== undefined ? { toolCallId: frame.toolCallId } : {}),
      });
    }
  }

  return {
    writer: {
      write(frame) {
        // Observed before it is forwarded, so a burst closes at the moment the next frame was
        // produced rather than whenever a slow sink got round to accepting it.
        observe(frame);
        return writer.write(frame);
      },
      end: () => writer.end(),
    },
    summary() {
      closeBurst();
      return {
        ...(reasoning.length > 0 ? { reasoning, reasoningMs: Math.round(reasoningMs) } : {}),
        ...(ui.size > 0 ? { ui: [...ui.values()] } : {}),
      };
    },
  };
}

/** Fill what a provider did not report from what its frames showed. A provider's own value wins. */
export function withTurnFrames<T extends ModelTurnResult>(result: T, frames: TurnFrameSummary): T {
  return {
    ...result,
    ...(result.reasoning === undefined && frames.reasoning !== undefined
      ? { reasoning: frames.reasoning }
      : {}),
    ...(result.reasoningMs === undefined && frames.reasoningMs !== undefined
      ? { reasoningMs: frames.reasoningMs }
      : {}),
    ...(result.ui === undefined && frames.ui !== undefined ? { ui: frames.ui } : {}),
  };
}
