// @vitest-environment node
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveSandboxServer, sandboxKitDiscovery } from '../src/genui/kit/discover.js';
import { generateSandboxKitDocs } from '../src/genui/kit/docs.js';
import { globToRegExp, resolveSandboxKitFiles } from '../src/genui/kit/files.js';
import { writeSandboxKitDocs } from '../src/genui/kit/write.js';
import { buildSandboxDocument, defineSandbox, sandboxPartialProps } from '../src/genui/sandbox.js';
import { prepareSandboxJsx, transpileJsx } from '../src/genui/sandbox-jsx.js';
import { kitDocsToModelText } from '../src/genui/sandbox-kit.js';
import {
  hostThemeCss,
  tailwindThemeCss,
  themeToModelText,
  themeVarsFromCss,
} from '../src/genui/sandbox-theme.js';
import { genuiSandboxKit } from '../src/vite/index.js';

const fixture = fileURLToPath(new URL('./fixtures/sandbox-kit', import.meta.url));
const typescript = await import('typescript5');

const BILL_SPLITTER = `import { Card } from '@/components/ui/card'
export default function App() {
  const [people, setPeople] = useState(3);
  const [total, setTotal] = useState(120.5);
  const each = people > 0 ? total / people : 0;
  return (
    <Card className="p-4 space-y-2">
      <CardHeader><CardTitle>Split the bill &amp; tip</CardTitle></CardHeader>
      <CardContent>
        <Slider min={1} max={10} value={[people]} onValueChange={(v) => setPeople(v[0])} />
        <Input type="number" value={total} onChange={(e) => setTotal(Number(e.target.value))} />
        {people > 5 && <p className="text-muted-foreground">Big group!</p>}
        <Button onClick={() => agent.send({ text: 'Settle it', people, total })}>Settle</Button>
      </CardContent>
    </Card>
  );
}`;

describe('sandbox JSX — transpiler and partial gating', () => {
  const scope = [
    'React',
    'useState',
    'Card',
    'CardHeader',
    'CardTitle',
    'CardContent',
    'Slider',
    'Input',
    'Button',
    'agent',
  ];

  it('compiles JSX to React.createElement, keeping the JavaScript', () => {
    const code = transpileJsx(prepareSandboxJsx(BILL_SPLITTER));
    expect(code).not.toContain('import ');
    expect(code).toContain('function App()');
    expect(code).toContain('React.createElement(Card, {className: "p-4 space-y-2"}');
    expect(code).toContain('"Split the bill & tip"');
    expect(code).toContain('people > 5 && React.createElement("p"');
    // It runs: App renders a tree of elements.
    const created: unknown[] = [];
    const React = {
      createElement: (...args: unknown[]) => {
        created.push(args[0]);
        return args;
      },
    };
    const App = new Function(...scope, `${code}; return App;`)(
      React,
      (value: unknown) => [value, () => {}],
      'Card',
      'CardHeader',
      'CardTitle',
      'CardContent',
      'Slider',
      'Input',
      'Button',
      {},
    ) as () => unknown;
    App();
    expect(created).toContain('Card');
    expect(created).toContain('Button');
  });

  it('maps class/for, fragments, spreads and entities; throws on malformed input', () => {
    expect(transpileJsx('<><label class="a" for="x">a&nbsp;b</label><b {...p} c /></>')).toBe(
      'React.createElement(React.Fragment, null, React.createElement("label", {className: "a", htmlFor: "x"}, "a b"), React.createElement("b", Object.assign({}, p, {c: true})))',
    );
    expect(() => transpileJsx('const a = <div>')).toThrow(SyntaxError);
    expect(() => transpileJsx('<a></b>')).toThrow(/Expected <\/a>/);
    // Less-than is not JSX.
    expect(transpileJsx('const x = a < b && c<d;')).toBe('const x = a < b && c<d;');
  });

  it('every prefix of the JSX, once the component has begun, closes into code that parses', () => {
    const program = prepareSandboxJsx(BILL_SPLITTER);
    const start = program.indexOf('return (');
    let parsed = 0;
    for (let length = start; length <= program.length; length++) {
      const code = transpileJsx(program.slice(0, length), { partial: true });
      expect(
        () => new Function(code),
        JSON.stringify(program.slice(length - 30, length)),
      ).not.toThrow();
      parsed++;
    }
    expect(parsed).toBeGreaterThan(500);
    // A half-written attribute is dropped; the element is drawn without it.
    const cut = program.slice(
      0,
      program.indexOf('onValueChange={(v) => set') + 'onValueChange={(v) => set'.length,
    );
    expect(transpileJsx(cut, { partial: true })).toContain(
      'React.createElement(Slider, {min: 1, max: 10, value: [people]})',
    );
  });

  it('the server streams the jsx field as it is written', () => {
    const props = { title: 'Split', jsx: '<Card>' };
    const out = sandboxPartialProps(props, { isOpen: () => true, pendingMember: () => 'jsx' });
    expect(out.jsx).toBe('<Card>');
  });
});

