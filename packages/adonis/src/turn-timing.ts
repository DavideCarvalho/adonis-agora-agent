import type { SinkWriter, StreamFrame } from './spi/token-stream-sink.js';

/**
 * Wraps the turn's stream writer to note when the first `text` frame goes out: the time to first
 * token as the reader sees it (a frame an output gate held back counts when it was released). The
 * clock is this process's, so a run resumed elsewhere measures from its resume.
 */
export function observeFirstText(
  writer: SinkWriter,
  now: () => number = Date.now,
): { writer: SinkWriter; firstTextAt: () => number | undefined } {
  let firstTextAt: number | undefined;
  const wrapped: SinkWriter = Object.create(writer) as SinkWriter;
  wrapped.write = (frame: StreamFrame) => {
    if (firstTextAt === undefined && frame.t === 'text' && frame.v.length > 0) firstTextAt = now();
    return writer.write(frame);
  };
  wrapped.end = () => writer.end();
  if (typeof writer.flush === 'function') {
    wrapped.flush = () => (writer.flush as () => void | Promise<void>).call(writer);
  }
  return { writer: wrapped, firstTextAt: () => firstTextAt };
}
