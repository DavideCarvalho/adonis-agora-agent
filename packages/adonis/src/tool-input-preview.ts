import { parsePartialJson } from './partial-json.js';
import type { SinkWriter, StreamFrame } from './spi/token-stream-sink.js';
import type { ToolInputPreview } from './spi/tool.js';

/** Default least time between two preview frames of one call ({@link ToolInputPreview.throttleMs}). */
export const DEFAULT_PREVIEW_THROTTLE_MS = 100;

/** A preview a model turn showed: what the loop withdraws if the call's own push never replaces it. */
export interface ShownPreview {
  id: string;
  component: string;
  toolCallId: string;
}

/** The id a call's preview is shown under: the one its first `ctx.emitUi` push gets. */
export function previewUiId(toolCallId: string): string {
  return `${toolCallId}:ui:0`;
}

/** The frame that withdraws a preview: partial, with nothing to draw. */
export function withdrawPreviewFrame(shown: ShownPreview): StreamFrame {
  return {
    t: 'component',
    name: shown.component,
    data: {},
    id: shown.id,
    toolCallId: shown.toolCallId,
    partial: true,
  };
}

interface CallState {
  preview: ToolInputPreview;
  text: string;
  /** When the last preview frame was written; `undefined` before the first. */
  lastAt: number | undefined;
  /** The props last written, serialized: an unchanged preview is not written again. */
  lastProps: string | undefined;
  component: string | undefined;
  stopped: boolean;
}

export interface ToolInputPreviews {
  /** Hand THIS to the model provider: every frame passes through, previews are added after. */
  writer: SinkWriter;
  /** The previews still standing (shown and not withdrawn), in the order they first appeared. */
  shown(): ShownPreview[];
}

/**
 * Wrap the writer a model turn streams into so a tool that previews its input
 * (`ToolHandler.previewInput`) gets `ui` frames drawn from the arguments while the model writes them.
 *
 * Per call: the streamed argument text (`tool-input-delta`) is accumulated, parsed as far as it goes
 * (`parsePartialJson`) and handed to the preview; what it renders is written as a `partial` component
 * frame — at most one every `throttleMs`, and only when it changed, so a long tree costs the stream
 * (and every sink buffering it) a bounded number of snapshots rather than one per delta. Whatever the
 * throttle held back is flushed when the arguments are complete (`tool-input-available`).
 *
 * Previews never fail the turn: a preview that throws is dropped for that call.
 */
export function previewToolInputs(
  inner: SinkWriter,
  resolve: (toolName: string, toolCallId: string) => Promise<ToolInputPreview | undefined>,
  now: () => number = Date.now,
): ToolInputPreviews {
  const calls = new Map<string, CallState>();
  const shown = new Map<string, ShownPreview>();

  async function emit(id: string, state: CallState, input: unknown, done: boolean): Promise<void> {
    let rendered: ReturnType<ToolInputPreview['render']>;
    try {
      const parsed =
        done && input !== undefined
          ? { value: input, complete: true, isOpen: () => false, pendingMember: () => undefined }
          : parsePartialJson(state.text);
      if (parsed === undefined) return;
      rendered = state.preview.render({
        value: parsed.value,
        done: done || parsed.complete,
        isOpen: parsed.isOpen,
        pendingMember: parsed.pendingMember,
      });
    } catch {
      rendered = null;
    }
    if (rendered === undefined) return;
    const uiId = previewUiId(id);
    if (rendered === null) {
      state.stopped = true;
      const standing = shown.get(uiId);
      if (standing !== undefined) {
        shown.delete(uiId);
        await inner.write(withdrawPreviewFrame(standing));
      }
      return;
    }
    const props = JSON.stringify(rendered.props);
    if (props === state.lastProps && rendered.component === state.component) return;
    state.lastProps = props;
    state.component = rendered.component;
    state.lastAt = now();
    shown.set(uiId, { id: uiId, component: rendered.component, toolCallId: id });
    await inner.write({
      t: 'component',
      name: rendered.component,
      data: JSON.parse(props) as Record<string, unknown>,
      id: uiId,
      toolCallId: id,
      ...(rendered.version !== undefined ? { version: rendered.version } : {}),
      partial: true,
    });
  }

  return {
    writer: {
      async write(frame) {
        await inner.write(frame);
        if (frame.t !== 'event') return;
        const event = frame.event;
        if (event.kind === 'tool-input-start') {
          if (calls.has(event.id)) return;
          let preview: ToolInputPreview | undefined;
          try {
            preview = await resolve(event.name, event.id);
          } catch {
            preview = undefined;
          }
          if (preview !== undefined) {
            calls.set(event.id, {
              preview,
              text: '',
              lastAt: undefined,
              lastProps: undefined,
              component: undefined,
              stopped: false,
            });
          }
          return;
        }
        if (event.kind === 'tool-input-delta') {
          const state = calls.get(event.id);
          if (state === undefined || state.stopped) return;
          state.text += event.delta;
          const throttle = state.preview.throttleMs ?? DEFAULT_PREVIEW_THROTTLE_MS;
          if (state.lastAt !== undefined && now() - state.lastAt < throttle) return;
          await emit(event.id, state, undefined, false);
          return;
        }
        if (event.kind === 'tool-input-available') {
          const state = calls.get(event.id);
          if (state === undefined) return;
          calls.delete(event.id);
          if (state.stopped) return;
          // The whole input, at once: what the throttle held back, and the closing brackets.
          await emit(event.id, state, event.input, true);
        }
      },
      end: () => inner.end(),
    },
    shown: () => [...shown.values()],
  };
}