describe('theme', () => {
  const css = `@theme inline { --color-primary: var(--primary); }
:root { --radius: 0.625rem; --background: oklch(1 0 0); --primary: oklch(0.2 0 0); --muted-foreground: 215 16% 47%; --font-sans: Geist, sans-serif; --tw-ring: 1px; }
[data-theme='dark'] { --background: oklch(0.1 0 0); }`;

  it('reads custom properties from CSS, light values first, internal ones skipped', () => {
    const vars = themeVarsFromCss(css);
    expect(vars['--background']).toBe('oklch(1 0 0)');
    expect(vars['--tw-ring']).toBeUndefined();
  });

  it('maps them to a Tailwind @theme (hsl channels wrapped) with a dark variant on class and data-theme', () => {
    const theme = tailwindThemeCss(themeVarsFromCss(css));
    expect(theme).toContain('--color-background: var(--background)');
    expect(theme).toContain('--color-muted-foreground: hsl(var(--muted-foreground))');
    expect(theme).toContain('--radius-lg: var(--radius)');
    expect(theme).toContain('--font-sans: var(--font-sans)');
    expect(theme).toContain('[data-theme=dark]');
  });

  it('puts the values on the frame root with its color scheme, and tells the model the names', () => {
    expect(hostThemeCss({ '--primary': 'red' }, true)).toBe(
      ':root{color-scheme:dark;--primary:red}',
    );
    const text = themeToModelText(themeVarsFromCss(css), { tailwind: true });
    expect(text).toContain('var(--primary)');
    expect(text).toContain('bg-background');
  });

  it('the frame starts in the host mode, and the bridge follows theme messages', () => {
    const doc = buildSandboxDocument(
      { html: '<p>hi</p>' },
      {
        token: 't',
        hostOrigin: 'https://app.test',
        mode: 'live',
        theme: { css: ':root{--primary:gold}', dark: true },
        tailwind: { runtime: '/*tw*/', theme: '@theme inline {}' },
      },
    );
    expect(doc).toContain('<html class="dark" data-theme="dark">');
    expect(doc).toContain('<style id="agora-sandbox-theme">:root{--primary:gold}</style>');
    expect(doc).toContain(
      '<style type="text/tailwindcss" id="agora-sandbox-tw">@theme inline {}</style>',
    );
    expect(doc).toContain('agora:sandbox:theme');
    expect(doc).toContain("setAttribute('data-theme'");
  });
});

