// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineCatalog, defineSandbox, SANDBOX_MESSAGE } from '../../src/genui/index.js';
import { buildSandboxDocument } from '../../src/genui/sandbox.js';
import {
  createNativeSandboxRenderer,
  GenerativeUI,
  GenuiActionProvider,
  GenuiProvider,
  NATIVE_SANDBOX_WEBVIEW_PROPS,
  NativeSandboxView,
} from '../../src/react-native/genui/index.js';
import {
  checkSandboxSend,
  hostMessageScript,
  nativeThemeCss,
  parseFrameMessage,
  resolveSandboxUrl,
  shouldStartSandboxLoad,
} from '../../src/react-native/genui/sandbox-host.js';

// What the mocked WebView was last rendered with, and what was injected into it.
const native = vi.hoisted(() => ({
  props: null as Record<string, any> | null,
  injected: [] as string[],
  mounts: 0,
}));

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return typeof style === 'object' && style !== null ? (style as Record<string, unknown>) : {};
}

vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  return {
    View: ({ testID, style, children }: any) =>
      createElement(
        'div',
        { 'data-testid': testID, 'data-height': flatten(style).height },
        children,
      ),
    Text: ({ children }: any) => createElement('span', null, children),
  };
});

vi.mock('react-native-webview', async () => {
  const React = await import('react');
  const WebView = React.forwardRef((props: any, ref) => {
    React.useImperativeHandle(ref, () => ({
      injectJavaScript: (script: string) => native.injected.push(script),
    }));
    React.useEffect(() => {
      native.mounts += 1;
    }, []);
    native.props = props;
    return React.createElement('div', {
      'data-testid': props.testID,
      'data-height': String(flatten(props.style).height),
    });
  });
  return { WebView, default: WebView };
});

afterEach(() => {
  vi.useRealTimers();
  native.props = null;
  native.injected = [];
  native.mounts = 0;
});

const view = {
  initialHeight: 300,
  placeholderMessages: ['Building the splitter…'],
  title: 'Bill splitter',
  css: 'b{color:red}',
  html: '<b>hi</b>',
  jsFunctions: 'function f(){}',
  jsExpressions: ['f()'],
};

function webview() {
  if (native.props === null) throw new Error('no WebView rendered');
  return native.props;
}

function documentHtml(): string {
  return webview().source.html as string;
}

function token(): string {
  const found = /var T="([0-9a-f]+)"/.exec(documentHtml())?.[1];
  if (found === undefined) throw new Error('no token');
  return found;
}

/** A message as the WebView's `onMessage` gets it from the bridge. */
async function fromFrame(data: Record<string, unknown> | string, url = 'about:blank') {
  // The bridge's own key order: type, token, then the rest.
  const raw =
    typeof data === 'string' ? data : JSON.stringify({ type: data.type, token: token(), ...data });
  await act(async () => webview().onMessage({ nativeEvent: { data: raw, url } }));
}

