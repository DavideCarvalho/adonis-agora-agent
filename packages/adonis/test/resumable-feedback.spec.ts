import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentSseEncoder,
  InProcessTokenStreamSink,
  parseStreamCursor,
  type StoredMessage,
  type ThreadDetail,
} from '../src/index.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { type BootedApp, bootAgentApp, readSse } from './helpers/boot-agent-app.js';

describe('numbered frames', () => {
  it('numbers every event 1-based and skips what the cursor already has', () => {
    const frames = [
      { t: 'event', event: { kind: 'step-start' } },
      { t: 'text', v: 'a' },
      { t: 'text', v: 'b' },
    ] as const;
    const full = new AgentSseEncoder();
    expect(frames.map((frame) => full.encode(frame)).join('')).toBe(
      'id: 1\ndata: {"kind":"step-start"}\n\nid: 2\ndata: {"kind":"text","text":"a"}\n\nid: 3\ndata: {"kind":"text","text":"b"}\n\n',
    );
    const resumed = new AgentSseEncoder(2);
    expect(frames.map((frame) => resumed.encode(frame)).join('')).toBe(
      'id: 3\ndata: {"kind":"text","text":"b"}\n\n',
    );
  });

  it('reads a cursor leniently', () => {
    expect(parseStreamCursor('7')).toBe(7);
    expect(parseStreamCursor(['3'])).toBe(3);
    expect(parseStreamCursor('-1')).toBeUndefined();
    expect(parseStreamCursor('x')).toBeUndefined();
    expect(parseStreamCursor(undefined)).toBeUndefined();
  });
});

describe('the REST surface of #211 over HTTP', () => {
  let booted: BootedApp | null = null;
  afterEach(async () => {
    await booted?.close();
    booted = null;
  });
  const as = (id: string) => ({ 'content-type': 'application/json', 'x-actor-id': id });

  async function chat(url: string) {
    const response = await fetch(`${url}/agent/chat`, {
      method: 'POST',
      headers: as('u1'),
      body: JSON.stringify({ message: 'hello there' }),
    });
    const runId = response.headers.get('x-agent-run-id') as string;
    const threadId = response.headers.get('x-agent-thread-id') as string;
    const frames = await readSse(response);
    return { runId, threadId, frames };
  }

  it('re-attaches from a cursor, by ?after= or Last-Event-ID, and 404s once nothing is buffered', async () => {
    const sink = new InProcessTokenStreamSink();
    booted = await bootAgentApp({
      model: new FakeModelProvider(() => ({ text: 'Hi.' })),
      streamProtocol: 'agent',
      sink,
    });
    const { url } = booted;
    const { runId } = await chat(url);

    const tail = await readSse(
      await fetch(`${url}/agent/chat/${runId}/stream?after=2`, { headers: as('u1') }),
    );
    expect(tail[0]?.event).toBe('meta');
    expect(
      tail.filter((frame) => frame.event === 'message').map((frame) => frame.data.kind),
    ).toEqual(['step-finish', 'title']);
    const viaHeader = await readSse(
      await fetch(`${url}/agent/chat/${runId}/stream`, {
        headers: { ...as('u1'), 'last-event-id': '3' },
      }),
    );
    expect(
      viaHeader.filter((frame) => frame.event === 'message').map((frame) => frame.data.kind),
    ).toEqual(['title']);

    sink.close(runId);
    const gone = await fetch(`${url}/agent/chat/${runId}/stream`, { headers: as('u1') });
    expect(gone.status).toBe(404);
  });

  it('rates, re-rates and clears a message; only its owner may', async () => {
    booted = await bootAgentApp({ model: new FakeModelProvider(() => ({ text: 'Hi.' })) });
    const { url } = booted;
    const { threadId } = await chat(url);
    const thread = (await (
      await fetch(`${url}/agent/threads/${threadId}`, { headers: as('u1') })
    ).json()) as ThreadDetail;
    const answer = thread.messages.find((message: StoredMessage) => message.role === 'assistant');
    const feedback = (id: string, body: unknown) =>
      fetch(`${url}/agent/messages/${answer?.id}/feedback`, {
        method: 'POST',
        headers: as(id),
        body: JSON.stringify(body),
      });

    const rated = await feedback('u1', { value: 'down', comment: '  too short  ' });
    expect(rated.status).toBe(200);
    expect(await rated.json()).toEqual({
      feedback: { value: 'down', comment: 'too short', updatedAt: expect.any(String) },
    });
    const reread = (await (
      await fetch(`${url}/agent/threads/${threadId}`, { headers: as('u1') })
    ).json()) as ThreadDetail;
    expect(reread.messages.find((message) => message.id === answer?.id)?.feedback).toMatchObject({
      value: 'down',
    });

    expect((await feedback('u2', { value: 'up' })).status).toBe(403);
    expect((await feedback('u1', { value: 'meh' })).status).toBe(400);
    expect(await (await feedback('u1', { value: null })).json()).toEqual({ feedback: null });
    const missing = await fetch(`${url}/agent/messages/nope/feedback`, {
      method: 'POST',
      headers: as('u1'),
      body: JSON.stringify({ value: 'up' }),
    });
    expect(missing.status).toBe(404);
  });

  it('renames a thread with PATCH', async () => {
    booted = await bootAgentApp({ model: new FakeModelProvider(() => ({ text: 'Hi.' })) });
    const { url } = booted;
    const { threadId } = await chat(url);
    const patched = await fetch(`${url}/agent/threads/${threadId}`, {
      method: 'PATCH',
      headers: as('u1'),
      body: JSON.stringify({ title: 'Renamed' }),
    });
    expect(await patched.json()).toEqual({ ok: true });
    const list = (await (await fetch(`${url}/agent/threads`, { headers: as('u1') })).json()) as {
      title: string;
    }[];
    expect(list.map((thread) => thread.title)).toEqual(['Renamed']);
    const bad = await fetch(`${url}/agent/threads/${threadId}`, {
      method: 'PATCH',
      headers: as('u1'),
      body: JSON.stringify({ title: '' }),
    });
    expect(bad.status).toBe(400);
  });
});