describe('kit docs generator', () => {
  it('reads components and props from their TypeScript types', async () => {
    const docs = await generateSandboxKitDocs({ root: fixture, typescript });
    expect(docs.map((doc) => doc.name)).toEqual([
      'Button',
      'Card',
      'CardHeader',
      'CardTitle',
      'CardContent',
      'Input',
      'Slider',
    ]);
    const button = docs[0];
    expect(button?.description).toBe("A button in the app's style.");
    expect(button?.inherits).toBe('button');
    expect(button?.props.find((prop) => prop.name === 'variant')).toEqual({
      name: 'variant',
      type: '"default" | "outline" | "ghost" | "destructive"',
      required: false,
      description: 'How the button looks.',
      default: '"default"',
    });
    // Shared DOM attributes are summed up by `inherits`, not listed.
    expect(button?.props.map((prop) => prop.name)).not.toContain('onMouseEnter');
    const slider = docs.find((doc) => doc.name === 'Slider');
    expect(slider?.props.find((prop) => prop.name === 'value')).toMatchObject({
      type: 'number[]',
      required: true,
    });
    expect(slider?.props.find((prop) => prop.name === 'onValueChange')?.type).toBe(
      '(value: number[]) => void',
    );
    const text = kitDocsToModelText({ version: 1, components: docs });
    expect(text).toContain('- <Button> A button');
    expect(text).toContain('variant?: "default" | "outline" | "ghost" | "destructive" = "default"');
    expect(text).toContain('…and every <button> attribute');
  });

  it('finds the default components/ui folder, and globs', () => {
    expect(resolveSandboxKitFiles(fixture, {})?.files.map((file) => file.split('/').pop())).toEqual(
      ['button.tsx', 'card.tsx', 'input.tsx', 'slider.tsx'],
    );
    expect(globToRegExp('components/**/*.{tsx,ts}').test('components/ui/a/b.tsx')).toBe(true);
    expect(globToRegExp('components/*.tsx').test('components/ui/b.tsx')).toBe(false);
  });

  it('writes a descriptor (docs + theme) for the assembler hook / codegen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-docs-'));
    try {
      const out = await writeSandboxKitDocs({
        root: fixture,
        typescript,
        output: join(dir, 'kit.json'),
        css: 'components/ui/*.css',
      });
      expect(out?.components).toHaveLength(7);
      const written = JSON.parse(readFileSync(join(dir, 'kit.json'), 'utf8'));
      expect(written.kit).toBeNull();
      expect(written.components[0].name).toBe('Button');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the sandbox definition with a kit', () => {
  it('tells the model the kit, the JSX rules, Tailwind and the theme — read live', () => {
    let components = [{ name: 'Button', props: [] }];
    const sandbox = defineSandbox({
      kit: () => ({ version: 1, components }),
      tailwind: true,
      theme: { vars: ['--primary'] },
    });
    expect(sandbox.description).toContain('- <Button>');
    expect(sandbox.description).toContain('function App()');
    expect(sandbox.description).toContain('Tailwind CSS v4');
    expect(sandbox.description).toContain('var(--primary)');
    components = [{ name: 'Slider', props: [] }];
    expect(sandbox.description).toContain('- <Slider>');
    expect((sandbox.props as { properties: Record<string, unknown> }).properties.jsx).toBeDefined();
    expect(sandbox.sandboxView).toEqual({ theme: true, tailwind: true, kit: true });
  });

  it('the plain sandbox is unchanged (html required, no jsx)', () => {
    const plain = defineSandbox();
    expect((plain.props as { required: string[] }).required).toEqual(['html']);
    expect(plain.description).not.toContain('function App()');
  });
});

