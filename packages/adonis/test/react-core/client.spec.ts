import { describe, expect, it, type Mock, vi } from 'vitest';
import { AgentClient, AgentHttpError } from '../../src/react/core/client.js';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, statusText: 'OK' });
}

/** The `fetch` arguments of one recorded call — fails loudly rather than destructuring `undefined`. */
function fetchCall(mock: Mock<typeof fetch>, index = 0): [string | Request | URL, RequestInit] {
  const call = mock.mock.calls[index];
  if (!call) throw new Error(`fetch was called fewer than ${index + 1} time(s)`);
  return [call[0], call[1] ?? {}];
}

describe('AgentClient', () => {
  describe('path', () => {
    it.each([
      [undefined, 'https://api.example.com/agent/threads'],
      ['api/agent', 'https://api.example.com/api/agent/threads'],
      ['/api/agent/', 'https://api.example.com/api/agent/threads'],
      ['', 'https://api.example.com/threads'],
    ])('path %j hangs every route off %s', async (path, expected) => {
      const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse([]));
      const client = new AgentClient({
        baseUrl: 'https://api.example.com/',
        fetch: fetchMock,
        ...(path !== undefined ? { path } : {}),
      });
      await client.listThreads();
      expect(fetchCall(fetchMock)[0]).toBe(expected);
    });
  });

  describe('updateThread', () => {
    it('PATCHes the thread with the given patch', async () => {
      const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
      const client = new AgentClient({ baseUrl: 'https://api.example.com', fetch: fetchMock });

      const result = await client.updateThread('thr-1', { defaultAgent: 'researcher' });

      expect(result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchCall(fetchMock);
      expect(url).toBe('https://api.example.com/agent/threads/thr-1');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(String(init.body))).toEqual({ defaultAgent: 'researcher' });
    });

    it('sends defaultAgent: null to clear a previously-set default', async () => {
      const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
      const client = new AgentClient({ fetch: fetchMock });

      await client.updateThread('thr-1', { defaultAgent: null });

      const [, init] = fetchCall(fetchMock);
      expect(JSON.parse(String(init.body))).toEqual({ defaultAgent: null });
    });

    it('renames with a title-only patch', async () => {
      const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
      const client = new AgentClient({ fetch: fetchMock });

      await client.updateThread('thr-1', { title: 'New title' });

      const [url, init] = fetchCall(fetchMock);
      expect(url).toBe('/agent/threads/thr-1');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(String(init.body))).toEqual({ title: 'New title' });
    });
  });

  describe('uploadAttachment', () => {
    it('POSTs the file as multipart form data under field "file"', async () => {
      let capturedInit: RequestInit | undefined;
      const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
        capturedInit = init;
        return jsonResponse({
          mediaId: 'm1',
          url: 'https://cdn/a.png',
          contentType: 'image/png',
          name: 'a.png',
        });
      });
      const client = new AgentClient({ baseUrl: 'https://api.example.com', fetch: fetchMock });
      const file = new File(['bytes'], 'a.png', { type: 'image/png' });

      const attachment = await client.uploadAttachment(file);

      expect(attachment).toEqual({
        mediaId: 'm1',
        url: 'https://cdn/a.png',
        contentType: 'image/png',
        name: 'a.png',
      });
      const [url] = fetchCall(fetchMock);
      expect(url).toBe('https://api.example.com/agent/attachments');
      expect(capturedInit?.method).toBe('POST');
      expect(capturedInit?.body).toBeInstanceOf(FormData);
      const body = capturedInit?.body;
      if (!(body instanceof FormData)) throw new Error('Expected upload FormData');
      expect(body.get('file')).toBe(file);
      // No content-type header set — the browser must own the multipart boundary.
      const headers = new Headers(capturedInit?.headers);
      expect(headers.get('content-type')).toBeNull();
    });

    it('merges static + dynamic headers and forwards credentials', async () => {
      const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
      const client = new AgentClient({
        headers: { 'x-tenant': 'acme' },
        getHeaders: () => ({ authorization: 'Bearer tok' }),
        credentials: 'include',
        fetch: fetchMock,
      });

      await client.uploadAttachment(new File(['x'], 'x.png', { type: 'image/png' }));

      const [, init] = fetchCall(fetchMock);
      const headers = new Headers(init.headers);
      expect(headers.get('x-tenant')).toBe('acme');
      expect(headers.get('authorization')).toBe('Bearer tok');
      expect(init.credentials).toBe('include');
    });

    it('throws AgentHttpError on a non-2xx response', async () => {
      const fetchMock = vi.fn<typeof fetch>(
        async () => new Response('', { status: 413, statusText: 'Payload Too Large' }),
      );
      const client = new AgentClient({ fetch: fetchMock });

      await expect(
        client.uploadAttachment(new File(['x'], 'x.png', { type: 'image/png' })),
      ).rejects.toMatchObject({ status: 413 });
    });
  });

  describe('error answers', () => {
    it("carries the server's message, code and parsed body", async () => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        jsonResponse(
          { code: 'quota_exceeded', period: 'day', message: 'Daily AI budget used up' },
          { status: 429 },
        ),
      );
      const client = new AgentClient({ fetch: fetchMock });

      const error = await client
        .openChatStream({ body: { message: 'hi' } })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AgentHttpError);
      expect(error).toMatchObject({
        status: 429,
        code: 'quota_exceeded',
        message: 'Daily AI budget used up',
        body: { code: 'quota_exceeded', period: 'day', message: 'Daily AI budget used up' },
        method: 'POST',
        path: '/agent/chat',
      });
    });

    it("reads NestJS's validation shape (a list of messages)", async () => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        jsonResponse(
          { statusCode: 400, message: ['model is not offered', 'bad id'], error: 'Bad Request' },
          { status: 400 },
        ),
      );
      const client = new AgentClient({ fetch: fetchMock });

      await expect(client.approveToolCall({ toolCallId: 'c1' })).rejects.toMatchObject({
        status: 400,
        message: 'model is not offered; bad id',
      });
    });

    it('keeps a non-JSON body as text and falls back to a generic message', async () => {
      const fetchMock = vi.fn<typeof fetch>(
        async () =>
          new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
      );
      const client = new AgentClient({ fetch: fetchMock });

      const error = (await client
        .listThreads()
        .catch((caught: unknown) => caught)) as AgentHttpError;

      expect(error.status).toBe(502);
      expect(error.body).toBe('<html>bad gateway</html>');
      expect(error.code).toBeUndefined();
      expect(error.message).toBe('Agent request failed: GET /agent/threads → 502 Bad Gateway');
    });

    it('reports every error answer to onHttpError before throwing it', async () => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        jsonResponse({ message: 'Session ended', code: 'session_ended' }, { status: 401 }),
      );
      const onHttpError = vi.fn();
      const client = new AgentClient({ fetch: fetchMock, onHttpError });

      await expect(client.getQuota()).rejects.toBeInstanceOf(AgentHttpError);
      await expect(client.openChatStream({ body: {} })).rejects.toBeInstanceOf(AgentHttpError);

      expect(onHttpError).toHaveBeenCalledTimes(2);
      expect(onHttpError.mock.calls[0]?.[0]).toMatchObject({ status: 401, code: 'session_ended' });
    });

    it('does not report a resume 404 — that is "nothing is streaming", not an error', async () => {
      const fetchMock = vi.fn<typeof fetch>(async () => new Response('', { status: 404 }));
      const onHttpError = vi.fn();
      const client = new AgentClient({ fetch: fetchMock, onHttpError });

      await expect(client.resumeChatStream({ runId: 'r1' })).resolves.toBeNull();
      expect(onHttpError).not.toHaveBeenCalled();
    });
  });
});
