import { readFileSync } from 'node:fs';
import { verifyEvents } from '@ag-ui/client';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { from } from 'rxjs';
import type { AgUiEvent } from '../../src/ag-ui/index.js';

/**
 * Two independent judges for what the producer writes, neither of them ours:
 *  - the protocol's own JSON Schema (vendored from `spec/1.0/schema.json`) for each event's SHAPE;
 *  - the first-party client's verifier (`@ag-ui/client`) for the SEQUENCE — what may follow what,
 *    what must be closed before the run finishes.
 */
const schema = JSON.parse(
  readFileSync(new URL('../fixtures/ag-ui/schema-1.0.json', import.meta.url), 'utf8'),
) as { $defs: Record<string, unknown>; $id?: string };

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(schema, 'ag-ui');
const validateEvent = ajv.compile({ $ref: 'ag-ui#/$defs/Event' });
const validateInput = ajv.compile({ $ref: 'ag-ui#/$defs/RunAgentInput' });

/** Throws naming the first event the protocol's schema rejects. */
export function assertSchema(events: readonly AgUiEvent[]): void {
  for (const event of events) {
    const valid: boolean = validateEvent(event);
    if (!valid) {
      throw new Error(
        `${event.type} is not a valid AG-UI 1.0 event: ${ajv.errorsText(validateEvent.errors)}\n${JSON.stringify(event)}`,
      );
    }
  }
}

export function assertInputSchema(input: unknown): void {
  if (!validateInput(input)) {
    throw new Error(`not a valid RunAgentInput: ${ajv.errorsText(validateInput.errors)}`);
  }
}

/** The verifier as a plain function: its rxjs is the client's own copy, not necessarily ours. */
const verify = verifyEvents(false) as unknown as (source: unknown) => {
  subscribe(observer: { error(error: unknown): void; complete(): void }): unknown;
};

/** Rejects when the first-party client would refuse the stream. */
export function assertSequence(events: readonly AgUiEvent[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    verify(from(events)).subscribe({ error: reject, complete: resolve });
  });
}

/** Both judges. */
export async function assertConforms(events: readonly AgUiEvent[]): Promise<void> {
  assertSchema(events);
  await assertSequence(events);
}
