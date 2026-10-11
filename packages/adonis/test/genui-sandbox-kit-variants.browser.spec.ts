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
import { buildSandboxKitStyles } from '../src/genui/kit/styles.js';
import { buildSandboxDocument, type SandboxDocumentOptions } from '../src/genui/sandbox.js';

/*
 * The three kinds of design system the kit takes, each rendered in a real sandbox frame
 * (`sandbox="allow-scripts"`, the CSP, no network) from what `genuiSandboxKit()` builds:
 *
 * - Tailwind v4 + a component: classes the app never used are generated in the frame, from the app's
 *   theme; its compiled CSS (components layer) and its `@utility` apply;
 * - Bootstrap 5 through Sass, CSS only: the model's HTML uses Bootstrap's classes, overrides kept;
 * - MUI with a customized theme, through `wrapper`: emotion injects into the frame's own document,
 *   CssBaseline and the theme apply, and a Menu's portal opens inside the frame.
 *
 * Opt in with a host browser path (GENUI_CHROMIUM_PATH), like the other browser specs.
 */
const executablePath = process.env.GENUI_CHROMIUM_PATH;
const enabled = executablePath !== undefined && existsSync(executablePath);
const variants = fileURLToPath(new URL('./fixtures/sandbox-kit-variants', import.meta.url));
const TOKEN = 'variants-token';

function hostPage(srcdoc: string): string {
  return `<!doctype html><html><body style="margin:0">
<iframe id="frame" sandbox="allow-scripts" style="display:block;width:640px;border:0;height:480px"></iframe>
<script>
const frame = document.getElementById('frame');
window.errors = [];
window.addEventListener('message', (event) => {
  const data = event.data;
  if (event.source !== frame.contentWindow || !data || data.token !== ${JSON.stringify(TOKEN)}) return;
  if (data.type === 'agora:sandbox:error') window.errors.push(data.message);
});
frame.srcdoc = ${JSON.stringify(srcdoc).replace(/</g, '\\u003c')};
</script></body></html>`;
}

