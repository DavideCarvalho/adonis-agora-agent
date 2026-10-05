import { expect, it, vi } from 'vitest';
import { streamChunks } from '../src/react/core/media/tus.js';

it('retries a failed chunk and preserves offsets and current headers', async () => {
  const offsets: string[] = [];
  let calls = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`token-${calls}`);
    offsets.push(headers.get('upload-offset') ?? '');
    calls++;
    if (calls === 1) return new Response('', { status: 503 });
    const body = init?.body;
    if (!(body instanceof Blob)) throw new Error('Expected Blob chunk');
    return new Response(null, {
      status: 204,
      headers: {
        'Upload-Offset': String(Number(headers.get('upload-offset')) + body.size),
      },
    });
  });
  await streamChunks('/upload', new Blob(['abcde']), {
    resume: false,
    chunkSize: 3,
    retries: 2,
    fetchImpl,
    getHeaders: async () => ({ authorization: `token-${calls}` }),
  });
  expect(offsets).toEqual(['0', '0', '3']);
});
it('rejects invalid chunk sizing before sending bytes', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  await expect(
    streamChunks('/upload', new Blob(['abc']), { chunkSize: 0, fetchImpl }),
  ).rejects.toThrow(/chunkSize/);
  expect(fetchImpl).not.toHaveBeenCalled();
});
