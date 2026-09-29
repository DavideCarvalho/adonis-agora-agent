import type { SinkWriter, StreamFrame, TokenStreamSink } from '../index.js';

interface RunBuffer {
  chunks: StreamFrame[];
  ended: boolean;
  notify: Set<() => void>;
}

/**
 * In-memory `TokenStreamSink`. Buffers typed frames per run so a late subscriber (reconnect)
 * replays everything emitted so far, then follows live until the run ends.
 */
export class InMemoryTokenStreamSink implements TokenStreamSink {
  private readonly runs = new Map<string, RunBuffer>();

  private buffer(runId: string): RunBuffer {
    let buf = this.runs.get(runId);
    if (buf === undefined) {
      buf = { chunks: [], ended: false, notify: new Set() };
      this.runs.set(runId, buf);
    }
    return buf;
  }

  private wake(buf: RunBuffer): void {
    for (const resolve of buf.notify) {
      resolve();
    }
    buf.notify.clear();
  }

  open(runId: string): SinkWriter {
    const buf = this.buffer(runId);
    return {
      write: (frame: StreamFrame) => {
        buf.chunks.push(frame);
        this.wake(buf);
      },
      end: () => {
        buf.ended = true;
        this.wake(buf);
      },
    };
  }

  async *subscribe(runId: string): AsyncIterable<StreamFrame> {
    const buf = this.buffer(runId);
    let index = 0;
    while (true) {
      while (index < buf.chunks.length) {
        const chunk = buf.chunks[index];
        index += 1;
        if (chunk !== undefined) {
          yield chunk;
        }
      }
      if (buf.ended) {
        return;
      }
      await new Promise<void>((resolve) => buf.notify.add(resolve));
    }
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  close(runId: string): void {
    this.runs.delete(runId);
  }
}