/** The host messages injected so far, decoded. */
function injectedMessages(): Record<string, unknown>[] {
  return native.injected.map((script) => {
    const literal = /data:(.*),source:window/.exec(script)?.[1];
    return JSON.parse(literal as string);
  });
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

describe('React Native sandbox document', () => {
  it('is the web document with the no-network CSP, talking through ReactNativeWebView', () => {
    const html = buildSandboxDocument(view, {
      token: 'abc',
      hostOrigin: '',
      mode: 'live',
      transport: 'react-native',
    });
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("frame-src 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).toContain('ReactNativeWebView).postMessage(JSON.stringify(msg))');
    expect(html).not.toContain('P.postMessage');
    expect(html).toContain('name="viewport" content="width=device-width');
    // The web document is unchanged.
    const web = buildSandboxDocument(view, {
      token: 'abc',
      hostOrigin: 'https://app',
      mode: 'live',
    });
    expect(web).toContain('P.postMessage(msg,O)');
    expect(web).not.toContain('ReactNativeWebView');
    expect(web).not.toContain('viewport');
  });

  it('runs: the bridge posts JSON to ReactNativeWebView, injected host messages reach it', async () => {
    const posted: string[] = [];
    const html = buildSandboxDocument(
      { css: '', html: '<p id="x">old</p>' },
      { token: 'tok', hostOrigin: '', mode: 'preview', transport: 'react-native' },
    );
    const { JSDOM } = (await import('jsdom')) as any;
    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      beforeParse(window: any) {
        window.ReactNativeWebView = { postMessage: (data: string) => posted.push(data) };
      },
    });
    await new Promise((resolve) => dom.window.addEventListener('load', resolve));
    const messages = posted.map((data) => JSON.parse(data));
    expect(messages).toContainEqual(
      expect.objectContaining({ type: SANDBOX_MESSAGE.ready, token: 'tok' }),
    );
    expect(messages.every((message) => message.token === 'tok')).toBe(true);
    dom.window.eval(
      hostMessageScript({
        type: SANDBOX_MESSAGE.render,
        token: 'tok',
        css: '',
        html: '<p>new</p>',
      }),
    );
    expect(dom.window.document.body.innerHTML).toBe('<p>new</p>');
    // Another token: ignored.
    dom.window.eval(
      hostMessageScript({ type: SANDBOX_MESSAGE.render, token: 'no', css: '', html: '<p>bad</p>' }),
    );
    expect(dom.window.document.body.innerHTML).toBe('<p>new</p>');
    (dom.window as any).agent.send({ text: 'hi', n: 1 });
    const sent = JSON.parse(posted.at(-1) as string);
    expect(sent).toEqual({
      type: SANDBOX_MESSAGE.send,
      token: 'tok',
      payload: { text: 'hi', n: 1 },
    });
    dom.window.close();
  });
});

