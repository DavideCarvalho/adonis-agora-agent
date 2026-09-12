import type { StreamFrame } from './spi/token-stream-sink.js';

/**
 * Serializes a {@link StreamFrame} into the provider's SSE envelope. A text frame becomes
 * `data: {"delta":...}` (byte-identical to the text-only envelope); a component frame becomes
 * `event: component\ndata: {name,data}`; a question set becomes `event: elicitation`, carrying the
 * whole request so a client can render the form without a second fetch; a parked `action` becomes
 * `event: approval`, carrying the tool and its arguments. Both of those also carry the `runId` to
 * answer against, which for a delegated sub-agent is not the run this stream is keyed by.
 */
export function frameToSse(frame: StreamFrame): string {
  if (frame.t === 'component') {
    return `event: component\ndata: ${JSON.stringify({ name: frame.name, data: frame.data })}\n\n`;
  }
  if (frame.t === 'approval') {
    return `event: approval\ndata: ${JSON.stringify({ runId: frame.runId, id: frame.id, toolName: frame.toolName, input: frame.input })}\n\n`;
  }
  if (frame.t === 'elicitation') {
    return `event: elicitation\ndata: ${JSON.stringify({ runId: frame.runId, id: frame.id, request: frame.request })}\n\n`;
  }
  return `data: ${JSON.stringify({ delta: frame.v })}\n\n`;
}
