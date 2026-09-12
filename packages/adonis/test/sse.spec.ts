import { expect, it } from 'vitest';
import { decodeFrame, foldPart, parseSseEvent } from '../src/client/index.js';
import { frameToSse } from '../src/sse.js';

it('encodes a text frame as the delta envelope (byte-identical to legacy)', () => {
  expect(frameToSse({ t: 'text', v: 'hi' })).toBe('data: {"delta":"hi"}\n\n');
});

it('encodes a component frame as an event: component frame', () => {
  expect(frameToSse({ t: 'component', name: 'card_metrica', data: { a: 1 } })).toBe(
    'event: component\ndata: {"name":"card_metrica","data":{"a":1}}\n\n',
  );
});

it('encodes a parked action as an event: approval frame carrying the run to answer', () => {
  expect(
    frameToSse({
      t: 'approval',
      runId: 'child-1',
      id: 'call-0-voidInvoice',
      toolName: 'voidInvoice',
      input: { id: 'i-1' },
    }),
  ).toBe(
    'event: approval\ndata: {"runId":"child-1","id":"call-0-voidInvoice","toolName":"voidInvoice","input":{"id":"i-1"}}\n\n',
  );
});

it('round-trips an approval frame through the client decoder', () => {
  const sse = frameToSse({
    t: 'approval',
    runId: 'child-1',
    id: 'call-0-voidInvoice',
    toolName: 'voidInvoice',
    input: { id: 'i-1' },
  });
  const event = parseSseEvent(sse.trimEnd());
  expect(event).not.toBeNull();
  expect(event && decodeFrame(event)).toEqual({
    type: 'approval',
    runId: 'child-1',
    toolCallId: 'call-0-voidInvoice',
    toolName: 'voidInvoice',
    input: { id: 'i-1' },
  });
});

it('drops an approval frame with no run to address, rather than half-decoding it', () => {
  const event = parseSseEvent('event: approval\ndata: {"id":"c-1","toolName":"voidInvoice"}');
  expect(event && decodeFrame(event)).toBeNull();
});

it('leaves an approval frame out of the assistant message parts', () => {
  // It is a form to put to the user, not something the model said.
  const frame = {
    type: 'approval' as const,
    runId: 'r-1',
    toolCallId: 'c-1',
    toolName: 'voidInvoice',
    input: {},
  };
  expect(foldPart([{ type: 'text', text: 'hi' }], frame)).toEqual([{ type: 'text', text: 'hi' }]);
});
