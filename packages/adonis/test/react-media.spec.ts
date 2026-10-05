import { describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '../src/index.js';
import { AgentClient } from '../src/react/core/client.js';
import {
  createMediaUpload,
  MediaUploadError,
  mediaAttachments,
} from '../src/react/core/media/index.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
  body: unknown;
}

const READY: MessageAttachment = {
  mediaId: 'm1',
  url: '',
  contentType: 'application/pdf',
  name: 'report.pdf',
};

/** A server that answers the agent's begin/complete/discard and media's tus PATCH. */
function fakeServer(options: { failPatch?: boolean; stallPatch?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const headers = { ...(init.headers as Record<string, string>) };
    calls.push({ url, method, headers, credentials: init.credentials, body: init.body });
    if (method === 'POST' && url.endsWith('/agent/attachments/uploads')) {
      return Response.json(
        { mediaId: 'm1', uploadId: 'u1', location: '/media/uploads/u1' },
        { status: 201 },
      );
    }
    if (method === 'PATCH') {
      if (options.stallPatch) {
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      }
      if (options.failPatch) return new Response(null, { status: 500 });
      const offset = Number(headers['Upload-Offset']);
      const size = (init.body as Blob).size;
      return new Response(null, {
        status: 204,
        headers: { 'Upload-Offset': String(offset + size) },
      });
    }
    if (method === 'POST' && url.endsWith('/complete')) return Response.json(READY);
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const pdf = () => new File([new Uint8Array(10)], 'report.pdf', { type: 'application/pdf' });

describe('createMediaUpload', () => {
  it('opens the session on the agent, streams to media’s tus endpoint in chunks, then completes', async () => {
    const server = fakeServer();
    const upload = createMediaUpload({
      baseUrl: 'https://api.test',
      fetch: server.fetchImpl,
      chunkSize: 4,
      credentials: 'include',
      getHeaders: () => ({ 'X-XSRF-TOKEN': 'csrf' }),
    });
    const progress: number[] = [];
    const attachment = await upload(pdf(), { onProgress: (fraction) => progress.push(fraction) });

    expect(attachment).toEqual(READY);
    expect(server.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST https://api.test/agent/attachments/uploads',
      'PATCH https://api.test/media/uploads/u1',
      'PATCH https://api.test/media/uploads/u1',
      'PATCH https://api.test/media/uploads/u1',
      'POST https://api.test/agent/attachments/uploads/m1/complete',
    ]);
    expect(JSON.parse(server.calls[0]?.body as string)).toEqual({
      filename: 'report.pdf',
      contentType: 'application/pdf',
      size: 10,
    });
    for (const call of server.calls) {
      expect(call.credentials).toBe('include');
      expect(call.headers['X-XSRF-TOKEN']).toBe('csrf');
    }
    expect(progress.at(-1)).toBe(1);
    expect(progress).toContain(0.4);
  });

  it('honours a custom agent path and an absolute tus location', async () => {
    const server = fakeServer();
    const upload = createMediaUpload({ path: '/api/agent', fetch: server.fetchImpl });
    await upload(pdf(), {});
    expect(server.calls[0]?.url).toBe('/api/agent/attachments/uploads');
  });

  it('discards the server-side attachment when the upload is aborted', async () => {
    const server = fakeServer({ stallPatch: true });
    const upload = createMediaUpload({ fetch: server.fetchImpl, retries: 1 });
    const controller = new AbortController();
    const pending = upload(pdf(), { signal: controller.signal });
    await vi.waitFor(() => expect(server.calls.some((call) => call.method === 'PATCH')).toBe(true));
    controller.abort();
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() =>
      expect(server.calls.at(-1)).toMatchObject({
        method: 'DELETE',
        url: '/agent/attachments/uploads/m1',
      }),
    );
  });

  it('discards the server-side attachment when streaming fails', async () => {
    const server = fakeServer({ failPatch: true });
    const upload = createMediaUpload({ fetch: server.fetchImpl, retries: 1 });
    await expect(upload(pdf(), {})).rejects.toThrow();
    await vi.waitFor(() => expect(server.calls.at(-1)?.method).toBe('DELETE'));
  });

  it('surfaces a refused session (415/413) without streaming anything', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 415 }));
    const upload = createMediaUpload({ fetch: fetchImpl as unknown as typeof fetch });
    await expect(upload(pdf(), {})).rejects.toThrow(/415/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('MediaUploadError', () => {
  it('carries the status of a refused request', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 413 }));
    const upload = createMediaUpload({ fetch: fetchImpl as unknown as typeof fetch });
    await expect(upload(pdf(), {})).rejects.toBeInstanceOf(MediaUploadError);
    await expect(upload(pdf(), {})).rejects.toMatchObject({ status: 413 });
  });

  it("carries the server's message, code and body, and reports it to onHttpError", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ message: 'PDFs over 20 MB are refused', code: 'too_large' }, { status: 413 }),
    );
    const onHttpError = vi.fn();
    const client = new AgentClient({
      fetch: fetchImpl as unknown as typeof fetch,
      onHttpError,
      attachments: { upload: mediaAttachments() },
    });

    const error = await client.uploadAttachment(pdf()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MediaUploadError);
    expect(error).toMatchObject({
      status: 413,
      code: 'too_large',
      message: 'PDFs over 20 MB are refused',
      body: { message: 'PDFs over 20 MB are refused', code: 'too_large' },
    });
    expect(onHttpError).toHaveBeenCalledWith(error);
  });
});

describe('mediaAttachments — the one-line default', () => {
  it('plugs into AgentClient and reuses its connection (baseUrl, path, headers, credentials, fetch)', async () => {
    const server = fakeServer();
    const client = new AgentClient({
      baseUrl: 'https://api.test',
      fetch: server.fetchImpl,
      credentials: 'include',
      headers: { 'X-Static': 's' },
      getHeaders: () => ({ 'X-XSRF-TOKEN': 'csrf' }),
      path: 'api/agent',
      attachments: { upload: mediaAttachments({ chunkSize: 4 }) },
    });
    const progress: number[] = [];
    expect(await client.uploadAttachment(pdf(), { onProgress: (f) => progress.push(f) })).toEqual(
      READY,
    );
    expect(server.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST https://api.test/api/agent/attachments/uploads',
      'PATCH https://api.test/media/uploads/u1',
      'PATCH https://api.test/media/uploads/u1',
      'PATCH https://api.test/media/uploads/u1',
      'POST https://api.test/api/agent/attachments/uploads/m1/complete',
    ]);
    for (const call of server.calls) {
      expect(call.credentials).toBe('include');
      expect(call.headers).toMatchObject({ 'X-Static': 's', 'X-XSRF-TOKEN': 'csrf' });
    }
    expect(progress.at(-1)).toBe(1);
  });
});
