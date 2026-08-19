import type { StreamFrame } from './spi/token-stream-sink.js';

/**
 * Serializes a {@link StreamFrame} into the provider's SSE envelope. A text frame becomes
 * `data: {"delta":...}` (byte-identical to the legacy text-only envelope); a component frame
 * becomes `event: component\ndata: {name,data}`.
 */
export function frameToSse(frame: StreamFrame): string {
  if (frame.t === 'component') {
    return `event: component\ndata: ${JSON.stringify({ name: frame.name, data: frame.data })}\n\n`;
  }
  return `data: ${JSON.stringify({ delta: frame.v })}\n\n`;
}
