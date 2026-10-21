import { describe, expect, it } from 'vitest';
import type { SinkWriter, StreamFrame } from '../src/spi/token-stream-sink.js';
import { observeFirstText } from '../src/turn-timing.js';

describe('observeFirstText', () => {
  it('notes the first non-empty text frame and passes every frame through', async () => {
    const written: StreamFrame[] = [];
    const sink = { write: (f: StreamFrame) => void written.push(f), end: () => {} } as SinkWriter;
    let clock = 10;
    const { writer, firstTextAt } = observeFirstText(sink, () => clock);

    await writer.write({ t: 'event', event: { kind: 'step-start' } } as StreamFrame);
    await writer.write({ t: 'text', v: '' });
    expect(firstTextAt()).toBeUndefined();
    clock = 25;
    await writer.write({ t: 'text', v: 'Oi' });
    clock = 40;
    await writer.write({ t: 'text', v: ' tudo bem' });

    expect(firstTextAt()).toBe(25);
    expect(written).toHaveLength(4);
  });
});
