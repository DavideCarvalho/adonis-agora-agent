import { describe, expect, it, vi } from 'vitest';
import { attachmentFetchDownloader } from '../src/ai-sdk/attachment-fetch-downloader.js';

function fetchResponding(status: number, body: Uint8Array, contentType?: string): typeof fetch {
  return vi.fn(async () => {
    return new Response(status >= 200 && status < 300 ? new Uint8Array(body).buffer : null, {
      status,
      ...(contentType !== undefined ? { headers: { 'content-type': contentType } } : {}),
    });
  }) as unknown as typeof fetch;
}

describe('attachmentFetchDownloader', () => {
  it('fetches unsupported URLs — including localhost, which the SDK default refuses', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const download = attachmentFetchDownloader(fetchResponding(200, bytes, 'application/pdf'));
    const [result] = await download([
      { url: new URL('http://localhost:9000/staging/boleto.pdf'), isUrlSupportedByModel: false },
    ]);
    expect(result).toEqual({ data: bytes, mediaType: 'application/pdf' });
  });

  it('leaves model-supported URLs to the provider (null)', async () => {
    const fetchImpl = vi.fn();
    const download = attachmentFetchDownloader(fetchImpl as unknown as typeof fetch);
    const [result] = await download([
      { url: new URL('https://public.example/img.png'), isUrlSupportedByModel: true },
    ]);
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws with status + hostname (never the full presigned URL) on a failed fetch', async () => {
    const download = attachmentFetchDownloader(fetchResponding(403, new Uint8Array()));
    const failing = download([
      {
        url: new URL('http://localhost:9000/staging/x?X-Amz-Signature=secret'),
        isUrlSupportedByModel: false,
      },
    ]);
    const error = await failing.then(
      () => {
        throw new Error('expected rejection');
      },
      (thrown: unknown) => thrown,
    );
    if (!(error instanceof Error)) {
      throw new Error('expected an Error rejection');
    }
    expect(error.message).toMatch(/403.*localhost/);
    expect(error.message).not.toContain('secret');
  });

  it('omits mediaType when the response has no content-type', async () => {
    const download = attachmentFetchDownloader(fetchResponding(200, new Uint8Array([9])));
    const [result] = await download([
      { url: new URL('http://minio.local/f'), isUrlSupportedByModel: false },
    ]);
    expect(result?.mediaType).toBeUndefined();
  });
});
