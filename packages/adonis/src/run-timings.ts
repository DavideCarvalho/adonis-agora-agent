import type { RunStepTiming, RunTimings } from './spi/agent-store.js';

/** One tool call's execution window: epoch-ms start and how long it ran. */
export interface ToolWindow {
  /** Epoch ms the call started. Absent → the call is counted as if it ran alone. */
  at?: number;
  ms: number;
}

/**
 * Wall-clock time a set of tool calls took: the union of their windows, so calls that ran in
 * parallel count once and a gap between two sequential calls counts not at all. A call whose start
 * is unknown (journaled before starts were) adds its full duration.
 */
export function toolsWallClockMs(windows: readonly ToolWindow[]): number {
  let total = 0;
  const timed: [number, number][] = [];
  for (const window of windows) {
    const ms = Math.max(0, window.ms);
    if (window.at === undefined) total += ms;
    else timed.push([window.at, window.at + ms]);
  }
  timed.sort((left, right) => left[0] - right[0]);
  let start: number | undefined;
  let end = 0;
  for (const [from, to] of timed) {
    if (start === undefined || from > end) {
      if (start !== undefined) total += end - start;
      start = from;
      end = to;
    } else if (to > end) {
      end = to;
    }
  }
  if (start !== undefined) total += end - start;
  return total;
}

/** A run's {@link RunTimings} from its steps: totals and counts, every figure a whole ms. */
export function rollupRunTimings(steps: readonly RunStepTiming[]): RunTimings {
  let modelMs = 0;
  let toolsMs = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  const rounded: RunStepTiming[] = [];
  for (const step of steps) {
    const modelStep = step.modelMs === undefined ? undefined : Math.round(step.modelMs);
    if (modelStep !== undefined) {
      modelMs += modelStep;
      modelCalls += 1;
    }
    const stepToolsMs = Math.round(step.toolsMs);
    toolsMs += stepToolsMs;
    toolCalls += step.tools.length;
    rounded.push({
      step: step.step,
      ...(modelStep !== undefined ? { modelMs: modelStep } : {}),
      tools: step.tools.map((tool) => ({ ...tool, ms: Math.round(tool.ms) })),
      toolsMs: stepToolsMs,
    });
  }
  return { modelMs, toolsMs, modelCalls, toolCalls, steps: rounded };
}
