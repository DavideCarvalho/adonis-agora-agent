import {
  type AgUiEncoderOptions,
  type AgUiEvent,
  AgUiEncoder as SharedEncoder,
} from '@dudousxd/nestjs-agent-core/ag-ui';
import type { StreamFrame } from '../spi/token-stream-sink.js';
import { toAgUiFrame } from './frames.js';

export type { AgUiEncoderOptions };

/**
 * The shared AG-UI encoder (`@dudousxd/nestjs-agent-core/ag-ui`, one implementation for both
 * servers), reading this package's {@link StreamFrame}s. A pure state machine: the same frames
 * always give the same events.
 */
export class AgUiEncoder {
  private readonly shared: SharedEncoder;

  constructor(options: AgUiEncoderOptions) {
    this.shared = new SharedEncoder(options);
  }

  /** How many frames of the library stream this encoder has consumed. */
  get consumed(): number {
    return this.shared.consumed;
  }

  /** The run is waiting on at least one approval or question set nobody has settled yet. */
  get waiting(): boolean {
    return this.shared.waiting;
  }

  /** A tool call is announced and neither answered nor parked: more frames are coming. */
  get busy(): boolean {
    return this.shared.busy;
  }

  start(): AgUiEvent[] {
    return this.shared.start();
  }

  encode(frame: StreamFrame): AgUiEvent[] {
    return this.shared.encode(toAgUiFrame(frame));
  }

  finish(ended = false): AgUiEvent[] {
    return this.shared.finish(ended);
  }
}