describe.skipIf(!enabled)(
  'the sandbox kit, three design systems (browser)',
  () => {
    let server: Server;
    let origin = '';
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    const pages = new Map<string, string>();
    const tailwindRuntime = readFileSync(
      createRequire(import.meta.url).resolve('@tailwindcss/browser'),
      'utf8',
    );

    beforeAll(async () => {
      server = createServer((request, response) => {
        const body = pages.get(request.url ?? '');
        response.writeHead(body === undefined ? 404 : 200, {
          'content-type': 'text/html; charset=utf-8',
        });
        response.end(body ?? 'not found');
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

    async function open(
      path: string,
      props: { html?: string; css?: string },
      options: Omit<SandboxDocumentOptions, 'token' | 'hostOrigin' | 'mode'>,
    ): Promise<{ page: Page; frame: Frame }> {
      pages.set(
        path,
        hostPage(
          buildSandboxDocument(props, {
            token: TOKEN,
            hostOrigin: origin,
            mode: 'live',
            ...options,
          }),
        ),
      );
      const page = await browser.newPage();
      await page.goto(`${origin}${path}`);
      const handle = await page.waitForSelector('#frame');
      let frame: Frame | null = null;
      const deadline = Date.now() + 5_000;
      while (frame === null && Date.now() < deadline) {
        frame = await handle.contentFrame();
        if (frame === null) await page.waitForTimeout(20);
      }
      if (frame === null) throw new Error('no frame');
      return { page, frame };
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

    it('Tailwind v4 + components: new classes from the app theme, its utilities, its compiled CSS', async () => {
      const styles = await buildSandboxKitStyles({
        root: variants,
        entries: [join(variants, 'tailwind/styles.css')],
        plugins: [(await import('@tailwindcss/vite')).default()],
      });
      const files = resolveSandboxKitFiles(variants, { components: 'tailwind/button.tsx' });
      if (styles?.tailwind === undefined || files === null) throw new Error('no kit');
      const kit = await buildSandboxKitBundle({ root: variants, files });
      const { page, frame } = await open(
        '/tailwind',
        {},
        {
          styles: styles.css,
          tailwind: { runtime: tailwindRuntime, theme: styles.tailwind.directives },
          kit: kit.code,
          initialJsx: {
            final: true,
            code: `function App() {
  return (<div className="p-4">
    <Button id="pay" className="kit-ring">Pay</Button>
    <p id="title" className="kit-title font-sans text-primary underline decoration-wavy">Split</p>
  </div>)
}`,
          },
        },
      );
      try {
        await frame.waitForSelector('#title');
        await frame.waitForFunction(
          () =>
            getComputedStyle(document.getElementById('title') as Element).color ===
            'rgb(79, 70, 229)',
          undefined,
          { timeout: 10_000 },
        );
        expect(await style(frame, '#pay', 'background-color')).toBe('rgb(79, 70, 229)');
        expect(await style(frame, '#pay', 'border-top-left-radius')).toBe('12px');
        expect(await style(frame, '#pay', 'box-shadow')).toContain(
          'rgb(79, 70, 229) 0px 0px 0px 3px',
        );
        expect(await style(frame, '#title', 'font-weight')).toBe('700');
        expect(await style(frame, '#title', 'text-decoration-style')).toBe('wavy');
        // The app's @font-face (fontsource's woff2, url()s inlined as data: URIs) loads under the CSP.
        expect(
          await frame.evaluate(async () => {
            await document.fonts.load('16px "Geist Variable"');
            return (
              document.fonts.check('16px "Geist Variable"') &&
              Array.from(document.fonts as unknown as Iterable<FontFace>).some(
                (face) => face.family.includes('Geist') && face.status === 'loaded',
              )
            );
          }),
        ).toBe(true);
        expect(await style(frame, '#title', 'font-family')).toContain('Geist Variable');
        expect(
          await page.evaluate(() => (window as unknown as { errors: string[] }).errors),
        ).toEqual([]);
        await page.screenshot({ path: '/tmp/kit-browser-tailwind.png' });
      } finally {
        await page.close();
      }
    }, 120_000);

    it('Bootstrap 5 (Sass, CSS only): the HTML uses its classes, with the overrides', async () => {
      const styles = await buildSandboxKitStyles({
        root: variants,
        entries: [join(variants, 'bootstrap/styles.scss')],
      });
      if (styles === null) throw new Error('no styles');
      const { page, frame } = await open(
        '/bootstrap',
        {
          html: `<div class="card"><div class="card-body"><h5 class="card-title">Split the bill</h5>
<div class="input-group mb-3"><span class="input-group-text">$</span><input id="total" class="form-control" value="120"></div>
<button id="settle" class="btn btn-primary">Settle</button></div></div>`,
        },
        { styles: styles.css },
      );
      try {
        await frame.waitForSelector('#settle');
        expect(await style(frame, '#settle', 'background-color')).toBe('rgb(124, 58, 237)');
        expect(await style(frame, '#settle', 'border-top-left-radius')).toBe('12px');
        expect(await style(frame, 'body', 'font-family')).toContain('Georgia');
        expect(await style(frame, '#total', 'display')).toBe('block');
        expect(await style(frame, '.card', 'border-top-style')).toBe('solid');
        await page.screenshot({ path: '/tmp/kit-browser-bootstrap.png' });
      } finally {
        await page.close();
      }
    }, 120_000);

    it('MUI through `wrapper`: theme, CssBaseline and emotion in the frame; a Menu portal opens inside it', async () => {
      const files = resolveSandboxKitFiles(variants, {
        components: 'mui/components.tsx',
        wrapper: 'mui/wrapper.tsx',
      });
      if (files === null) throw new Error('no kit');
      const kit = await buildSandboxKitBundle({ root: variants, files });
      const { page, frame } = await open(
        '/mui',
        {},
        {
          kit: kit.code,
          initialJsx: {
            final: true,
            code: `function App() {
  const [anchor, setAnchor] = useState(null)
  return (
    <Card><CardContent>
      <Typography variant="h5" id="heading">Split the bill</Typography>
      <PriceTag id="price">$40.00</PriceTag>
      <Button id="open" variant="contained" onClick={(e) => setAnchor(e.currentTarget)}>Options</Button>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        <MenuItem id="item" onClick={() => setAnchor(null)}>Even split</MenuItem>
      </Menu>
    </CardContent></Card>
  )
}`,
          },
        },
      );
      try {
        await frame.waitForSelector('#open');
        expect(await style(frame, '#open', 'background-color')).toBe('rgb(0, 137, 123)');
        expect(await style(frame, '#open', 'border-top-left-radius')).toBe('14px');
        expect(await style(frame, '#heading', 'font-family')).toContain('Georgia');
        expect(await style(frame, '#price', 'color')).toBe('rgb(0, 137, 123)');
        // CssBaseline paints the body in the theme's background — the frame's page stays
        // see-through (no box of that colour beside a card narrower than the frame) while the
        // card keeps its own surface.
        expect(await style(frame, 'body', 'background-color')).toBe('rgba(0, 0, 0, 0)');
        expect(await style(frame, 'html', 'background-color')).toBe('rgba(0, 0, 0, 0)');
        expect(await style(frame, '.MuiCard-root', 'background-color')).not.toBe(
          'rgba(0, 0, 0, 0)',
        );
        expect(
          await frame.evaluate(() => {
            const sheet = Array.from(
              document.querySelectorAll('style[data-emotion]'),
              (s) => s.textContent,
            ).join('');
            return (
              sheet.includes('rgb(255, 251, 234)') ||
              sheet.includes('#fffbea') ||
              sheet.includes('#FFFBEA')
            );
          }),
        ).toBe(true);
        expect(
          await frame.evaluate(() => document.head.querySelectorAll('style[data-emotion]').length),
        ).toBeGreaterThan(0);
        await frame.click('#open');
        await frame.waitForSelector('#item');
        // The portal is the frame's: in its body, outside the root the App renders into.
        expect(
          await frame.evaluate(() => {
            const item = document.getElementById('item');
            const paper = item?.closest('.MuiMenu-paper');
            return (
              paper !== null &&
              paper !== undefined &&
              !document.getElementById('agora-sandbox-root')?.contains(paper) &&
              document.body.contains(paper)
            );
          }),
        ).toBe(true);
        expect(
          await page.evaluate(() => (window as unknown as { errors: string[] }).errors),
        ).toEqual([]);
        await page.screenshot({ path: '/tmp/kit-browser-mui.png' });
      } finally {
        await page.close();
      }
    }, 120_000);
  },
  180_000,
);
