import { expect, it, vi } from 'vitest';
import { createAgentChatClient } from '../src/client/chat-client.js';

it('maps a text decision JSON receipt without attaching a nonexistent run', async () => {
  const body = {
    threadId: 'thread',
    proposalDecision: { status: 'applied' },
    text: 'Approval queued.',
  };
  const fetch = vi.fn(async () => Response.json(body));
  const onThreadId = vi.fn();
  const client = createAgentChatClient({ fetch });
  const result = await client.send({ body: { threadId: 'thread', message: 'sim' }, onThreadId });
  expect(result).toEqual({
    threadId: 'thread',
    proposalDecision: body.proposalDecision,
    parts: [{ type: 'text', text: body.text }],
  });
  expect(onThreadId).toHaveBeenCalledWith('thread');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('uses exact scoped paths for polling and proposal decisions', async () => {
  const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) =>
    Response.json({ data: [], meta: page(null) }),
  );
  const client = createAgentChatClient({ fetch });
  await client.listActionProposals('thread /');
  await client.decideActionProposal('thread /', 'proposal /', 'approved', { remember: true });
  expect(fetch.mock.calls[0]?.[0]).toBe('/agent/threads/thread%20%2F/action-proposals');
  expect(fetch.mock.calls[1]?.[0]).toBe(
    '/agent/threads/thread%20%2F/action-proposals/proposal%20%2F/approve',
  );
});

const page = (nextCursor: string | null) => ({
  nextCursor,
  prevCursor: null,
  hasNext: nextCursor !== null,
  hasPrev: false,
});

it('traverses filtered empty pages through meta.nextCursor', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ data: [], meta: page('opaque-1') }))
    .mockResolvedValueOnce(Response.json({ data: [{ id: 'new' }], meta: page(null) }));
  expect(await createAgentChatClient({ fetch }).listActionProposals('thread')).toEqual([
    { id: 'new' },
  ]);
  expect(String(fetch.mock.calls[1]?.[0])).toContain('after=opaque-1');
});

it('refuses a cursor that repeats', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => Response.json({ data: [], meta: page('same') }));
  await expect(createAgentChatClient({ fetch }).listActionProposals('thread')).rejects.toThrow(
    'Repeated action proposal cursor',
  );
});