describe('createNativeSandboxRenderer', () => {
  it('draws a hardened WebView of the inline document', () => {
    render(<NativeSandboxView {...view} />);
    const props = webview();
    expect(props.source.html).toContain("connect-src 'none'");
    expect(props.source.baseUrl).toBe('about:blank');
    expect(props.source.uri).toBeUndefined();
    expect(props).toMatchObject({
      javaScriptEnabled: true,
      javaScriptCanOpenWindowsAutomatically: false,
      setSupportMultipleWindows: false,
      domStorageEnabled: false,
      allowFileAccess: false,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
      allowsLinkPreview: false,
      incognito: true,
      cacheEnabled: false,
      mixedContentMode: 'never',
      scrollEnabled: false,
      sharedCookiesEnabled: false,
      thirdPartyCookiesEnabled: false,
      geolocationEnabled: false,
      webviewDebuggingEnabled: false,
    });
    for (const key of Object.keys(props)) {
      expect(key).not.toMatch(/^injectedJavaScript/);
    }
    expect(props.onOpenWindow).toBeUndefined();
    expect(props.onRenderProcessGone).toBeTypeOf('function');
    expect(screen.getByTestId('sandbox-frame').dataset.height).toBe('300');
    expect(props.accessibilityLabel).toBe('Bill splitter');
  });

  it('refuses every navigation but the inline document', () => {
    const decide = webview_decider();
    for (const url of ['about:blank', 'about:srcdoc', 'about:blank#section']) {
      expect(decide({ url })).toBe(true);
    }
    for (const url of [
      'https://evil.test/?q=secret',
      'http://localhost:3333',
      'tel:+15551234',
      'mailto:a@b.c',
      'sms:123',
      'intent://x#Intent;end',
      'file:///etc/passwd',
      'data:text/html,<p>x</p>',
      'javascript:alert(1)',
      'about:blankx',
      'myapp://deeplink',
      '',
    ]) {
      expect(decide({ url })).toBe(false);
    }
    expect(decide({})).toBe(false);
    // Every URL reaches the decider: one the whitelist refused would go to Linking.openURL.
    expect(NATIVE_SANDBOX_WEBVIEW_PROPS.originWhitelist).toEqual(['*']);
    expect(NATIVE_SANDBOX_WEBVIEW_PROPS.onShouldStartLoadWithRequest).toBe(shouldStartSandboxLoad);
  });

  it('hands a valid agent.send on as a UiAction (GenuiActionProvider)', async () => {
    const onAction = vi.fn();
    render(
      <GenuiActionProvider onAction={onAction}>
        <NativeSandboxView {...view} />
      </GenuiActionProvider>,
    );
    await fromFrame({ type: SANDBOX_MESSAGE.send, payload: { text: 'Split', people: 3 } });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]?.[0]).toMatchObject({
      source: 'sandbox',
      name: 'send',
      text: 'Split',
      context: { people: 3 },
      title: 'Bill splitter',
    });
  });

  it('ignores what has no token, another token, is not JSON, or comes from another URL', async () => {
    const onAction = vi.fn();
    const onRefused = vi.fn();
    const Sandbox = createNativeSandboxRenderer({ onAction, onRefused });
    render(<Sandbox {...view} />);
    const send = { type: SANDBOX_MESSAGE.send, payload: { a: 1 } };
    await fromFrame(JSON.stringify(send));
    await fromFrame(JSON.stringify({ ...send, token: 'nope' }));
    await fromFrame('{not json');
    await fromFrame(JSON.stringify([send]));
    await fromFrame(JSON.stringify({ ...send, token: token(), type: 'agora:sandbox:other' }));
    await fromFrame(send, 'https://evil.test/');
    await act(async () => webview().onMessage({ nativeEvent: { data: 42 } }));
    expect(onAction).not.toHaveBeenCalled();
    expect(onRefused).not.toHaveBeenCalled();
  });

  it('refuses too large (before parsing, and after), too soon, too many, schema-invalid, declined', async () => {
    const onAction = vi.fn();
    const onRefused = vi.fn();
    const confirm = vi.fn(
      (action: { context: Record<string, unknown> }) => action.context.people !== 9,
    );
    const Strict = createNativeSandboxRenderer({
      schema: z.object({ people: z.number().int().min(1) }),
      policy: { maxPayloadBytes: 64, minSendIntervalMs: 1000, maxSends: 2 },
      confirm,
      onAction,
      onRefused,
    });
    render(<Strict {...view} />);
    // Over the cap even to parse: refused by its envelope, never parsed.
    const parse = vi.spyOn(JSON, 'parse');
    await fromFrame({ type: SANDBOX_MESSAGE.send, payload: { blob: 'x'.repeat(5000) } });
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
    expect(onRefused).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: 'too-large', limit: 64 }),
    );
    // A huge message without the envelope: dropped silently.
    onRefused.mockClear();
    await fromFrame(`{"type":"x","token":"${token()}","payload":"${'x'.repeat(5000)}"}`);
    expect(onRefused).not.toHaveBeenCalled();
    // Parsed, but over maxPayloadBytes.
    await fromFrame({ type: SANDBOX_MESSAGE.send, payload: { blob: 'x'.repeat(100) } });
    expect(onRefused).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: 'too-large', limit: 64 }),
    );
    vi.useFakeTimers({ now: Date.now() + 5000 });
    await fromFrame({ type: SANDBOX_MESSAGE.send, payload: { people: 0 } });
    expect(onRefused).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'invalid' }));
    vi.setSystemTime(Date.now() + 5000);
    await fromFrame({ type: SANDBOX_MESSAGE.send, payload: { people: 9 } });
    expect(onRefused).toHaveBeenLastCalledWith({ reason: 'declined' });
    vi.setSystemTime(Date.now() + 5000);
    await fromFrame({ type: SANDBOX_MESSAGE.send, payload: { people: 2 } });
    expect(onAction).toHaveBeenCalledTimes(1);
    await fromFrame({ type: SANDBOX_MESSAGE.send, payload: { people: 2 } });
    expect(onRefused).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'too-soon' }));
    vi.setSystemTime(Date.now() + 5000);
    await fromFrame({ type: SANDBOX_MESSAGE.send, payload: { people: 4 } });
    expect(onAction).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 5000);
    await fromFrame({ type: SANDBOX_MESSAGE.send, payload: { people: 2 } });
    expect(onRefused).toHaveBeenLastCalledWith({ reason: 'too-many', limit: 2 });
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it('refuses a send with no handler, and a send from a view still being written', async () => {
    const onRefused = vi.fn();
    const Sandbox = createNativeSandboxRenderer({ onRefused });
    const { rerender } = render(<Sandbox {...view} />);
    await fromFrame({ type: SANDBOX_MESSAGE.send, payload: { a: 1 } });
    expect(onRefused).toHaveBeenLastCalledWith({ reason: 'no-handler' });
    rerender(
      <GenuiProvider registry={{ Sandbox }} onAction={vi.fn()}>
        <GenerativeUI part={tree({ ...view, jsExpressions: undefined }, true)} />
      </GenuiProvider>,
    );
    await fromFrame({ type: SANDBOX_MESSAGE.send, payload: { a: 1 } });
    expect(onRefused).toHaveBeenLastCalledWith({ reason: 'declined' });
  });

  it('checks JSON-ness like the web host', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = await checkSandboxSend({
      payload: cyclic,
      state: { count: 0, last: 0 },
      policy: {},
      incomplete: false,
      hasHandler: true,
    });
    expect(result).toEqual({ ok: false, refusal: { reason: 'not-json' } });
  });

  it('follows the content height within 24 px and maxHeight (the catalog policy)', async () => {
    const maps = defineSandbox({
      policy: { allow: { images: ['https://tile.openstreetmap.org'] }, maxHeight: 500 },
    });
    render(
      <GenuiProvider registry={{ Sandbox: NativeSandboxView }} catalog={defineCatalog([maps])}>
        <GenerativeUI part={tree(view)} />
      </GenuiProvider>,
    );
    expect(documentHtml()).toContain('img-src data: blob: https://tile.openstreetmap.org');
    await fromFrame({ type: SANDBOX_MESSAGE.ready, height: 120 });
    expect(screen.getByTestId('sandbox-frame').dataset.height).toBe('120');
    await fromFrame({ type: SANDBOX_MESSAGE.resize, height: 420 });
    expect(screen.getByTestId('sandbox-frame').dataset.height).toBe('420');
    await fromFrame({ type: SANDBOX_MESSAGE.resize, height: 9000 });
    expect(screen.getByTestId('sandbox-frame').dataset.height).toBe('500');
    await fromFrame({ type: SANDBOX_MESSAGE.resize, height: 3 });
    expect(screen.getByTestId('sandbox-frame').dataset.height).toBe('24');
    await fromFrame({ type: SANDBOX_MESSAGE.resize, height: 'tall' });
    expect(screen.getByTestId('sandbox-frame').dataset.height).toBe('24');
  });

  it('streams: placeholder, script-free preview, live — code posted in, not inlined', async () => {
    const registry = { Sandbox: NativeSandboxView };
    const { rerender } = render(
      <GenerativeUI
        part={tree({ initialHeight: 180, placeholderMessages: ['Laying out…'] }, true)}
        registry={registry}
        fallback={null}
      />,
    );
    const placeholder = screen.getByTestId('sandbox-placeholder');
    expect(placeholder.dataset.height).toBe('180');
    expect(placeholder.textContent).toContain('Laying out…');
    rerender(
      <GenerativeUI
        part={tree({ initialHeight: 180, css: 'b{}', html: '<b>par' }, true)}
        registry={registry}
      />,
    );
    expect(documentHtml()).not.toContain('<b>par');
    await fromFrame({ type: SANDBOX_MESSAGE.ready, height: 50 });
    expect(injectedMessages()).toContainEqual(
      expect.objectContaining({ type: SANDBOX_MESSAGE.render, html: '<b>par' }),
    );
    rerender(
      <GenerativeUI
        part={tree(
          { initialHeight: 180, css: 'b{}', html: '<b>done</b>', jsFunctions: 'function f(){}' },
          true,
        )}
        registry={registry}
      />,
    );
    expect(documentHtml()).toContain('<b>done</b>');
    expect(documentHtml()).not.toContain('function f(){}');
    native.injected = [];
    await fromFrame({ type: SANDBOX_MESSAGE.ready, height: 50 });
    expect(injectedMessages()).toContainEqual(
      expect.objectContaining({ type: SANDBOX_MESSAGE.run, code: 'function f(){}' }),
    );
  });

  it('gives up on a WebView that left the inline document', async () => {
    const onError = vi.fn();
    const Sandbox = createNativeSandboxRenderer({ onError });
    render(<Sandbox {...view} summary="A splitter" />);
    await act(async () => webview().onNavigationStateChange({ url: 'about:blank' }));
    expect(screen.getByTestId('sandbox-frame')).toBeTruthy();
    await act(async () => webview().onNavigationStateChange({ url: 'https://evil.test/' }));
    expect(screen.queryByTestId('sandbox-frame')).toBeNull();
    expect(screen.getByTestId('sandbox-lost').textContent).toContain('A splitter');
    expect(onError).toHaveBeenCalled();
  });

  it('draws afresh when the WebView process dies, then gives up', async () => {
    render(<NativeSandboxView {...view} />);
    expect(native.mounts).toBe(1);
    await act(async () => webview().onRenderProcessGone({ nativeEvent: { didCrash: true } }));
    expect(native.mounts).toBe(2);
    await act(async () => webview().onContentProcessDidTerminate({ nativeEvent: {} }));
    await act(async () => webview().onRenderProcessGone({ nativeEvent: { didCrash: true } }));
    expect(screen.getByTestId('sandbox-lost')).toBeTruthy();
  });

  it("puts the app's tokens on :root and follows them without reloading", async () => {
    let theme = { vars: { '--primary': '#2563eb', background: 'white' }, dark: false };
    const Sandbox = createNativeSandboxRenderer({ theme: () => theme });
    const { rerender } = render(<Sandbox {...view} />);
    expect(documentHtml()).toContain(':root{--primary:#2563eb;--background:white}');
    expect(documentHtml()).toContain('data-theme="light"');
    await fromFrame({ type: SANDBOX_MESSAGE.ready, height: 50 });
    const source = webview().source;
    native.injected = [];
    theme = { vars: { '--primary': '#f00', background: 'black' }, dark: true };
    rerender(<Sandbox {...view} />);
    expect(webview().source).toBe(source);
    expect(native.mounts).toBe(1);
    expect(injectedMessages()).toContainEqual({
      type: SANDBOX_MESSAGE.theme,
      token: token(),
      css: ':root{--primary:#f00;--background:black}',
      dark: true,
    });
  });

  it('keeps the theme off with theme: false, and drops invalid variable names', () => {
    const Sandbox = createNativeSandboxRenderer({ theme: false });
    render(<Sandbox {...view} />);
    expect(documentHtml()).toContain('<style id="agora-sandbox-theme"></style>');
    expect(
      nativeThemeCss({ vars: { 'bad name}': 'x', '--ok': 'red</style>', n: 4 as never } }).css,
    ).toBe(':root{--ok:red/style;--n:4}');
  });

  it('inlines Tailwind given inline, mapped to the theme', () => {
    const Sandbox = createNativeSandboxRenderer({
      theme: { vars: { '--primary': '#2563eb' } },
      config: { tailwind: { runtime: 'window.__tw=1', css: '@utility x {}' } },
    });
    render(<Sandbox {...view} />);
    expect(documentHtml()).toContain('<script>window.__tw=1</script>');
    expect(documentHtml()).toContain('--color-primary: var(--primary)');
    expect(documentHtml()).toContain('@utility x {}');
  });

  it("resolves the agent's config and Tailwind against baseUrl", async () => {
    const fetch = vi.fn(async (url: string) => ({
      ok: true,
      text: async () =>
        url.endsWith('/config')
          ? JSON.stringify({
              genui: { sandbox: { theme: true, tailwind: { url: '/agent/genui/tailwind.js' } } },
            })
          : 'window.__fromServer=1',
    }));
    const Sandbox = createNativeSandboxRenderer({
      baseUrl: 'https://api.example.test/agent/',
      fetch,
    });
    render(<Sandbox {...view} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      'https://api.example.test/agent/config',
      'https://api.example.test/agent/genui/tailwind.js',
    ]);
    expect(documentHtml()).toContain('<script>window.__fromServer=1</script>');
  });

  it('draws a note for JSX without a kit', () => {
    render(<NativeSandboxView jsx="function App(){ return <p/> }" summary="Needs the kit" />);
    expect(screen.getByTestId('sandbox-no-kit').textContent).toContain('Needs the kit');
  });

  it('draws the persisted text for an unknown component with no DOM element', () => {
    render(
      <GenuiProvider registry={{}}>
        <GenerativeUI
          part={{ id: 'u', component: 'Nope', props: {}, fallbackText: 'plain text' }}
        />
      </GenuiProvider>,
    );
    expect(document.body.innerHTML).toContain('<span>plain text</span>');
    expect(document.body.innerHTML).not.toContain('white-space');
  });
});

