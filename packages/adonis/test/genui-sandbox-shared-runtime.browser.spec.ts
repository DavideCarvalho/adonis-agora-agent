import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Frame, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSandboxKitBundle } from '../src/genui/kit/bundle.js';
import { resolveSandboxKitFiles } from '../src/genui/kit/files.js';
import { buildSandboxKitStyles, purgeSandboxKitStyles } from '../src/genui/kit/styles.js';

/*
 * The sandbox renderer as an app ships it — bundled and MINIFIED by the consumer's build (esbuild,
 * React in production mode) — drawing several sandboxes on one page in a real Chromium:
 *
 * - shared assets (the default): the page fetches the kit, its styles and the Tailwind runtime once,
 *   each frame's `srcdoc` carries none of them, asks for them (`load`) and gets their text; every
 *   frame draws, in the kit's styles, with utilities the runtime generates; the CSP is the inline one;
 * - `assets: 'inline'` still draws the same;
 * - an overlay taller than the content (a modal dialog) grows the frame while it is open, and the
 *   frame shrinks back once it closes.
 *
 * Opt in with a host browser path (GENUI_CHROMIUM_PATH), like the other browser specs.
 */
const executablePath = process.env.GENUI_CHROMIUM_PATH;
const enabled = executablePath !== undefined && existsSync(executablePath);
const here = fileURLToPath(new URL('.', import.meta.url));
const variants = join(here, 'fixtures/sandbox-kit-variants');

const APP = `function App() {
  const [people, setPeople] = useState(3)
  return (<div className="p-6">
    <Button id="add" onClick={() => setPeople(people + 1)}>Add</Button>
    <p id="title" className="kit-title underline decoration-wavy">Split between {people}</p>
  </div>)
}`;

const DIALOG_HTML = `<div id="content" style="height:80px">Short view</div>
<button id="open" onclick="document.getElementById('overlay').style.display='flex'">Details</button>
<div id="overlay" style="display:none;position:fixed;inset:0;align-items:center;justify-content:center;background:rgba(0,0,0,.4)">
  <div role="dialog" id="paper" style="margin:32px;max-height:calc(100% - 64px);overflow-y:auto;background:#fff;width:300px">
    <div style="height:520px">A tall dialog</div>
    <button id="close" onclick="document.getElementById('overlay').style.display='none'">Close</button>
  </div>
</div>`;

const MODAL_HTML = `<p style="margin:0;height:60px">Short view</p>
<button id="open-modal" onclick="document.getElementById('modal').showModal()">Open</button>
<dialog id="modal"><div style="height:400px">A native modal dialog</div>
<button id="close-modal" onclick="document.getElementById('modal').close()">Close</button></dialog>`;

