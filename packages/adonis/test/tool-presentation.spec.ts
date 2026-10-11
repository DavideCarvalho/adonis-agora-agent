import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIRM_VERB, humanizeToolName, resolveToolConfirmation } from '../src/index.js';

describe('humanizeToolName', () => {
  it('turns any identifier style into words a person can read', () => {
    expect(humanizeToolName('refund_order')).toBe('Refund order');
    expect(humanizeToolName('refundOrder')).toBe('Refund order');
    expect(humanizeToolName('refund-order')).toBe('Refund order');
    expect(humanizeToolName('orders.refund')).toBe('Orders refund');
    expect(humanizeToolName('sendHTTPRequest')).toBe('Send http request');
    expect(humanizeToolName('  ')).toBe('');
  });
});

describe('resolveToolConfirmation', () => {
  it("fills the tool's confirm templates from the call input with the shared filler", () => {
    expect(
      resolveToolConfirmation(
        'refund_order',
        { order: { id: 1002 }, amount: 12 },
        {
          label: 'Refund',
          confirm: {
            title: 'Refund order #{order.id}?',
            verb: 'Refund',
            detail: '{amount} {currency} goes back',
          },
        },
      ),
    ).toEqual({ title: 'Refund order #1002?', verb: 'Refund', detail: '12 goes back' });
  });

  it('falls back to the label, then the humanized name — never the raw identifier', () => {
    expect(resolveToolConfirmation('db_query', {}, { label: 'Database query' })).toEqual({
      title: 'Database query?',
      verb: DEFAULT_CONFIRM_VERB,
    });
    expect(resolveToolConfirmation('refund_order', { id: 1 })).toEqual({
      title: 'Refund order?',
      verb: 'Approve',
    });
    expect(resolveToolConfirmation('', undefined)).toEqual({ title: 'Approve?', verb: 'Approve' });
  });

  it('keeps a title or verb that fills to nothing from reaching a person empty', () => {
    expect(
      resolveToolConfirmation(
        'refund_order',
        {},
        { confirm: { title: '{title}', verb: '{verb}' } },
      ),
    ).toEqual({ title: 'Refund order?', verb: 'Approve' });
  });
});
