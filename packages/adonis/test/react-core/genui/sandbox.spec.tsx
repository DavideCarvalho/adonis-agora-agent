// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  defineCatalog,
  defineSandbox,
  SANDBOX_MESSAGE,
  Sandbox,
} from '../../../src/genui/index.js';
import { GenerativeUI, GenuiProvider } from '../../../src/react/core/genui/generative-ui.js';
import {
  createSandboxRenderer,
  GenuiActionProvider,
  SandboxView,
} from '../../../src/react/core/genui/sandbox.js';

const view = {
  initialHeight: 300,
  placeholderMessages: ['Building the splitter…'],
  title: 'Bill splitter',
  css: 'b{color:red}',
  html: '<b>hi</b>',
  jsFunctions: 'function f(){}',
  jsExpressions: ['f()'],
};

afterEach(() => vi.useRealTimers());

function frame(): HTMLIFrameElement {
  return screen.getByTestId('sandbox-frame') as HTMLIFrameElement;
}

/** A message as if `agent.send` / the bridge inside the frame posted it. */
function fromFrame(target: HTMLIFrameElement, data: Record<string, unknown>, origin = 'null') {
  const token = /var T="([0-9a-f]+)"/.exec(target.srcdoc)?.[1];
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { token, ...data },
      origin,
      source: target.contentWindow,
    }),
  );
}

function tree(props: Record<string, unknown>, incomplete = false) {
  return {
    id: 'ui1',
    component: 'genui:tree',
    props: {
      root: { id: 'root', type: 'Sandbox', props, ...(incomplete ? { incomplete: true } : {}) },
    },
    ...(incomplete ? { partial: true } : {}),
  };
}

describe('<SandboxView>', () => {
  it('draws an isolated frame: srcdoc, scripts only, CSP, no referrer', () => {
    render(<SandboxView {...view} />);
    const iframe = frame();
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe.srcdoc).toContain('Content-Security-Policy');
    expect(iframe.srcdoc).toContain("connect-src 'none'");
    expect(iframe.srcdoc).toContain('function f(){}');
    expect(iframe.style.height).toBe('300px');
    expect(iframe.title).toBe('Bill splitter');
  });

  it('streams: placeholder of initialHeight, then a script-free preview, then the live view', () => {
    const registry = { Sandbox: SandboxView };
    const { rerender } = render(
      <GenerativeUI
        part={tree({ initialHeight: 180, placeholderMessages: ['Laying out…'] }, true)}
        registry={registry}
      />,
    );
    const placeholder = screen.getByTestId('sandbox-placeholder');
    expect(placeholder.style.height).toBe('180px');
    expect(placeholder.textContent).toContain('Laying out…');
    rerender(
      <GenerativeUI
        part={tree({ initialHeight: 180, css: 'b{}', html: '<b>par' }, true)}
        registry={registry}
      />,
    );
    expect(frame().dataset.sandboxPhase).toBe('preview');
    expect(frame().srcdoc).not.toContain('<b>par');
    rerender(
      <GenerativeUI
        part={tree(
          { initialHeight: 180, css: 'b{}', html: '<b>done</b>', jsFunctions: 'function f(){}' },
          true,
        )}
        registry={registry}
      />,
    );
    expect(frame().dataset.sandboxPhase).toBe('live');
    expect(frame().srcdoc).toContain('<b>done</b>');
    // Code streamed in arrives by message, never inlined into a document built mid-stream.
    expect(frame().srcdoc).not.toContain('function f(){}');
  });

  it('hands agent.send on as a UI action — only from its own frame, origin and token', async () => {
    const onAction = vi.fn();
    render(
      <GenuiActionProvider onAction={onAction}>
        <SandboxView {...view} />
      </GenuiActionProvider>,
    );
    const iframe = frame();
    // Another window, another origin, a wrong token: ignored.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SANDBOX_MESSAGE.send, payload: { a: 1 } },
        origin: 'null',
        source: window,
      }),
    );
    fromFrame(iframe, { type: SANDBOX_MESSAGE.send, payload: { a: 1 } }, 'https://evil.test');
    fromFrame(iframe, { type: SANDBOX_MESSAGE.send, payload: { a: 1 }, token: 'nope' });
    await act(async () => {});
    expect(onAction).not.toHaveBeenCalled();
    await act(async () =>
      fromFrame(iframe, { type: SANDBOX_MESSAGE.send, payload: { text: 'Split', people: 3 } }),
    );
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]?.[0]).toMatchObject({
      source: 'sandbox',
      name: 'send',
      text: 'Split',
      context: { people: 3 },
      title: 'Bill splitter',
    });
  });

  it('refuses what is too large, too soon, too many, or fails the schema', async () => {
    const onAction = vi.fn();
    const onRefused = vi.fn();
    const Strict = createSandboxRenderer({
      schema: z.object({ people: z.number().int().min(1) }),
      policy: { maxPayloadBytes: 64, minSendIntervalMs: 1000, maxSends: 2 },
      onAction,
      onRefused,
    });
    render(<Strict {...view} />);
    const iframe = frame();
    await act(async () =>
      fromFrame(iframe, { type: SANDBOX_MESSAGE.send, payload: { blob: 'x'.repeat(100) } }),
    );
    expect(onRefused).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'too-large' }));
    vi.useFakeTimers({ now: Date.now() + 5000 });
    await act(async () =>
      fromFrame(iframe, { type: SANDBOX_MESSAGE.send, payload: { people: 0 } }),
    );
    expect(onRefused).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'invalid' }));
    vi.setSystemTime(Date.now() + 5000);
    await act(async () =>
      fromFrame(iframe, { type: SANDBOX_MESSAGE.send, payload: { people: 2 } }),
    );
    expect(onAction).toHaveBeenCalledTimes(1);
    await act(async () =>
      fromFrame(iframe, { type: SANDBOX_MESSAGE.send, payload: { people: 2 } }),
    );
    expect(onRefused).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'too-soon' }));
    vi.setSystemTime(Date.now() + 5000);
    await act(async () =>
      fromFrame(iframe, { type: SANDBOX_MESSAGE.send, payload: { people: 4 } }),
    );
    expect(onAction).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 5000);
    await act(async () =>
      fromFrame(iframe, { type: SANDBOX_MESSAGE.send, payload: { people: 2 } }),
    );
    expect(onRefused).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'too-many' }));
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it('sizes to its content within maxHeight, and takes the policy of the catalog definition', async () => {
    const maps = defineSandbox({
      policy: { allow: { images: ['https://tile.openstreetmap.org'] }, maxHeight: 500 },
    });
    render(
      <GenuiProvider registry={{ Sandbox: SandboxView }} catalog={defineCatalog([maps])}>
        <GenerativeUI part={tree(view)} />
      </GenuiProvider>,
    );
    const iframe = frame();
    expect(iframe.srcdoc).toContain('img-src data: blob: https://tile.openstreetmap.org');
    await act(async () => fromFrame(iframe, { type: SANDBOX_MESSAGE.resize, height: 420 }));
    expect(iframe.style.height).toBe('420px');
    await act(async () => fromFrame(iframe, { type: SANDBOX_MESSAGE.resize, height: 9000 }));
    expect(iframe.style.height).toBe('500px');
    fireEvent.load(iframe);
  });

  it('is the builtin definition the catalog validates against', async () => {
    expect((await defineCatalog([Sandbox]).validate('Sandbox', view)).ok).toBe(true);
  });
});