/** The consumer's host page entry: N sandboxes through the library's renderer. */
const HOST_ENTRY = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { createSandboxRenderer } from '../src/react/core/genui/sandbox.js';
const config = window.__config;
window.errors = [];
const onError = (message) => window.errors.push(message);
const Shared = createSandboxRenderer({ config, onError });
const Inline = createSandboxRenderer({ config, onError, assets: 'inline' });
function Host() {
  return h('div', null, window.__views.map((view, index) =>
    h('div', { key: index, id: 'slot' + index, style: { width: 600 } },
      h(view.inline ? Inline : Shared, view.props))));
}
createRoot(document.getElementById('root')).render(h(Host));
`;

describe.skipIf(!enabled)(
  'sandbox frames sharing one runtime, from a minified consumer build (browser)',
  () => {
    let server: Server;
    let origin = '';
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    const assets = new Map<string, { type: string; body: string }>();
    const requests = new Map<string, number>();
    let hostScript = '';
    let fullCss = '';

    beforeAll(async () => {
      const esbuild = await import('esbuild');
      const built = await esbuild.build({
        stdin: { contents: HOST_ENTRY, resolveDir: here, loader: 'js' },
        bundle: true,
        minify: true,
        format: 'iife',
        platform: 'browser',
        target: 'es2020',
        define: { 'process.env.NODE_ENV': '"production"' },
        write: false,
        logLevel: 'silent',
      });
      hostScript = built.outputFiles[0]?.text ?? '';
      const styles = await buildSandboxKitStyles({
        root: variants,
        entries: [join(variants, 'tailwind/styles.css')],
        plugins: [(await import('@tailwindcss/vite')).default()],
      });
      const files = resolveSandboxKitFiles(variants, { components: 'tailwind/button.tsx' });
      if (styles?.tailwind === undefined || files === null) throw new Error('no kit');
      const kit = await buildSandboxKitBundle({ root: variants, files });
      // As the plugin ships them: purged against the kit's own code.
      fullCss = styles.css;
      const purged = purgeSandboxKitStyles(styles, { kitCode: kit.code });
      assets.set('/kit.js', { type: 'text/javascript', body: kit.code });
      assets.set('/styles.css', { type: 'text/css', body: purged.css });
      assets.set('/tailwind.js', {
        type: 'text/javascript',
        body: readFileSync(createRequire(import.meta.url).resolve('@tailwindcss/browser'), 'utf8'),
      });
      assets.set('/host.js', { type: 'text/javascript', body: hostScript });
      const config = {
        theme: true,
        kit: { url: '/kit.js' },
        css: { url: '/styles.css' },
        tailwind: { url: '/tailwind.js', css: styles.tailwind.directives },
      };
      server = createServer((request, response) => {
        const url = (request.url ?? '').split('?')[0] ?? '';
        requests.set(url, (requests.get(url) ?? 0) + 1);
        const asset = assets.get(url);
        if (asset !== undefined) {
          response.writeHead(200, { 'content-type': asset.type });
          response.end(asset.body);
          return;
        }
        const views = pages.get(url);
        if (views === undefined) {
          response.writeHead(404);
          response.end('not found');
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html><html><head><style>:root{--primary:rgb(79, 70, 229)}</style></head><body style="margin:0">
<div id="root"></div>
<script>window.__config=${JSON.stringify(config).replace(/</g, '\\u003c')};window.__views=${JSON.stringify(views).replace(/</g, '\\u003c')};</script>
<script src="/host.js"></script></body></html>`);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      browser = await chromium.launch({
        executablePath: executablePath as string,
        headless: true,
        args: ['--no-sandbox'],
      });
    }, 180_000);

    afterAll(async () => {
      await browser?.close();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    });

    const pages = new Map<string, { props: Record<string, unknown>; inline?: boolean }[]>();

    async function open(
      path: string,
      views: { props: Record<string, unknown>; inline?: boolean }[],
    ): Promise<{ page: Page; frames: Frame[] }> {
      pages.set(path, views);
      requests.clear();
      const page = await browser.newPage();
      await page.goto(`${origin}${path}`);
      await page.waitForFunction(
        (count) => document.querySelectorAll('iframe[data-sandbox-phase="live"]').length === count,
        views.length,
        { timeout: 20_000 },
      );
      const handles = await page.$$('iframe');
      const frames: Frame[] = [];
      for (const handle of handles) {
        let frame: Frame | null = null;
        const deadline = Date.now() + 5_000;
        while (frame === null && Date.now() < deadline) {
          frame = await handle.contentFrame();
          if (frame === null) await page.waitForTimeout(20);
        }
        if (frame === null) throw new Error('no frame');
        frames.push(frame);
      }
      return { page, frames };
    }

    const style = (frame: Frame, selector: string, property: string) =>
      frame.evaluate(
        ([sel, prop]) => {
          const element = document.querySelector(sel as string);
          return element === null
            ? null
            : getComputedStyle(element).getPropertyValue(prop as string);
        },
        [selector, property],
      );

    const frameHeight = (page: Page, index: number) =>
      page.evaluate(
        (i) => document.querySelectorAll('iframe')[i]?.getBoundingClientRect().height ?? 0,
        index,
      );

    it('the purge took out utilities the kit does not use, and kept its own', () => {
      const purged = assets.get('/styles.css')?.body ?? '';
      expect(purged.length).toBeLessThan(fullCss.length);
      // The kit's Button names `px-3`: kept. Its components layer (`kit-title`) and @font-face stay.
      expect(purged).toContain('.px-3');
      expect(purged).toContain('.kit-title');
      expect(purged).toContain('@font-face');
    });

    it('five frames share the page’s one copy of each asset, and every one draws in the kit’s styles', async () => {
      const views = Array.from({ length: 5 }, () => ({ props: { jsx: APP } }));
      const { page, frames } = await open('/five', views);
      try {
        for (const frame of frames) {
          await frame.waitForSelector('#title');
          await frame.waitForFunction(
            () =>
              getComputedStyle(document.getElementById('add') as Element).backgroundColor ===
              'rgb(79, 70, 229)',
            undefined,
            { timeout: 15_000 },
          );
          // A utility the kit never names (purged from its CSS) — generated in the frame by the runtime.
          expect(await style(frame, '.p-6', 'padding-top')).toBe('24px');
          expect(await style(frame, '#title', 'text-decoration-style')).toBe('wavy');
          // The components layer, from the shared stylesheet.
          expect(await style(frame, '#title', 'font-weight')).toBe('700');
          // State works: the kit's React runs in each frame on its own.
          await frame.click('#add');
          await frame.waitForFunction(() =>
            document.getElementById('title')?.textContent?.includes('4'),
          );
        }
        // One fetch per asset for the whole page.
        expect(requests.get('/kit.js')).toBe(1);
        expect(requests.get('/styles.css')).toBe(1);
        expect(requests.get('/tailwind.js')).toBe(1);
        // Each document is small: no kit, no runtime, no stylesheet inlined in it.
        const docs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('iframe'), (frame) => frame.srcdoc),
        );
        const kit = assets.get('/kit.js')?.body ?? '';
        for (const doc of docs) {
          expect(doc.length).toBeLessThan(40_000);
          expect(doc).not.toContain(kit.slice(200, 400));
          // The same CSP as an inlined document: inline code only, no blob:, no network.
          const csp = /Content-Security-Policy" content="([^"]*)"/.exec(doc)?.[1] ?? '';
          expect(csp).toContain("script-src 'unsafe-inline';");
          expect(csp).toContain("connect-src 'none'");
        }
        expect(
          await page.evaluate(() => (window as unknown as { errors: string[] }).errors),
        ).toEqual([]);
        await page.screenshot({ path: '/tmp/genui-shared-runtime-five.png', fullPage: true });
      } finally {
        await page.close();
      }
    }, 120_000);

    it("`assets: 'inline'` draws the same, with every asset in its srcdoc", async () => {
      const { page, frames } = await open('/inline', [{ props: { jsx: APP }, inline: true }]);
      try {
        const frame = frames[0] as Frame;
        await frame.waitForSelector('#title');
        await frame.waitForFunction(
          () =>
            getComputedStyle(document.getElementById('add') as Element).backgroundColor ===
            'rgb(79, 70, 229)',
          undefined,
          { timeout: 15_000 },
        );
        expect(await style(frame, '.p-6', 'padding-top')).toBe('24px');
        const doc = await page.evaluate(() => document.querySelector('iframe')?.srcdoc ?? '');
        expect(doc.length).toBeGreaterThan(200_000);
      } finally {
        await page.close();
      }
    }, 120_000);

    it('a dialog taller than the view grows the frame while it is open, and the frame shrinks back', async () => {
      const { page, frames } = await open('/dialog', [
        { props: { html: DIALOG_HTML } },
        { props: { html: MODAL_HTML } },
      ]);
      try {
        const [overlay, modal] = frames as [Frame, Frame];
        await overlay.waitForSelector('#open');
        await page.waitForFunction(
          () => (document.querySelector('iframe')?.getBoundingClientRect().height ?? 0) < 200,
        );
        // Settled (the height eases in over 120ms).
        await page.waitForTimeout(500);
        const before = await frameHeight(page, 0);
        await overlay.click('#open');
        // The dialog's full content (520px + its button) and its 32px margins.
        await page.waitForFunction(
          () => (document.querySelector('iframe')?.getBoundingClientRect().height ?? 0) >= 584,
          undefined,
          { timeout: 5_000 },
        );
        await page.waitForTimeout(400);
        const open = await frameHeight(page, 0);
        expect(open).toBeGreaterThanOrEqual(584);
        expect(open).toBeLessThan(700);
        // Nothing of the dialog is cut off: its paper shows whole, without a scrollbar of its own.
        expect(
          await overlay.evaluate(() => {
            const paper = document.getElementById('paper') as HTMLElement;
            return paper.scrollHeight <= paper.clientHeight + 1;
          }),
        ).toBe(true);
        await page.screenshot({ path: '/tmp/genui-sandbox-dialog-open.png', fullPage: true });
        await overlay.click('#close');
        await page.waitForFunction(
          (height) =>
            (document.querySelector('iframe')?.getBoundingClientRect().height ?? 0) <= height + 2,
          before,
          { timeout: 5_000 },
        );

        // A native <dialog> opened as a modal (the top layer, centered): the same.
        await modal.waitForSelector('#open-modal');
        await page.waitForTimeout(500);
        const modalBefore = await frameHeight(page, 1);
        expect(modalBefore).toBeLessThan(150);
        await modal.click('#open-modal');
        await page.waitForFunction(
          () =>
            (document.querySelectorAll('iframe')[1]?.getBoundingClientRect().height ?? 0) >= 400,
          undefined,
          { timeout: 5_000 },
        );
        await page.waitForTimeout(400);
        const modalOpen = await frameHeight(page, 1);
        expect(modalOpen).toBeLessThan(560);
        expect(
          await modal.evaluate(() => {
            const dialog = document.getElementById('modal') as HTMLElement;
            const rect = dialog.getBoundingClientRect();
            return rect.top >= 0 && rect.bottom <= window.innerHeight + 1;
          }),
        ).toBe(true);
        await modal.click('#close-modal');
        await page.waitForFunction(
          (height) =>
            (document.querySelectorAll('iframe')[1]?.getBoundingClientRect().height ?? 0) <=
            height + 2,
          modalBefore,
          { timeout: 5_000 },
        );
      } finally {
        await page.close();
      }
    }, 120_000);
  },
  240_000,
);
