// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SANDBOX_MESSAGE } from '../../../src/genui/index.js';
import { GenerativeUI } from '../../../src/react/core/genui/generative-ui.js';
import { createSandboxRenderer } from '../../../src/react/core/genui/sandbox.js';

const THEME_CSS = `:root { --background: oklch(1 0 0); --primary: oklch(0.7 0.15 80); --radius: 0.5rem; }
[data-theme='dark'] { --background: oklch(0.15 0 0); }`;

function frame(): HTMLIFrameElement {
  return screen.getByTestId('sandbox-frame') as HTMLIFrameElement;
}

function ready(target: HTMLIFrameElement) {
  const token = /var T="([0-9a-f]+)"/.exec(target.srcdoc)?.[1];
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { token, type: SANDBOX_MESSAGE.ready },
      origin: 'null',
      source: target.contentWindow,
    }),
  );
}

function setHostTheme(css: string) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  return style;
}

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.className = '';
  document.documentElement.style.cssText = '';
  for (const style of Array.from(document.head.querySelectorAll('style'))) style.remove();
  vi.restoreAllMocks();
});

describe('theme injection', () => {
  it("puts the host's custom properties on the frame, and follows a data-theme switch", async () => {
    setHostTheme(THEME_CSS);
    // jsdom computes custom properties from :root rules; the switch is mirrored as dark/light.
    document.documentElement.style.setProperty('--primary', 'oklch(0.7 0.15 80)');
    const View = createSandboxRenderer({ config: { theme: true } });
    render(<View html="<p>hi</p>" title="Split" />);
    const iframe = frame();
    expect(iframe.srcdoc).toContain('<style id="agora-sandbox-theme">:root{color-scheme:light;');
    expect(iframe.srcdoc).toContain('--primary:oklch(0.7 0.15 80)');
    expect(iframe.srcdoc).toContain('data-theme="light"');

    const posted: unknown[] = [];
    vi.spyOn(iframe.contentWindow as Window, 'postMessage').mockImplementation((message) => {
      posted.push(message);
    });
    ready(iframe);
    act(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    await waitFor(() =>
      expect(posted).toContainEqual(
        expect.objectContaining({ type: SANDBOX_MESSAGE.theme, dark: true }),
      ),
    );
    const last = posted
      .filter((m) => (m as { type: string }).type === SANDBOX_MESSAGE.theme)
      .at(-1) as {
      css: string;
    };
    expect(last.css).toContain('color-scheme:dark');
    // The frame was not rebuilt for it.
    expect(frame()).toBe(iframe);
  });

  it('theme: false leaves the host theme out', () => {
    setHostTheme(THEME_CSS);
    const View = createSandboxRenderer({ config: false, theme: false });
    render(<View html="<p>hi</p>" />);
    expect(frame().srcdoc).toContain('<style id="agora-sandbox-theme"></style>');
  });
});

describe('Tailwind and the kit', () => {
  const assets: Record<string, string> = {
    '/assets/tw.js': '/*tailwind runtime*/',
    '/assets/kit.js': 'window.Kit={Button:function(){}};window.React={};window.ReactDOM={};',
  };
  function serveAssets() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const body = assets[String(url)];
      return new Response(body ?? 'missing', { status: body === undefined ? 404 : 200 });
    });
  }

  it('inlines the Tailwind runtime with an @theme mapped from the host', async () => {
    setHostTheme(THEME_CSS);
    serveAssets();
    const View = createSandboxRenderer({
      config: { theme: true, tailwind: { url: '/assets/tw.js' } },
    });
    render(<View html='<div class="bg-primary">hi</div>' />);
    await waitFor(() => expect(frame().srcdoc).toContain('/*tailwind runtime*/'));
    expect(frame().srcdoc).toContain('--color-primary: var(--primary)');
  });

  it('draws JSX in one frame with the kit inlined, posting the code as it streams', async () => {
    serveAssets();
    const View = createSandboxRenderer({
      config: { theme: true, kit: { url: '/assets/kit.js', hash: 'abc' } },
    });
    const registry = { Sandbox: View };
    const part = (jsx: string, incomplete: boolean) => ({
      id: 'ui1',
      component: 'genui:tree',
      props: {
        root: {
          id: 'root',
          type: 'Sandbox',
          props: { title: 'Split', jsx },
          ...(incomplete ? { incomplete: true } : {}),
        },
      },
      ...(incomplete ? { partial: true } : {}),
    });
    const { rerender } = render(
      <GenerativeUI part={part('function App() { return <Button>', true)} registry={registry} />,
    );
    await waitFor(() => expect(frame().getAttribute('data-sandbox-phase')).toBe('preview'));
    const iframe = frame();
    expect(iframe.srcdoc).toContain('window.Kit={Button');
    expect(iframe.srcdoc).toContain('id="agora-sandbox-root"');
    expect(iframe.srcdoc).toContain('function transpileJsx');
    const posted: unknown[] = [];
    vi.spyOn(iframe.contentWindow as Window, 'postMessage').mockImplementation((message) => {
      posted.push(message);
    });
    ready(iframe);
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: SANDBOX_MESSAGE.jsx,
        code: 'function App() { return <Button>',
        final: false,
      }),
    );
    rerender(
      <GenerativeUI
        part={part('function App() { return <Button>Go</Button> }', false)}
        registry={registry}
      />,
    );
    await waitFor(() => expect(frame().getAttribute('data-sandbox-phase')).toBe('live'));
    // Same frame: the live view continues the preview.
    expect(frame()).toBe(iframe);
    expect(posted.at(-1)).toMatchObject({ type: SANDBOX_MESSAGE.jsx, final: true });
  });

  it('JSX without a kit shows the summary instead', async () => {
    const View = createSandboxRenderer({ config: { theme: true } });
    render(<View jsx="function App() { return null }" summary="A splitter." />);
    expect(screen.getByTestId('sandbox-no-kit').textContent).toContain('A splitter.');
  });
});
