import type { SinkWriter } from './spi/token-stream-sink.js';
import type { AiToolCtx } from './spi/tool.js';
import type { AgentUiComponent } from './stream-events.js';

/*
 * `ctx.emitUi` plumbing, after `tool-ui.ts` in `@dudousxd/nestjs-agent-core`: a collector per tool
 * call that streams each push and remembers it, and the envelope that carries the pushes on the
 * tool step's journaled result — so a durable replay neither re-streams nor re-persists them.
 */

const TOOL_STEP_UI = '@@adonis-agent/tool-step-ui';

interface ToolStepOutputWithUi {
  [TOOL_STEP_UI]: 1;
  output: unknown;
  ui: AgentUiComponent[];
}

/**
 * What a tool step returns: the output alone when the tool pushed nothing (the bytes a run journaled
 * before `emitUi` existed), else an envelope carrying the pushes with it.
 */
export function wrapToolStepOutput(output: unknown, ui: readonly AgentUiComponent[]): unknown {
  if (ui.length === 0) {
    return output;
  }
  const wrapped: ToolStepOutputWithUi = { [TOOL_STEP_UI]: 1, output, ui: [...ui] };
  return wrapped;
}

/** Read a tool step's result back — an envelope, or a bare output recorded without one. */
export function unwrapToolStepOutput(raw: unknown): { output: unknown; ui: AgentUiComponent[] } {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as Partial<ToolStepOutputWithUi>)[TOOL_STEP_UI] === 1
  ) {
    const wrapped = raw as ToolStepOutputWithUi;
    return { output: wrapped.output, ui: Array.isArray(wrapped.ui) ? wrapped.ui : [] };
  }
  return { output: raw, ui: [] };
}

export type EmitUi = AiToolCtx['emitUi'];

/**
 * An `emitUi` for a context with no conversation to push into (an MCP call, a handler invoked
 * directly): it accepts the push and answers an id, so a tool never has to branch on where it runs.
 */
export function createNoopEmitUi(scope = 'noop'): EmitUi {
  let next = 0;
  return async (_component, _props, options = {}) => {
    if (options.id !== undefined) {
      return { id: options.id };
    }
    const id = `${scope}:ui:${next}`;
    next += 1;
    return { id };
  };
}

export interface UiCollector {
  emit: EmitUi;
  /** Every distinct component pushed, first-seen order, last props per id. */
  components(): AgentUiComponent[];
  /** Restart the default id counter — a retried attempt re-pushes under the same ids. */
  restart(): void;
}

/**
 * The `emitUi` of one tool call. Ids default to `<toolCallId>:ui:<n>`; each push is written to the
 * run's stream as it happens (a component frame, which both envelopes carry) and kept for the step's
 * result.
 */
export function createUiCollector(toolCallId: string, writer?: SinkWriter): UiCollector {
  const pushed = new Map<string, AgentUiComponent>();
  let next = 0;
  const emit: EmitUi = async (component, props, options = {}) => {
    if (typeof component !== 'string' || component.length === 0) {
      throw new Error('emitUi: component must be a non-empty string');
    }
    if (typeof props !== 'object' || props === null || Array.isArray(props)) {
      throw new Error('emitUi: props must be a JSON object');
    }
    let id = options.id;
    if (id === undefined) {
      id = `${toolCallId}:ui:${next}`;
      next += 1;
    }
    const entry: AgentUiComponent = {
      id,
      component,
      // Snapshot: the frame and the persisted value are what the tool pushed at THIS moment.
      props: JSON.parse(JSON.stringify(props)) as Record<string, unknown>,
      ...(options.version !== undefined ? { version: options.version } : {}),
      toolCallId,
    };
    pushed.set(id, entry);
    await writer?.write({
      t: 'component',
      name: component,
      data: entry.props,
      id,
      toolCallId,
      ...(entry.version !== undefined ? { version: entry.version } : {}),
    });
    return { id };
  };
  return {
    emit,
    components: () => [...pushed.values()],
    restart: () => {
      next = 0;
    },
  };
}

/** Merge component lists: first-seen order, last props per id. */
export function mergeUi(
  ...lists: readonly (readonly AgentUiComponent[] | undefined)[]
): AgentUiComponent[] {
  const merged = new Map<string, AgentUiComponent>();
  for (const list of lists) {
    for (const component of list ?? []) {
      merged.set(component.id, component);
    }
  }
  return [...merged.values()];
}
