import { describe, expect, it } from 'vitest';
import { createPlaywrightCaptureAdapter } from '../src/react/core/genui/playwright.js';

describe('Playwright capture lifecycle', () => {
  it('closes pages after failure without closing the caller browser', async () => {
    let closed = 0;
    const browser = {
      newContext: async () => ({
        newPage: async () => ({
          route: async () => {},
          setDefaultTimeout: () => {},
          setContent: async () => {
            throw new Error('capture failed');
          },
          close: async () => {
            closed++;
          },
        }),
        close: async () => {
          closed++;
        },
      }),
    };
    const capture = createPlaywrightCaptureAdapter({ browser: browser as never });
    await expect(capture.images(['<!doctype html><p>hello</p>'], {})).rejects.toThrow(
      'capture failed',
    );
    expect(closed).toBe(2);
  });
});
