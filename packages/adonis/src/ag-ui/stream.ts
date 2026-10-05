import type { StreamFrame } from '../spi/token-stream-sink.js';
import {
  type AgUiEvent,
  type AgUiStreamOptions,
  agUiEvents as coreAgUiEvents,
} from './core/index.js';
import { agUiFrames } from './frames.js';

export { agUiSse } from './core/index.js';
export type { AgUiStreamOptions };

/**
 * One AG-UI run over a library run's stream — the local driver over this package's frames. It stops reading when the run is
 * waiting on someone and nothing else is moving, closes the AG-UI run with the interrupt outcome,
 * and leaves the library run parked for the resume to pick up.
 */
export function agUiEvents(
  frames: AsyncIterable<StreamFrame>,
  options: AgUiStreamOptions,
): AsyncGenerator<AgUiEvent> {
  return coreAgUiEvents(agUiFrames(frames), options);
}
