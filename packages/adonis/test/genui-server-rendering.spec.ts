import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../src/ai-tool-ref.js';
import { createComponent } from '../src/genui/index.js';
import { createNegotiatedUiCollector } from '../src/negotiated-tool-ui.js';
import { createReactComponentRegistry } from '../src/react/genui/index.js';
import { createReactServerRenderer } from '../src/react/genui/server.js';
import { createPlaywrightCaptureAdapter } from '../src/react/genui/server_playwright.js';
import { DefaultRolesPolicy, ToolRegistry } from '../src/tool-registry.js';

describe('shared server rendering entrypoints', () => {
  it('re-exports optional capture without opening a browser', () => {
    expect(typeof createPlaywrightCaptureAdapter).toBe('function');
    expect(typeof createPlaywrightCaptureAdapter().images).toBe('function');
  });

  it('renders the app component through the shared registry with escaped props', async () => {
    const History = createComponent<{ label: string }>({
      name: 'History',
      title: 'History',
      description: 'History',
      props: z.object({ label: z.string() }),
      fallbackText: ({ label }) => label,
    });
    const components = createReactComponentRegistry().register(History.definition, {
      react: ({ label }) => createElement('section', { className: 'history' }, label),
    });
    const renderer = createReactServerRenderer({
      registry: components,
      stylesheet: '.history { color: teal }',
    });
    const html = await renderer.html(await History({ label: '<script>invalid</script>' }));
    expect(html).toContain(
      '<section class="history">&lt;script&gt;invalid&lt;/script&gt;</section>',
    );
    expect(html).toContain('.history { color: teal }');
    expect(components.manifest).toMatchObject([{ name: 'History', version: 1 }]);
  });

  it('emits normalized props through the authorized shared catalog exactly once', async () => {
    const History = createComponent<{ label: string }>({
      name: 'History',
      title: 'History',
      description: 'History',
      props: z.object({ label: z.string().transform((label) => `${label}!`) }),
      outputProps: z.object({ label: z.string() }),
      fallbackText: ({ label }) => label,
    });
    const components = createReactComponentRegistry().register(History.definition, {
      react: ({ label }) => createElement('p', null, label),
    });
    const tool = defineTool({
      name: 'history',
      description: 'History',
      input: z.object({ label: z.string() }),
      execute: ({ label }) => ({ label }),
      present: (result) => History(result),
    });
    const registry = new ToolRegistry();
    registry.register(tool.spec, tool.handler);
    const actor = { id: 'actor' };
    const uiCapabilities = { components: [{ name: 'History', version: 1 }] };
    const collector = createNegotiatedUiCollector(
      'call',
      { actor, uiCapabilities },
      () => components.catalog,
    );
    const result = await registry.invoke(
      'history',
      { label: 'Once' },
      {
        actor,
        uiCapabilities,
        runId: 'run',
        threadId: 'thread',
        requestId: 'request',
        emitUi: collector.emit,
      },
      new DefaultRolesPolicy(),
    );
    expect(result).toEqual({ label: 'Once' });
    expect(collector.components()[0]).toMatchObject({
      component: 'History',
      props: { label: 'Once!' },
      fallbackText: 'Once!',
    });
    const item = collector.components()[0]!;
    expect(
      await createReactServerRenderer({ registry: components }).html({
        component: item.component,
        props: item.props,
        version: item.version!,
        fallbackText: item.fallbackText!,
      }),
    ).toContain('<p>Once!</p>');
  });
});
