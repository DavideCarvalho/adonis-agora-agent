import { expect, it } from 'vitest';
import { decodeFrame, foldPart, parseSseEvent } from '../src/client/index.js';
import { AgentSseEncoder } from '../src/sse.js';

it('encodes a text frame as a numbered agent-protocol text event', () => {
  expect(new AgentSseEncoder().encode({ t: 'text', v: 'hi' })).toBe(
    'id: 1\ndata: {"kind":"text","text":"hi"}\n\n',
  );
});

it('encodes a parked action as approval-requested, carrying the run to answer', () => {
  const sse = new AgentSseEncoder().encode({
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

it('reads an approval-requested with no run to address as a plain event, not an approval', () => {
  const event = parseSseEvent(
    'data: {"kind":"approval-requested","id":"c-1","approver":"requester","toolName":"voidInvoice"}',
  );
  expect(event && decodeFrame(event)).toMatchObject({ type: 'event' });
});

it('does not decode the retired {"delta"} envelope', () => {
  const event = parseSseEvent('data: {"delta":"hi"}');
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
