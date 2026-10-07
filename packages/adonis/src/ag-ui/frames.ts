import type { StreamFrame } from '../spi/token-stream-sink.js';
import type { AgUiSourceFrame } from './core/index.js';

/**
 * One frame of this package's sink as the frame the local AG-UI encoder reads. The typed `approval` / `elicitation` frames carry what the
 * stream vocabulary leaves optional — the PARKED run, the tool and its arguments — so an interrupt
 * addresses a delegated sub-agent's own run.
 */
export function toAgUiFrame(frame: StreamFrame): AgUiSourceFrame {
  switch (frame.t) {
    case 'text':
      return { kind: 'text', text: frame.v };
    case 'component':
      return {
        kind: 'ui',
        component: frame.name,
        props: frame.data,
        ...(frame.id !== undefined ? { id: frame.id } : {}),
        ...(frame.version !== undefined ? { version: frame.version } : {}),
        ...(frame.fallbackText !== undefined ? { fallbackText: frame.fallbackText } : {}),
        ...(frame.componentVersions !== undefined
          ? { componentVersions: frame.componentVersions }
          : {}),
        ...(frame.toolCallId !== undefined ? { toolCallId: frame.toolCallId } : {}),
      };
    case 'approval':
      return {
        kind: 'approval-requested',
        id: frame.id,
        runId: frame.runId,
        toolName: frame.toolName,
        input: frame.input ?? null,
        approver: frame.approver ?? 'requester',
        ...(frame.target !== undefined ? { target: frame.target } : {}),
        ...(frame.confirmation !== undefined ? { confirmation: frame.confirmation } : {}),
        ...(frame.expiresAt !== undefined ? { expiresAt: frame.expiresAt } : {}),
      };
    case 'elicitation':
      return {
        kind: 'elicitation',
        id: frame.id,
        runId: frame.runId,
        request: frame.request as Extract<AgUiSourceFrame, { kind: 'elicitation' }>['request'],
      };
    case 'error':
      return { kind: 'error', code: frame.code, message: frame.message };
    case 'event':
      // The same vocabulary, copied: shared field for field (see `stream-events.ts`).
      return frame.event as AgUiSourceFrame;
  }
}

/**
 * A library run's stream as the local encoder's frames. A hand-rolled iterator rather than a
 * generator: the AG-UI driver lets go of a parked stream while a read is still pending, and a
 * generator would queue that `return()` behind the read that never comes — the sink's subscription
 * has to be released at once.
 */
export function agUiFrames(frames: AsyncIterable<StreamFrame>): AsyncIterable<AgUiSourceFrame> {
  return {
    [Symbol.asyncIterator]() {
      const inner = frames[Symbol.asyncIterator]();
      return {
        next: async () => {
          const result = await inner.next();
          return result.done === true
            ? { done: true as const, value: undefined }
            : { done: false as const, value: toAgUiFrame(result.value) };
        },
        return: async () => {
          await inner.return?.();
          return { done: true as const, value: undefined };
        },
      };
    },
  };
}
