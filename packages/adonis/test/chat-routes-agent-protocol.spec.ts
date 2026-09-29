import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type AgentConfig, defineTool } from '../src/index.js';
import { FakeModelProvider, type FakeScript } from '../src/testing/fake-model-provider.js';
import { type BootedApp, bootAgentApp, readSse } from './helpers/boot-agent-app.js';

/**
 * The chat routes over real HTTP, as `@dudousxd/nestjs-agent-react` calls them: the agent stream
 * protocol on the wire, and HITL decisions that name the tool call alone.
 */

let booted: BootedApp | null = null;

afterEach(async () => {
  await booted?.close();
  booted = null;
});

const json = { 'content-type': 'application/json', 'x-actor-id': 'u1' };

function bootApp(script: FakeScript, extra: Partial<AgentConfig> = {}): Promise<BootedApp> {
  return bootAgentApp({ model: new FakeModelProvider(script), streamProtocol: 'agent', ...extra });
}

describe('POST /agent/chat under streamProtocol: agent', () => {
  it('writes meta, the AgentStreamEvent frames and done', async () => {
    booted = await bootApp(() => ({ text: 'Hello there' }));
    const response = await fetch(`${booted.url}/agent/chat`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const frames = await readSse(response);
    expect(frames[0]?.event).toBe('meta');
    expect(frames.at(-1)).toEqual({ event: 'done', data: {} });
    const kinds = frames.filter((frame) => frame.event === 'message').map((frame) => frame.data);
    expect(kinds.map((event) => event.kind)).toEqual([
      'step-start',
      'text',
      'step-finish',
      'title',
    ]);
    expect(kinds[1]).toEqual({ kind: 'text', text: 'Hello there' });
  });

  it('approves a parked action named by its tool call alone', async () => {
    const refund = defineTool(
      {
        name: 'refund',
        kind: 'action',
        description: 'refund an order',
        input: z.object({ id: z.number() }),
        roles: ['ADMIN'],
      },
      () => ({ refunded: true }),
    );
    booted = await bootApp(
      (_args, turn) =>
        turn === 0
          ? { text: '', toolCall: { name: 'refund', input: { id: 7 } } }
          : { text: 'Done.' },
      { tools: [refund] },
    );
    const url = booted.url;
    const response = await fetch(`${url}/agent/chat`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ message: 'refund 7' }),
    });
    const decisions: number[] = [];
    const frames = await readSse(response, async (frame) => {
      if (frame.data.kind === 'approval-requested') {
        const decided = await fetch(`${url}/agent/tool-call/approve`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ toolCallId: frame.data.id }),
        });
        decisions.push(decided.status);
      }
    });
    expect(decisions).toEqual([200]);
    expect(frames.map((frame) => frame.data)).toContainEqual({
      kind: 'tool-output',
      id: 'call-0-refund',
      output: { refunded: true },
    });
  });

  it('answers 404 for a decision on a tool call nobody knows', async () => {
    booted = await bootApp(() => ({ text: 'hi' }));
    const response = await fetch(`${booted.url}/agent/tool-call/approve`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ toolCallId: 'nope' }),
    });
    expect(response.status).toBe(404);
  });
});