describe('sandbox host helpers', () => {
  it('parses only capped, token-bearing JSON objects of frame message types', () => {
    expect(
      parseFrameMessage('{"type":"agora:sandbox:resize","token":"t","height":4}', 't', 10),
    ).toMatchObject({ kind: 'message' });
    expect(parseFrameMessage('{"type":"agora:sandbox:resize","height":4}', 't', 10).kind).toBe(
      'drop',
    );
    expect(parseFrameMessage('{"type":"agora:sandbox:run","token":"t"}', 't', 10).kind).toBe(
      'drop',
    );
    expect(parseFrameMessage({ type: 'x' }, 't', 10).kind).toBe('drop');
    expect(parseFrameMessage('null', 't', 10).kind).toBe('drop');
  });

  it('escapes line separators in injected messages', () => {
    const script = hostMessageScript({ html: '\u2028</script>' });
    expect(script).not.toContain('\u2028');
    expect(script).toContain('\\u2028');
  });

  it('resolves relative urls against an absolute baseUrl, http(s) only', () => {
    const base = 'https://api.example.test/agent';
    expect(resolveSandboxUrl('/a.js', base)).toBe('https://api.example.test/a.js');
    expect(resolveSandboxUrl('a.js', base)).toBe('https://api.example.test/a.js');
    expect(resolveSandboxUrl('a.js', `${base}/`)).toBe('https://api.example.test/agent/a.js');
    expect(resolveSandboxUrl('//cdn.test/a.js', base)).toBe('https://cdn.test/a.js');
    expect(resolveSandboxUrl('https://cdn.test/a.js', undefined)).toBe('https://cdn.test/a.js');
    expect(resolveSandboxUrl('/a.js', undefined)).toBeUndefined();
    expect(resolveSandboxUrl('/a.js', '/agent')).toBeUndefined();
    expect(resolveSandboxUrl('javascript:alert(1)', base)).toBeUndefined();
    expect(resolveSandboxUrl('file:///a.js', base)).toBeUndefined();
  });
});

function webview_decider(): (request: { url?: string }) => boolean {
  render(<NativeSandboxView {...view} />);
  return webview().onShouldStartLoadWithRequest;
}
