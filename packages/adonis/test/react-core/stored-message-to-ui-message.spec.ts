import { describe, expect, it } from 'vitest';
import type { StoredMessage } from '../../src/react/core/client-wire.js';
import { storedMessageToUiMessage } from '../../src/react/core/stored-message-to-ui-message.js';

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('storedMessageToUiMessage', () => {
  it('maps a text-only message to a single text part', () => {
    const ui = storedMessageToUiMessage(message({ content: 'Hello there' }));

    expect(ui).toEqual({
      id: 'msg-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Hello there' }],
      metadata: { createdAt: '2026-01-01T00:00:00.000Z' },
    });
  });

  it('places a component a tool pushed right after that call, the others ahead of the calls', () => {
    const ui = storedMessageToUiMessage(
      message({
        content: 'Here',
        toolCalls: [
          { id: 'c1', name: 'chart', input: {}, kind: 'read' },
          { id: 'c2', name: 'lookup', input: {}, kind: 'read' },
        ],
        toolResults: [
          { id: 'c1', name: 'chart', output: { id: 'c1:ui:0' } },
          { id: 'c2', name: 'lookup', output: {} },
        ],
        ui: [
          { id: 'm1', component: 'Banner', props: {} },
          { id: 'c1:ui:0', component: 'Chart', props: { n: 1 }, toolCallId: 'c1' },
          { id: 'orphan', component: 'Note', props: {}, toolCallId: 'gone' },
        ],
      }),
    );
    expect(ui.parts.map((part) => ('id' in part ? `${part.type}:${part.id}` : part.type))).toEqual([
      'text',
      'data-ui:m1',
      'data-ui:orphan',
      'tool-chart',
      'data-ui:c1:ui:0',
      'tool-lookup',
    ]);
    expect(ui.parts[4]).toMatchObject({
      data: { id: 'c1:ui:0', component: 'Chart', props: { n: 1 }, toolCallId: 'c1' },
    });
  });

  it("replays a nested call's parentId and the host's metadata under the library's keys", () => {
    const ui = storedMessageToUiMessage(
      message({
        content: 'Done',
        toolCalls: [
          { id: 'c1', name: 'execute', input: {}, kind: 'read' },
          { id: 'c1.0', name: 'orders.get', input: {}, kind: 'read', parentId: 'c1' },
        ],
        metadata: { model: 'openai/gpt', createdAt: 'host value loses' },
      }),
    );
    expect(ui.parts[2]).toMatchObject({
      type: 'tool-orders.get',
      toolMetadata: { toolKind: 'read', parentId: 'c1' },
    });
    expect(ui.metadata).toEqual({ model: 'openai/gpt', createdAt: '2026-01-01T00:00:00.000Z' });
  });

  it('skips the text part when content is empty', () => {
    const ui = storedMessageToUiMessage(message({ content: '' }));
    expect(ui.parts).toEqual([]);
  });

  /**
   * A reloaded thread must not turn a refusal into a result. The stored shape of a declined call is
   * an output (`{ rejected: true }`) like any other, so mapping it as `output-available` handed a
   * card the same state a completed action gets — and the action a person refused was drawn, after
   * a refresh, as one that had been carried out.
   */
  it('reloads a declined action as denied, not as an available output', () => {
    const ui = storedMessageToUiMessage(
      message({
        toolCalls: [{ id: 'call-1', name: 'purgeCache', input: { key: 'cfg' }, kind: 'action' }],
        toolResults: [
          {
            id: 'call-1',
            name: 'purgeCache',
            output: { rejected: true, reason: 'wrong environment' },
            denied: true,
            error: 'The person was asked to approve this action and declined it.',
          },
        ],
      }),
    );

    expect(ui.parts[0]).toEqual({
      type: 'tool-purgeCache',
      toolCallId: 'call-1',
      toolMetadata: { toolKind: 'action' },
      state: 'output-denied',
      input: { key: 'cfg' },
      approval: { id: 'call-1', approved: false, reason: 'wrong environment' },
    });
  });

  it('reloads a refusal recorded before the denied flag existed', () => {
    // Threads written by an older loop hold only `{ rejected: true }`, and they are still read back.
    const ui = storedMessageToUiMessage(
      message({
        toolCalls: [{ id: 'call-1', name: 'purgeCache', input: { key: 'cfg' }, kind: 'action' }],
        toolResults: [
          {
            id: 'call-1',
            name: 'purgeCache',
            output: { rejected: true, reason: 'rejected by user' },
            error: 'rejected',
          },
        ],
      }),
    );

    expect(ui.parts[0]).toMatchObject({ state: 'output-denied' });
    // The placeholder reason is the absence of one, so it is not shown as something a person said.
    expect(ui.parts[0]).toEqual(
      expect.objectContaining({ approval: { id: 'call-1', approved: false } }),
    );
  });

  /**
   * A reloaded thread must not turn a failure into a result either. A call whose turn died before
   * it was settled is stored with an `error` and no output; mapped as `output-available` it reloads
   * as a completed call, and an approval card reads "done" for an action that never ran.
   */
  it('reloads a failed call as an error, not as an available output', () => {
    const ui = storedMessageToUiMessage(
      message({
        toolCalls: [{ id: 'call-1', name: 'purgeCache', input: { key: 'cfg' }, kind: 'action' }],
        toolResults: [
          {
            id: 'call-1',
            name: 'purgeCache',
            output: null,
            error: 'the run ended before this tool call was settled',
          },
        ],
      }),
    );

    expect(ui.parts[0]).toEqual({
      type: 'tool-purgeCache',
      toolCallId: 'call-1',
      toolMetadata: { toolKind: 'action' },
      state: 'output-error',
      input: { key: 'cfg' },
      errorText: 'the run ended before this tool call was settled',
    });
  });

  it('maps attachments to file parts, alongside the text part', () => {
    const ui = storedMessageToUiMessage(
      message({
        role: 'user',
        content: 'check this out',
        attachments: [
          { mediaId: 'm1', url: 'https://cdn/a.png', contentType: 'image/png', name: 'a.png' },
          {
            mediaId: 'm2',
            url: 'https://cdn/b.pdf',
            contentType: 'application/pdf',
            name: 'b.pdf',
          },
        ],
      }),
    );

    expect(ui.parts).toEqual([
      { type: 'text', text: 'check this out' },
      {
        type: 'file',
        mediaType: 'image/png',
        filename: 'a.png',
        url: 'https://cdn/a.png',
        providerMetadata: { agent: { mediaId: 'm1' } },
      },
      {
        type: 'file',
        mediaType: 'application/pdf',
        filename: 'b.pdf',
        url: 'https://cdn/b.pdf',
        providerMetadata: { agent: { mediaId: 'm2' } },
      },
    ]);
  });

  it('pairs multiple tool calls with their results by id, in output-available state', () => {
    const ui = storedMessageToUiMessage(
      message({
        content: '',
        toolCalls: [
          { id: 't1', name: 'listUsers', input: { limit: 5 } },
          { id: 't2', name: 'executeSql', input: { query: 'SELECT 1' } },
        ],
        toolResults: [
          { id: 't2', name: 'executeSql', output: { rows: [] } },
          { id: 't1', name: 'listUsers', output: { users: [] } },
        ],
      }),
    );

    expect(ui.parts).toEqual([
      {
        type: 'tool-listUsers',
        toolCallId: 't1',
        state: 'output-available',
        input: { limit: 5 },
        output: { users: [] },
      },
      {
        type: 'tool-executeSql',
        toolCallId: 't2',
        state: 'output-available',
        input: { query: 'SELECT 1' },
        output: { rows: [] },
      },
    ]);
  });

  it('renders a tool call with no matching result as input-available, without a fabricated output', () => {
    const ui = storedMessageToUiMessage(
      message({
        content: '',
        toolCalls: [{ id: 't1', name: 'longRunningJob', input: { jobId: 'j1' } }],
        toolResults: [],
      }),
    );

    expect(ui.parts).toEqual([
      {
        type: 'tool-longRunningJob',
        toolCallId: 't1',
        state: 'input-available',
        input: { jobId: 'j1' },
      },
    ]);
    const toolPart = ui.parts[0] as Record<string, unknown>;
    expect('output' in toolPart).toBe(false);
  });

  it('carries toolKind through as toolMetadata when the store reports it', () => {
    const ui = storedMessageToUiMessage(
      message({
        content: '',
        toolCalls: [
          { id: 't1', name: 'purgeCache', input: {}, kind: 'action' },
          { id: 't2', name: 'listUsers', input: {}, kind: 'read' },
        ],
        toolResults: [
          { id: 't1', name: 'purgeCache', output: { ok: true } },
          { id: 't2', name: 'listUsers', output: { users: [] } },
        ],
      }),
    );

    expect(ui.parts).toEqual([
      {
        type: 'tool-purgeCache',
        toolCallId: 't1',
        state: 'output-available',
        input: {},
        output: { ok: true },
        toolMetadata: { toolKind: 'action' },
      },
      {
        type: 'tool-listUsers',
        toolCallId: 't2',
        state: 'output-available',
        input: {},
        output: { users: [] },
        toolMetadata: { toolKind: 'read' },
      },
    ]);
  });

  it('omits toolMetadata when the store does not report a kind (older backends)', () => {
    const ui = storedMessageToUiMessage(
      message({
        content: '',
        toolCalls: [{ id: 't1', name: 'listUsers', input: {} }],
        toolResults: [{ id: 't1', name: 'listUsers', output: {} }],
      }),
    );

    const toolPart = ui.parts[0] as Record<string, unknown>;
    expect('toolMetadata' in toolPart).toBe(false);
  });
});
