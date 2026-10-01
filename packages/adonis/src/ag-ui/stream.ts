import {
  type AgUiEvent,
  type AgUiStreamOptions,
  agUiEvents as sharedAgUiEvents,
} from '@dudousxd/nestjs-agent-core/ag-ui';
import type { StreamFrame } from '../spi/token-stream-sink.js';
import { agUiFrames } from './frames.js';

export { agUiSse } from '@dudousxd/nestjs-agent-core/ag-ui';
export type { AgUiStreamOptions };

/**
 * One AG-UI run over a library run's stream — the shared driver
 * (`@dudousxd/nestjs-agent-core/ag-ui`) over this package's frames. It stops reading when the run is
 * waiting on someone and nothing else is moving, closes the AG-UI run with the interrupt outcome,
 * and leaves the library run parked for the resume to pick up.
 */
export function agUiEvents(
  frames: AsyncIterable<StreamFrame>,
  options: AgUiStreamOptions,
): AsyncGenerator<AgUiEvent> {
  return sharedAgUiEvents(agUiFrames(frames), options);
}
