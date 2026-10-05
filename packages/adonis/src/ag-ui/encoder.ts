import type { StreamFrame } from '../spi/token-stream-sink.js';
import {
  type AgUiEncoderOptions,
  type AgUiEvent,
  AgUiEncoder as CoreEncoder,
} from './core/index.js';
import { toAgUiFrame } from './frames.js';

export type { AgUiEncoderOptions };

/**
 * The local AG-UI encoder, reading this package's {@link StreamFrame}s. A pure state machine: the same frames
 * always give the same events.
 */
export class AgUiEncoder {
  private readonly core: CoreEncoder;

  constructor(options: AgUiEncoderOptions) {
    this.core = new CoreEncoder(options);
  }

  /** How many frames of the library stream this encoder has consumed. */
  get consumed(): number {
    return this.core.consumed;
  }

  /** The run is waiting on at least one approval or question set nobody has settled yet. */
  get waiting(): boolean {
    return this.core.waiting;
  }

  /** A tool call is announced and neither answered nor parked: more frames are coming. */
  get busy(): boolean {
    return this.core.busy;
  }

  start(): AgUiEvent[] {
    return this.core.start();
  }

  encode(frame: StreamFrame): AgUiEvent[] {
    return this.core.encode(toAgUiFrame(frame));
  }

  finish(ended = false): AgUiEvent[] {
    return this.core.finish(ended);
  }
}
