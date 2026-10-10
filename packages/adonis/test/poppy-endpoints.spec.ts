import { afterEach, describe, expect, it } from 'vitest';
import PoppyProvider from '../providers/poppy_provider.js';
import {
  announcedPoppyEndpoints,
  announcePoppyEndpoints,
  POPPY_ENDPOINTS_SLOT,
  poppyConversationsUrl,
} from '../src/poppy/index.js';
import { setPoppyHandler } from '../src/poppy/runtime.js';

/** The slice of an Adonis app the provider's `boot` touches. */
function fakeApp(config: Record<string, unknown> | undefined) {
  const used: unknown[] = [];
  return {
    used,
    app: {
      config: { get: (key: string) => (key === 'poppy' ? config : undefined) },
      container: {
        make: async (name: string) => {
          if (name === 'server') return { use: (list: unknown[]) => used.push(...list) };
          throw new Error(`unexpected ${name}`);
        },
      },
    } as never,
  };
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[POPPY_ENDPOINTS_SLOT];
  setPoppyHandler(null);
});

describe('Poppy endpoint announcement (for poppy.json)', () => {
  it('builds the absolute conversation URL', () => {
    expect(poppyConversationsUrl('https://api.acme.com/', '/poppy/conversations/')).toBe(
      'https://api.acme.com/poppy/conversations',
    );
  });

  it('merges into the slot, keeping what is already there', () => {
    (globalThis as Record<symbol, unknown>)[POPPY_ENDPOINTS_SLOT] = { other: 'https://x/o' };
    announcePoppyEndpoints({ conversations: 'https://x/c' });
    expect(announcedPoppyEndpoints()).toEqual({
      other: 'https://x/o',
      conversations: 'https://x/c',
    });
  });

  it('the provider announces {baseUrl}/{path} at boot', async () => {
    (globalThis as Record<symbol, unknown>)[POPPY_ENDPOINTS_SLOT] = { other: 'https://x/o' };
    const { app, used } = fakeApp({ baseUrl: 'https://api.acme.com/', path: 'poppy/v1' });
    await new PoppyProvider(app).boot();
    expect(used).toHaveLength(1);
    expect((globalThis as Record<symbol, unknown>)[POPPY_ENDPOINTS_SLOT]).toEqual({
      other: 'https://x/o',
      conversations: 'https://api.acme.com/poppy/v1',
    });
  });

  it('defaults the path, and announces nothing without baseUrl or without the surface', async () => {
    await new PoppyProvider(fakeApp({ baseUrl: 'https://api.acme.com' }).app).boot();
    expect(announcedPoppyEndpoints().conversations).toBe(
      'https://api.acme.com/poppy/conversations',
    );
    delete (globalThis as Record<symbol, unknown>)[POPPY_ENDPOINTS_SLOT];
    await new PoppyProvider(fakeApp({ agent: 'support' }).app).boot();
    expect(announcedPoppyEndpoints()).toEqual({});
    await new PoppyProvider(fakeApp(undefined).app).boot();
    expect(announcedPoppyEndpoints()).toEqual({});
  });
});
