import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSandboxDocument, SANDBOX_MESSAGE } from '../src/genui/sandbox.js';

/*
 * The sandbox frame's height protocol in a real browser: the frame reports its CONTENT's height and
 * the host sizes the iframe to it — down as well as up. The frame starts at the model's
 * `initialHeight` (here 600px), so a measure that reads the viewport (`documentElement.scrollHeight`
 * never drops below it) would leave a gap under a short view forever.
 *
 * Opt in with a host browser path (GENUI_CHROMIUM_PATH), like the other browser specs.
 */
const executablePath = process.env.GENUI_CHROMIUM_PATH;
const enabled = executablePath !== undefined && existsSync(executablePath);

const TOKEN = 'resize-test-token';

/** The host page: one sandbox frame, resized to whatever its bridge reports (as the renderer does). */
function hostPage(srcdoc: string): string {
  return `<!doctype html><html><body style="margin:0">
<iframe id="frame" sandbox="allow-scripts" style="display:block;width:480px;border:0;height:600px"></iframe>
<script>
window.reports = [];
const frame = document.getElementById('frame');
window.addEventListener('message', (event) => {
  const data = event.data;
  if (event.source !== frame.contentWindow || !data || data.token !== ${JSON.stringify(TOKEN)}) return;
  if (data.type === ${JSON.stringify(SANDBOX_MESSAGE.resize)} || data.type === ${JSON.stringify(SANDBOX_MESSAGE.ready)}) {
    if (typeof data.height === 'number') { window.reports.push(data.height); frame.style.height = data.height + 'px'; }
  }
});
window.run = (code) => frame.contentWindow.postMessage({ type: ${JSON.stringify(SANDBOX_MESSAGE.run)}, code, token: ${JSON.stringify(TOKEN)} }, '*');
frame.srcdoc = ${JSON.stringify(srcdoc).replace(/</g, '\\u003c')};
</script></body></html>`;
}

describe.skipIf(!enabled)(
  'sandbox frame height (browser)',
  () => {
    let server: Server;
    let origin = '';
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    const pages = new Map<string, string>();

    beforeAll(async () => {
      server = createServer((request, response) => {
        const body = pages.get(request.url ?? '') ?? 'not found';
        response.writeHead(pages.has(request.url ?? '') ? 200 : 404, {
          'content-type': 'text/html; charset=utf-8',
        });
        response.end(body);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      browser = await chromium.launch({
        executablePath: executablePath as string,
        headless: true,
        args: ['--no-sandbox'],
      });
    }, 30_000);

    afterAll(async () => {
      await browser?.close();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    });

    async function open(path: string, html: string, css = ''): Promise<Page> {
      const srcdoc = buildSandboxDocument(
        { html, css },
        { token: TOKEN, hostOrigin: origin, mode: 'live', inlineJs: true },
      );
      pages.set(path, hostPage(srcdoc));
      const page = await browser.newPage();
      await page.goto(`${origin}${path}`);
      return page;
    }

    const frameHeight = (page: Page) =>
      page.evaluate(() => (document.getElementById('frame') as HTMLIFrameElement).offsetHeight);

    it('shrinks from the initial height to a short view', async () => {
      const page = await open('/short', '<div style="height:120px;background:#eee">short</div>');
      try {
        await page.waitForFunction(
          () => (document.getElementById('frame') as HTMLIFrameElement).offsetHeight < 200,
          undefined,
          { timeout: 5_000 },
        );
        expect(await frameHeight(page)).toBe(120);
      } finally {
        await page.close();
      }
    });

    it('follows the content up and back down', async () => {
      const page = await open('/grow', '<div id="box" style="height:100px">box</div>');
      try {
        await page.waitForFunction(
          () => (document.getElementById('frame') as HTMLIFrameElement).offsetHeight === 100,
          undefined,
          { timeout: 5_000 },
        );
        await page.evaluate(() =>
          (window as unknown as { run(code: string): void }).run(
            "document.getElementById('box').style.height='800px'",
          ),
        );
        await page.waitForFunction(
          () => (document.getElementById('frame') as HTMLIFrameElement).offsetHeight === 800,
          undefined,
          { timeout: 5_000 },
        );
        await page.evaluate(() =>
          (window as unknown as { run(code: string): void }).run(
            "document.getElementById('box').style.height='150px'",
          ),
        );
        await page.waitForFunction(
          () => (document.getElementById('frame') as HTMLIFrameElement).offsetHeight === 150,
          undefined,
          { timeout: 5_000 },
        );
      } finally {
        await page.close();
      }
    });

    it('measures the content even when the page is sized to the viewport', async () => {
      // Generated CSS often sets `html,body{height:100%}`: the body is then as tall as the frame.
      const page = await open(
        '/full',
        '<main style="margin:16px 0;height:180px">card</main>',
        'html,body{height:100%}',
      );
      try {
        await page.waitForFunction(
          () => (document.getElementById('frame') as HTMLIFrameElement).offsetHeight < 600,
          undefined,
          { timeout: 5_000 },
        );
        // The card plus its vertical margins.
        expect(await frameHeight(page)).toBe(212);
      } finally {
        await page.close();
      }
    });

    it('re-measures when a stylesheet arrives later (Tailwind injecting its CSS)', async () => {
      const page = await open('/late-css', '<div class="tall">late</div>');
      try {
        await page.waitForFunction(
          () => (document.getElementById('frame') as HTMLIFrameElement).offsetHeight < 100,
          undefined,
          { timeout: 5_000 },
        );
        // What the Tailwind runtime does: a <style> element appended to <head> after load.
        await page.evaluate(() =>
          (window as unknown as { run(code: string): void }).run(
            "var s=document.createElement('style');s.textContent='.tall{height:333px}';document.head.appendChild(s)",
          ),
        );
        await page.waitForFunction(
          () => (document.getElementById('frame') as HTMLIFrameElement).offsetHeight === 333,
          undefined,
          { timeout: 5_000 },
        );
      } finally {
        await page.close();
      }
    });
  },
  60_000,
);
