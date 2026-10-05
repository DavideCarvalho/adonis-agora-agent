import type { Browser, LaunchOptions, Page } from 'playwright-core';
import { boundedCaptureOptions, type CaptureAdapter, type CaptureOptions } from './server.js';

export interface PlaywrightCaptureOptions {
  /** Caller-owned browser; the adapter closes only its own contexts and pages. */
  browser?: Browser;
  /** Used only without a supplied browser. Install playwright-core and supply executablePath. */
  launchOptions?: LaunchOptions;
  /** Explicit allowlist for trusted app images/fonts/styles. All requests otherwise abort. */
  allowAsset?: (url: string) => boolean;
}
export function createPlaywrightCaptureAdapter(
  options: PlaywrightCaptureOptions = {},
): CaptureAdapter {
  async function withPage<T>(
    settings: CaptureOptions,
    operation: (page: Page, limits: Required<CaptureOptions>) => Promise<T>,
  ) {
    const limits = boundedCaptureOptions(settings);
    const browser =
      options.browser ??
      (await (await import('playwright-core')).chromium.launch(options.launchOptions));
    try {
      const context = await browser.newContext({
        javaScriptEnabled: false,
        serviceWorkers: 'block',
        viewport: { width: limits.width, height: limits.height },
      });
      try {
        const page = await context.newPage();
        try {
          page.setDefaultTimeout(limits.timeoutMs);
          await page.route('**/*', (route) =>
            options.allowAsset?.(route.request().url()) ? route.continue() : route.abort(),
          );
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              operation(page, limits),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error('genui: capture timed out')),
                  limits.timeoutMs,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      if (!options.browser) await browser.close();
    }
  }
  function checkPages(html: readonly string[]) {
    if (!html.length || html.length > 100)
      throw new RangeError('genui: capture requires 1–100 pages');
  }
  async function ready(page: Page, html: string, limits: Required<CaptureOptions>) {
    await page.setContent(html, { waitUntil: 'load', timeout: limits.timeoutMs });
    // Host evaluation is available while page-origin JavaScript stays disabled.
    await page.evaluate(async (timeoutMs) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([
            document.fonts.ready,
            ...Array.from(document.images, (image) =>
              image.complete
                ? Promise.resolve()
                : new Promise<void>((resolve) => {
                    image.addEventListener('load', () => resolve(), { once: true });
                    image.addEventListener('error', () => resolve(), { once: true });
                  }),
            ),
          ]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('genui: assets timed out')), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }, limits.timeoutMs);
    const height = await page.evaluate(() =>
      Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    );
    if (height > limits.height)
      throw new RangeError(
        'genui: content exceeds capture height; reduce rowsPerPage or paginate the component',
      );
  }
  return {
    async images(html, settings) {
      checkPages(html);
      return withPage(settings, async (page, limits) => {
        const images: Uint8Array[] = [];
        for (const content of html) {
          await ready(page, content, limits);
          images.push(
            await page.screenshot({ type: 'png', fullPage: true, timeout: limits.timeoutMs }),
          );
        }
        return images;
      });
    },
    async pdf(html, settings) {
      checkPages(html);
      return withPage(settings, async (page, limits) => {
        // Separate full HTML pages via srcdoc to preserve per-page CSS and theme.
        const escapeAttribute = (value: string) =>
          value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        const pdfDocument = `<!doctype html><html><head><style>@page { size: ${limits.width}px ${limits.height}px; margin: 0 } body { margin: 0 } iframe { display:block; border:0; width:${limits.width}px; height:${limits.height}px; break-after:page } iframe:last-child { break-after:auto }</style></head><body>${html.map((content) => `<iframe sandbox srcdoc="${escapeAttribute(content)}"></iframe>`).join('')}</body></html>`;
        await page.setContent(pdfDocument, { waitUntil: 'load', timeout: limits.timeoutMs });
        for (const frame of page.frames().slice(1)) {
          await frame.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all(
              Array.from(document.images, (image) => image.decode().catch(() => {})),
            );
          });
          const height = await frame.evaluate(() => document.documentElement.scrollHeight);
          if (height > limits.height)
            throw new RangeError('genui: content exceeds PDF page height; reduce rowsPerPage');
        }
        return page.pdf({
          width: `${limits.width}px`,
          height: `${limits.height}px`,
          printBackground: true,
          preferCSSPageSize: true,
        });
      });
    },
  };
}
