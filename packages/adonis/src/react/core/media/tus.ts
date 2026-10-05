interface StreamChunksOptions {
  chunkSize?: number;
  retries?: number;
  resume?: boolean;
  fetchImpl?: typeof fetch;
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  signal?: AbortSignal;
  onProgress?: (sent: number, total: number) => void;
}

/** Browser-only sequential tus uploads; connection headers refresh on every request. */
export async function streamChunks(
  location: string,
  data: Blob,
  options: StreamChunksOptions = {},
): Promise<void> {
  const chunkSize = options.chunkSize ?? 5 * 1024 * 1024;
  const retries = options.retries ?? 3;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1)
    throw new RangeError('chunkSize must be a positive safe integer');
  if (!Number.isSafeInteger(retries) || retries < 1 || retries > 20)
    throw new RangeError('retries must be 1–20');
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = async () => ({ 'Tus-Resumable': '1.0.0', ...(await options.getHeaders?.()) });
  let offset = 0;
  options.signal?.throwIfAborted();
  if (options.resume !== false) {
    const response = await fetchImpl(location, {
      method: 'HEAD',
      headers: await headers(),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.ok) {
      const reported = Number(response.headers.get('Upload-Offset') ?? 0);
      if (!Number.isSafeInteger(reported) || reported < 0 || reported > data.size)
        throw new Error('Invalid tus Upload-Offset');
      offset = reported;
    }
  }
  options.onProgress?.(offset, data.size);
  while (offset < data.size) {
    options.signal?.throwIfAborted();
    const end = Math.min(offset + chunkSize, data.size);
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetchImpl(location, {
          method: 'PATCH',
          headers: {
            ...(await headers()),
            'Content-Type': 'application/offset+octet-stream',
            'Upload-Offset': String(offset),
          },
          body: data.slice(offset, end),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (!response.ok)
          throw new Error(
            `Media upload PATCH failed at offset ${offset}: ${response.status} ${response.statusText}`,
          );
        const reported = Number(response.headers.get('Upload-Offset') ?? end);
        if (!Number.isSafeInteger(reported) || reported <= offset || reported > data.size)
          throw new Error('Invalid tus Upload-Offset');
        offset = reported;
        options.onProgress?.(offset, data.size);
        break;
      } catch (error) {
        options.signal?.throwIfAborted();
        if (attempt === retries - 1) throw error;
      }
    }
  }
}
