// @vitest-environment node

import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { SANDBOX_JSX_FRAME_SOURCE } from '../src/genui/sandbox-jsx-frame-generated.js';

/*
 * The frame's JSX runtime must survive the CONSUMER's production build. It used to be assembled from
 * `transpileJsx.toString()`: once an app's minifier renamed the helpers inside the library
 * (`__name` → `m`), the stringified transpiler referenced names the frame does not have, and every
 * kit sandbox threw `m is not defined` and stayed blank. It now ships as a prebuilt string.
 */

/** Run a frame runtime in a bare context with just enough of React and the DOM, and draw `code`. */
function drawInFakeFrame(runtime: string): { rendered: unknown; errors: string[] } {
  const errors: string[] = [];
  let rendered: unknown = null;
  const React = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props,
      children,
    }),
    Component: function Component() {},
    useState: (value: unknown) => [value, () => {}],
  };
  const context: Record<string, unknown> = {};
  const document = {
    createElement: () => ({ textContent: '', remove() {} }),
    head: {
      appendChild: (script: { textContent: string }) => runInContext(script.textContent, sandbox),
    },
    getElementById: () => ({}),
  };
  const window: Record<string, unknown> = {
    React,
    ReactDOM: {
      createRoot: () => ({
        render: (element: unknown) => {
          rendered = element;
        },
      }),
    },
    Kit: {},
    parent: {},
    addEventListener() {},
    dispatchEvent: (event: { message?: string }) => errors.push(String(event?.message)),
  };
  Object.assign(context, {
    window,
    document,
    ErrorEvent: class {
      message: string;
      constructor(_: string, init: { message: string }) {
        this.message = init.message;
      }
    },
  });
  const sandbox = createContext(context);
  runInContext('window.window = window; var self = window;', sandbox);
  // Globals the runtime reads off `window` are also plain globals in a browser.
  for (const key of Object.keys(window)) (sandbox as Record<string, unknown>)[key] = window[key];
  runInContext(runtime, sandbox);
  return { rendered, errors };
}

describe('the sandbox frame runtime in a minified consumer build', () => {
  it('ships the transpiler as a string, regenerated from sandbox-jsx.ts', async () => {
    const script = fileURLToPath(new URL('../scripts/build-frame-runtime.mjs', import.meta.url));
    const { frameRuntimeCode } = (await import(script)) as { frameRuntimeCode(): Promise<string> };
    // Out of date → run `pnpm --filter @adonis-agora/agent gen:frame`.
    expect(SANDBOX_JSX_FRAME_SOURCE).toBe(await frameRuntimeCode());
  }, 60_000);

  it('an esbuild build keeping names (helpers renamed by the minifier) still draws JSX', async () => {
    const esbuild = await import('esbuild');
    const kitModule = fileURLToPath(new URL('../src/genui/sandbox-kit.ts', import.meta.url));
    const out = await esbuild.build({
      stdin: {
        contents: `import { sandboxJsxRuntime } from ${JSON.stringify(kitModule)};\nglobalThis.__runtime = sandboxJsxRuntime({ token: 't', jsxMessage: 'agora:sandbox:jsx', initial: { code: 'function App() { const [n] = useState(2); return <p className="x">{n} people</p> }', final: true } });`,
        resolveDir: fileURLToPath(new URL('..', import.meta.url)),
        loader: 'ts',
      },
      bundle: true,
      minify: true,
      keepNames: true,
      format: 'iife',
      write: false,
      logLevel: 'silent',
    });
    const holder = createContext({});
    runInContext(out.outputFiles[0]?.text ?? '', holder);
    const { rendered, errors } = drawInFakeFrame(
      String((holder as { __runtime?: unknown }).__runtime),
    );
    expect(errors).toEqual([]);
    expect(rendered).not.toBeNull();
  }, 60_000);

  it('a Vite-minified build of the library still draws JSX in the frame', async () => {
    const vite = await import('vite');
    const kitModule = fileURLToPath(new URL('../src/genui/sandbox-kit.ts', import.meta.url));
    const result = (await vite.build({
      configFile: false,
      logLevel: 'silent',
      root: fileURLToPath(new URL('..', import.meta.url)),
      plugins: [
        {
          name: 'entry',
          resolveId: (id: string) => (id === 'virtual:consumer' ? '\0consumer' : null),
          load: (id: string) =>
            id === '\0consumer'
              ? `import { sandboxJsxRuntime } from ${JSON.stringify(kitModule)};\nglobalThis.__runtime = sandboxJsxRuntime({ token: 't', jsxMessage: 'agora:sandbox:jsx', initial: { code: 'function App() { const [n] = useState(2); return <p className="x">{n} people</p> }', final: true } });`
              : null,
        },
      ],
      build: {
        write: false,
        minify: true,
        rollupOptions: { input: 'virtual:consumer', output: { format: 'iife', name: 'consumer' } },
      },
    } as never)) as
      | { output: { type: string; code?: string }[] }[]
      | { output: { type: string; code?: string }[] };
    const outputs = Array.isArray(result) ? result : [result];
    const code =
      outputs.flatMap((out) => out.output).find((item) => item.type === 'chunk')?.code ?? '';
    const holder = createContext({});
    runInContext(code, holder);
    const runtime = String((holder as { __runtime?: unknown }).__runtime ?? '');
    const { rendered, errors } = drawInFakeFrame(runtime);
    expect(errors).toEqual([]);
    expect(rendered).not.toBeNull();
  }, 120_000);
});
