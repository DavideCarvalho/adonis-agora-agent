import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createElement } from 'react';
import { expect, it } from 'vitest';
import { DataTable } from '../src/genui/builtins.js';
import { createComponent } from '../src/genui/index.js';
import { createPlaywrightCaptureAdapter } from '../src/react/core/genui/playwright.js';
import { createReactComponentRegistry } from '../src/react/core/genui/react-registry.js';
import { createReactServerRenderer } from '../src/react/core/genui/server.js';

// Opt in with a host browser path; CI without Chromium still runs SSR/lifecycle suites.
const executablePath = process.env.GENUI_CHROMIUM_PATH;
it.skipIf(!executablePath || !existsSync(executablePath))(
  'captures real table PNG/PDF and retains caller browser',
  async () => {
    if (!executablePath) throw new Error('Set GENUI_CHROMIUM_PATH');
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox'],
    });
    try {
      const capture = createPlaywrightCaptureAdapter({ browser });
      const registry = createReactComponentRegistry().register(DataTable, {
        react: (props) =>
          createElement(
            'table',
            null,
            createElement(
              'tbody',
              null,
              (props.rows as { name: string }[]).map((row) =>
                createElement('tr', { key: row.name }, createElement('td', null, row.name)),
              ),
            ),
          ),
      });
      const renderer = createReactServerRenderer({
        registry,
        capture,
        stylesheet:
          'body {margin:32px;font:24px sans-serif;background:#fafafa}table{width:100%;border-collapse:collapse}td{padding:12px;border-bottom:1px solid #ddd}',
      });
      const presentation = await createComponent(DataTable)({
        columns: [{ key: 'name', label: 'Name' }],
        rows: Array.from({ length: 5 }, (_, i) => ({ name: `Exam record ${i + 1}` })),
      });
      const images = await renderer.images(presentation, {
        rowsPerPage: 3,
        width: 800,
        height: 600,
      });
      expect(images).toHaveLength(2);
      expect(Array.from(images[0]?.slice(0, 8) ?? [])).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const pdf = await renderer.pdf(presentation, { rowsPerPage: 3, width: 800, height: 600 });
      expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-');
      expect(new TextDecoder().decode(pdf)).toMatch(/\/Count 2\b/);
      await expect(
        capture.images(['<div style="height:900px">too tall</div>'], { width: 800, height: 600 }),
      ).rejects.toThrow(/height/);
      expect(browser.isConnected()).toBe(true);
      expect(browser.contexts()).toHaveLength(0);
      const preview = images[0];
      if (!preview) throw new Error('Missing PNG preview');
      await writeFile('/tmp/agora-genui-table-preview.png', preview);
      await writeFile('/tmp/agora-genui-table-preview.pdf', pdf);
      await expect(
        capture.images(['<script>document.body.textContent="evil"</script><p>safe</p>'], {
          width: 800,
          height: 600,
        }),
      ).resolves.toHaveLength(1);
    } finally {
      await browser.close();
    }
  },
  30000,
);