describe('the Vite plugin', () => {
  const work = mkdtempSync(join(tmpdir(), 'kit-vite-'));

  // A copy under the package, so `react` resolves from its node_modules.
  const root = mkdtempSync(
    join(fileURLToPath(new URL('./fixtures/', import.meta.url)), '.kit-app-'),
  );
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  cpSync(fixture, root, { recursive: true });
  writeFileSync(join(root, 'main.js'), 'import "./app.css"; console.log("app");\n');
  writeFileSync(
    join(root, 'app.css'),
    ':root { --primary: oklch(0.7 0.1 80); --radius: 0.5rem; }\n',
  );
  const alias = { '@': root };

  it('build: emits the kit, Tailwind and the descriptor, listed in the manifest', async () => {
    const vite = await import('vite');
    await vite.build({
      configFile: false,
      root,
      logLevel: 'silent',
      resolve: { alias },
      plugins: [genuiSandboxKit({ typescript })],
      build: {
        outDir: join(work, 'dist'),
        manifest: true,
        rollupOptions: { input: join(root, 'main.js') },
      },
    });
    const manifest = JSON.parse(readFileSync(join(work, 'dist/.vite/manifest.json'), 'utf8'));
    for (const key of [
      'genui-sandbox-kit.js',
      'genui-sandbox-tailwind.js',
      'genui-sandbox-kit.json',
    ])
      expect(manifest[key]?.file, key).toMatch(/^assets\/genui-sandbox-/);
    const descriptor = JSON.parse(
      readFileSync(join(work, 'dist', manifest['genui-sandbox-kit.json'].file), 'utf8'),
    );
    expect(descriptor.kit.url).toBe(`/${manifest['genui-sandbox-kit.js'].file}`);
    expect(descriptor.tailwind.url).toBe(`/${manifest['genui-sandbox-tailwind.js'].file}`);
    expect(descriptor.components.map((c: { name: string }) => c.name)).toContain('Slider');
    expect(descriptor.theme.vars['--primary']).toBe('oklch(0.7 0.1 80)');
    const kit = readFileSync(join(work, 'dist', manifest['genui-sandbox-kit.js'].file), 'utf8');
    expect(kit).toContain('window.Kit');

    // The server finds it through the manifest, and tells the browser and the model.
    const discovery = sandboxKitDiscovery({
      root: work,
      production: true,
      manifest: { file: 'dist/.vite/manifest.json', outDir: 'dist' },
    });
    const server = resolveSandboxServer({ kit: true, tailwind: true }, discovery);
    expect(server.client()).toEqual({
      theme: true,
      tailwind: descriptor.tailwind,
      kit: descriptor.kit,
    });
    expect(defineSandbox(server.define).description).toContain('- <Slider>');
  }, 60_000);

  it('dev: serves the bundle, writes the descriptor, and rebuilds when a component changes', async () => {
    const vite = await import('vite');
    const plugin = genuiSandboxKit({ typescript, descriptor: '.genui/kit.json' });
    const server = await vite.createServer({
      configFile: false,
      root,
      logLevel: 'silent',
      resolve: { alias },
      plugins: [plugin],
      server: { middlewareMode: true, watch: { usePolling: true, interval: 50 } },
      appType: 'custom',
    });
    const events: unknown[] = [];
    const send = server.ws.send.bind(server.ws);
    server.ws.send = ((payload: unknown) => {
      events.push(payload);
      return send(payload as never);
    }) as typeof server.ws.send;
    try {
      await plugin.api.ready();
      const descriptor = plugin.api.descriptor();
      expect(descriptor?.kit?.url).toMatch(/^\/@genui-sandbox-kit\/kit\.js\?v=[0-9a-f]{12}$/);
      expect(existsSync(join(root, '.genui/kit.json'))).toBe(true);
      const http = await import('node:http');
      const listener = http.createServer(server.middlewares);
      await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
      const port = (listener.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}${descriptor?.kit?.url}`);
      const served = { status: response.status, body: await response.text() };
      listener.close();
      expect(served.status).toBe(200);
      expect(served.body).toContain('window.Kit');

      // A component changes: rebuilt, the descriptor names the new bundle, open pages are told.
      const button = join(root, 'components/ui/button.tsx');
      writeFileSync(button, `${readFileSync(button, 'utf8')}\nexport const Extra = () => null;\n`);
      server.watcher.emit('change', button);
      const deadline = Date.now() + 15_000;
      while (
        !events.some((event) => (event as { event?: string }).event === 'genui-sandbox-kit:update')
      ) {
        if (Date.now() > deadline) throw new Error('no rebuild');
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(plugin.api.descriptor()?.kit?.url).not.toBe(descriptor?.kit?.url);

      // The dev server's descriptor is what the server process reads.
      const discovery = sandboxKitDiscovery({
        root,
        descriptor: '.genui/kit.json',
        production: false,
      });
      expect(discovery.descriptor()?.kit?.url).toBe(plugin.api.descriptor()?.kit?.url);
    } finally {
      await server.close();
    }
  }, 60_000);

  it('dev: an app module importing the renderer gets the HMR bridge', async () => {
    const plugin = genuiSandboxKit();
    (plugin.configResolved as (c: unknown) => void)({
      root,
      base: '/',
      command: 'serve',
      resolve: {},
      build: {},
      logger: console,
    });
    const out = (plugin.transform as (code: string, id: string) => { code: string } | null)(
      "import { SandboxView } from '@adonis-agora/agent/react/genui'",
      resolve(root, 'page.tsx'),
    );
    expect(out?.code).toContain('import.meta.hot.on("genui-sandbox-kit:update"');
  });
});
