// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildSandboxKitBundle, kitDocsFromBundle } from '../src/genui/kit/bundle.js';
import { resolveSandboxKitFiles } from '../src/genui/kit/files.js';
import {
  buildSandboxKitStyles,
  collectStyleSources,
  discoverStyleEntries,
  resolveStyleImport,
} from '../src/genui/kit/styles.js';
import { writeSandboxKitDocs } from '../src/genui/kit/write.js';
import { defineSandbox } from '../src/genui/sandbox.js';
import { sandboxJsxRuntime } from '../src/genui/sandbox-kit.js';
import {
  compressClassNames,
  extractCssVocabulary,
  inlineCssUrls,
  tailwindTokensFromCss,
  tailwindV3ConfigToCss,
  tailwindVersionOf,
  vocabularyToModelText,
} from '../src/genui/sandbox-styles.js';
import { themeToModelText, themeVarsFromCss } from '../src/genui/sandbox-theme.js';
import { genuiKitHook } from '../src/hooks/genui_kit.js';
import { genuiSandboxKit } from '../src/vite/index.js';

const variants = fileURLToPath(new URL('./fixtures/sandbox-kit-variants', import.meta.url));
// Scratch projects under the package, so `react`, `bootstrap`, `@mui/material` resolve from its node_modules.
const scratch = mkdtempSync(
  join(fileURLToPath(new URL('./fixtures/', import.meta.url)), '.kit-styles-'),
);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function project(name: string, files: Record<string, string | Buffer>): string {
  const root = join(scratch, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe('Tailwind detection', () => {
  it('tells v4 (`@import "tailwindcss"`, `@theme`, the v4 banner) from v3 (`@tailwind`) from plain CSS', () => {
    expect(tailwindVersionOf('@import "tailwindcss";')).toBe(4);
    expect(tailwindVersionOf("@import 'tailwindcss/theme.css' layer(theme);")).toBe(4);
    expect(tailwindVersionOf('@theme { --color-gold: #d6b46c; }')).toBe(4);
    expect(tailwindVersionOf('/*! tailwindcss v4.1.0 | MIT */ .flex{display:flex}')).toBe(4);
    expect(tailwindVersionOf('@tailwind base;\n@tailwind components;\n@tailwind utilities;')).toBe(
      3,
    );
    expect(
      tailwindVersionOf('.btn { color: red } /* @tailwind is mentioned in a comment */'),
    ).toBeNull();
    expect(tailwindVersionOf('@import "bootstrap/scss/bootstrap";')).toBeNull();
  });

  it("reads the theme tokens, utilities and variants of the app's directives", () => {
    const tokens =
      tailwindTokensFromCss(`@theme inline { --color-primary: var(--primary); --color-*: initial; --radius-lg: 1rem; --font-display: Inter; --shadow-card: 0 1px 2px #0002; --text-hero: 3rem; --text-hero--line-height: 1; --animate-wiggle: wiggle 1s; }
@utility figure { font-variant-numeric: tabular-nums; }
@utility tab-* { tab-size: --value(integer); }
@custom-variant data-open (&:where([data-state="open"]));`);
    expect(tokens).toEqual({
      colors: ['primary'],
      radius: ['lg'],
      fonts: ['display'],
      shadows: ['card'],
      text: ['hero'],
      animations: ['wiggle'],
      utilities: ['figure', 'tab-*'],
      variants: ['data-open'],
    });
  });

  it("maps a v3 config's theme to v4 @theme, with its dark mode", () => {
    const css = tailwindV3ConfigToCss({
      darkMode: ['class', '[data-theme="dark"]'],
      theme: {
        fontFamily: { sans: ['Inter Variable', 'sans-serif'] },
        extend: {
          colors: {
            primary: {
              DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
              foreground: 'hsl(var(--primary-foreground))',
            },
            brand: { 50: '#eef', 900: '#003' },
          },
          borderRadius: { lg: 'var(--radius)' },
          fontSize: { hero: ['3rem', { lineHeight: '1.1' }] },
          keyframes: { wiggle: { '0%, 100%': { transform: 'rotate(-3deg)' } } },
          animation: { wiggle: 'wiggle 1s ease-in-out infinite' },
          spacing: () => ({}),
        },
      },
    });
    expect(css).toContain(
      '@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));',
    );
    expect(css).toContain('--color-primary: hsl(var(--primary) / 1);');
    expect(css).toContain('--color-primary-foreground: hsl(var(--primary-foreground));');
    expect(css).toContain('--color-brand-50: #eef;');
    expect(css).toContain('--radius-lg: var(--radius);');
    expect(css).toContain('--font-sans: "Inter Variable", sans-serif;');
    expect(css).toContain('--text-hero: 3rem;');
    expect(css).toContain('--text-hero--line-height: 1.1;');
    expect(css).toContain('--animate-wiggle: wiggle 1s ease-in-out infinite;');
    expect(css).toContain('@keyframes wiggle { 0%, 100% { transform: rotate(-3deg) } }');
    expect(tailwindTokensFromCss(css).colors).toEqual([
      'primary',
      'primary-foreground',
      'brand-50',
      'brand-900',
    ]);
  });

  it('a v4 stylesheet compiles, and its directives (and those it imports) reach the frame', async () => {
    const root = project('tw4', {
      'package.json': '{}',
      'src/app.css': '@import "tailwindcss";\n@import "./theme.css";\n.shell { display: grid; }\n',
      'src/theme.css':
        '@custom-variant dark (&:where([data-theme=dark] *));\n@theme { --color-gold: #d6b46c; }\n:root { --gold: #d6b46c; }\n',
    });
    const styles = await buildSandboxKitStyles({
      root,
      entries: [join(root, 'src/app.css')],
      plugins: [(await import('@tailwindcss/vite')).default()],
    });
    expect(styles?.tailwind?.version).toBe(4);
    expect(styles?.tailwind?.tokens.colors).toContain('gold');
    expect(styles?.tailwind?.directives).toContain('@custom-variant dark');
    expect(styles?.tailwind?.directives).not.toContain('@import');
    // The theme is the app's root variables, not those of Tailwind's compiled theme layer.
    expect(styles?.vars).toEqual({ '--gold': '#d6b46c' });
    expect(styles?.vocabulary).toBeUndefined();
    // The compiled CSS keeps the app's own rules (and Tailwind's base).
    expect(styles?.css).toContain('.shell');
    expect(styles?.css).toMatch(/tailwindcss v4/);
    expect(styles?.files.map((file) => file.split('/').pop())).toEqual(['app.css', 'theme.css']);
  }, 60_000);

  it('a v3 project: @tailwind directives and the config theme', async () => {
    const root = project('tw3', {
      'package.json': '{"type":"module"}',
      'tailwind.config.js':
        "export default { darkMode: 'class', theme: { extend: { colors: { brand: '#123456' } } } }\n",
      'app.css':
        '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n.card { padding: 1rem; }\n',
    });
    const styles = await buildSandboxKitStyles({
      root,
      entries: [join(root, 'app.css')],
      compile: false,
    });
    expect(styles?.tailwind?.version).toBe(3);
    expect(styles?.tailwind?.directives).toContain('--color-brand: #123456');
    expect(styles?.tailwind?.directives).toContain(
      '@custom-variant dark (&:where(.dark, .dark *));',
    );
  });
});

describe('CSS vocabulary', () => {
  const css = `
:root { --bs-primary: #7c3aed; --bs-body-font-family: Georgia; }
[data-bs-theme=dark] { --bs-body-bg: #111; }
.btn { --bs-btn-color: red; display: inline-block; }
.btn:hover { color: blue; }
.btn-primary { color: #fff; }
.btn-secondary { color: #000; }
.btn-lg, .btn-group-lg > .btn { padding: 1rem; }
@media (min-width: 576px) { .col-sm-6 { width: 50%; } .col-sm-4 { width: 33%; } }
.card { border: 1px solid; }
.card-body, .card-title { padding: 1rem; }
a[href$=".pdf"] { color: red; }
.md\\:flex { display: flex; }
._button_x1y2z_3 { color: red; }
@keyframes spin { from { transform: rotate(0) } }
@font-face { font-family: x; src: url(x.woff2); }
.content::after { content: "{ .not-a-class }"; }
`;

  it('groups class names into families, most used first, compressed and deduplicated', () => {
    const vocabulary = extractCssVocabulary(css);
    const btn = vocabulary.groups.find((group) => group.name === 'btn');
    expect(vocabulary.groups[0]?.name).toBe('btn');
    expect(btn?.classes[0]).toBe('btn');
    expect(btn?.classes).toContain('btn-{lg,primary,secondary}');
    expect(vocabulary.groups.find((group) => group.name === 'card')?.classes).toEqual([
      'card',
      'card-{body,title}',
    ]);
    expect(vocabulary.groups.find((group) => group.name === 'col')?.classes).toEqual([
      'col-sm-{4,6}',
    ]);
    const all = vocabulary.groups.flatMap((group) => group.classes).join(' ');
    // Escaped (Tailwind-style), hashed (CSS modules), attribute values and strings are not vocabulary.
    expect(all).not.toMatch(/md|pdf|_button|not-a-class|spin/);
    // Only root custom properties: a component's own (`--bs-btn-color`) is not the theme.
    expect(vocabulary.vars).toEqual(['--bs-primary', '--bs-body-font-family', '--bs-body-bg']);
    const text = vocabularyToModelText(vocabulary);
    expect(text).toContain('- btn: btn btn-{lg,primary,secondary} btn-group-lg');
    expect(text).toContain('var(--bs-primary)');
  });

  it('caps the list, and says how much was left out', () => {
    const big = Array.from(
      { length: 500 },
      (_, index) => `.u-${index} { margin: ${index}px }`,
    ).join('\n');
    const vocabulary = extractCssVocabulary(`${big}\n.btn{}\n.btn-primary{}`, {
      maxClasses: 50,
      maxPerFamily: 1000,
    });
    expect(vocabulary.total).toBe(502);
    expect(vocabulary.listed).toBe(50);
    expect(vocabularyToModelText(vocabulary)).toContain('(452 rarer classes not listed.)');
  });

  it('compresses siblings, keeping the first one in place', () => {
    expect(
      compressClassNames(['alert', 'alert-info', 'alert-danger', 'alert-heading-x', 'fade']),
    ).toEqual(['alert', 'alert-{info,danger}', 'alert-heading-x', 'fade']);
  });

  it('a Bootstrap .scss compiles with Sass, and its vocabulary reaches the prompt', async () => {
    const styles = await buildSandboxKitStyles({
      root: variants,
      entries: [join(variants, 'bootstrap/styles.scss')],
    });
    expect(styles?.tailwind).toBeUndefined();
    expect(styles?.css).toContain('#7c3aed');
    const names = styles?.vocabulary?.groups.map((group) => group.name) ?? [];
    for (const family of ['btn', 'card', 'form', 'alert']) expect(names).toContain(family);
    expect(
      styles?.vocabulary?.groups.find((group) => group.name === 'btn')?.classes.join(' '),
    ).toMatch(/btn-\{[^}]*primary/);
    expect(styles?.vars['--bs-primary']).toBe('#7c3aed');
    const sandbox = defineSandbox({
      kit: {
        version: 2,
        components: [],
        ...(styles?.vocabulary !== undefined ? { vocabulary: styles.vocabulary } : {}),
        theme: { vars: styles?.vars ?? {} },
      },
    });
    expect(sandbox.description).toContain('Style the view with ITS classes');
    expect(sandbox.description).toContain('btn-{');
    expect(sandbox.description).toContain('never jsx');
    expect(sandbox.description).not.toContain('Tailwind');
  }, 60_000);
});

describe('url() inlining', () => {
  const resolveFrom = (files: Record<string, number>) => (url: string) => {
    const bytes = files[url];
    return bytes === undefined ? null : { data: 'AAAA', mime: 'font/woff2', bytes };
  };

  it('inlines what fits, drops the rest (remote, too big, over budget, missing) with a warning', () => {
    const warnings: string[] = [];
    const out = inlineCssUrls(
      `@font-face{src:url("a.woff2") format("woff2"),url(https://cdn.test/b.woff2)}
.x{background:url('big.png')}.y{background:url(c.png)}.z{background:url(missing.png)}
.k{background:url(data:image/png;base64,AAAA)}.m{mask:url(#m)}`,
      {
        resolve: resolveFrom({ 'a.woff2': 1000, 'big.png': 5000, 'c.png': 1500 }),
        limit: 4000,
        budget: 2000,
        warn: (message) => warnings.push(message),
      },
    );
    expect(out).toContain('url("data:font/woff2;base64,AAAA") format("woff2")');
    expect(out).toContain('.k{background:url(data:image/png;base64,AAAA)}');
    expect(out).toContain('url(#m)');
    expect(out.match(/url\("data:,"\)/g)).toHaveLength(4);
    expect(warnings.join('\n')).toMatch(/cdn\.test.*no network/);
    expect(warnings.join('\n')).toMatch(/big\.png.*over the 4 KB limit/);
    expect(warnings.join('\n')).toMatch(/c\.png.*budget/);
    expect(warnings.join('\n')).toMatch(/missing\.png.*not found/);
  });

  it("a stylesheet's fonts and images are inlined by the build, within the limit", async () => {
    const root = project('urls', {
      'package.json': '{}',
      'app.css':
        '@font-face{font-family:Small;src:url(./small.woff2)}@font-face{font-family:Big;src:url(./big.woff2)}.logo{background:url(/logo.png)}',
      'small.woff2': Buffer.alloc(2048, 1),
      'big.woff2': Buffer.alloc(300 * 1024, 2),
      'public/logo.png': Buffer.alloc(100, 3),
    });
    const warnings: string[] = [];
    const styles = await buildSandboxKitStyles({
      root,
      entries: [join(root, 'app.css')],
      publicDir: join(root, 'public'),
      warn: (message) => warnings.push(message),
    });
    expect(styles?.css).toMatch(/font-family:Small;src:url\(["']?data:font\/woff2;base64,/);
    expect(styles?.css).toMatch(/font-family:Big;src:url\("data:,"\)/);
    expect(styles?.css).toMatch(/\.logo\{background:url\("data:image\/png;base64,/);
    expect(warnings.join('\n')).toMatch(/big\.woff2 \(300 KB\) is over the 128 KB limit/);
  }, 60_000);
});

describe('components and wrapper', () => {
  it('resolves files, directories, globs and packages; says what matched nothing', () => {
    const files = resolveSandboxKitFiles(variants, {
      components: ['tailwind/button.tsx', 'plain', 'mui/*.tsx', '@mui/material', 'nope/*.tsx'],
      wrapper: 'mui/wrapper',
    });
    expect(files?.files.map((file) => file.split('sandbox-kit-variants/')[1])).toEqual([
      'mui/components.tsx',
      'mui/wrapper.tsx',
      'plain/widgets.jsx',
      'tailwind/button.tsx',
    ]);
    expect(files?.packages).toEqual(['@mui/material']);
    expect(files?.wrapper).toBe(join(variants, 'mui/wrapper.tsx'));
    expect(files?.missing).toEqual(['nope/*.tsx']);
    expect(() => resolveSandboxKitFiles(variants, { wrapper: 'nope.tsx' })).toThrow(
      /wrapper "nope.tsx" was not found/,
    );
  });

  it('bundles the wrapper with the kit, and the frame renders <Wrapper><App/></Wrapper>', async () => {
    const files = resolveSandboxKitFiles(variants, {
      components: 'mui/components.tsx',
      wrapper: 'mui/wrapper.tsx',
    });
    if (files === null) throw new Error('no kit');
    const bundle = await buildSandboxKitBundle({ root: variants, files });
    expect(bundle.code).toContain('window.KitWrapper');
    expect(bundle.code).toContain('window.Kit');
    expect(bundle.exports).toContain('PriceTag');
    expect(bundle.exports).toContain('Button');
    const runtime = sandboxJsxRuntime({ token: 't', jsxMessage: 'm' });
    expect(runtime).toContain('root.render(W?R.createElement(W,null,view):view)');
  }, 120_000);

  it('a JavaScript project: names, propTypes and defaultProps from the bundle', async () => {
    const files = resolveSandboxKitFiles(variants, { components: 'plain/widgets.jsx' });
    if (files === null) throw new Error('no kit');
    const bundle = await buildSandboxKitBundle({ root: variants, files });
    expect(kitDocsFromBundle(bundle.code)).toEqual([
      {
        name: 'Badge',
        props: [
          { name: 'tone', type: 'string', required: false, default: '"info"' },
          { name: 'children', type: 'unknown', required: false },
        ],
      },
    ]);
  }, 60_000);
});

describe('zero-config discovery', () => {
  it('finds the style entries among the Vite input (the AdonisJS entrypoints) and what scripts import', () => {
    const root = project('zero-adonis', {
      'package.json': '{}',
      'resources/css/app.css': '.a{}',
      'resources/js/app.tsx':
        "import '../css/extra.scss'\nimport './button.module.css'\nimport x from './x'\n",
      'resources/css/extra.scss': '.b{}',
      'resources/js/button.module.css': '.c{}',
    });
    expect(
      discoverStyleEntries(root, {
        input: [join(root, 'resources/css/app.css'), join(root, 'resources/js/app.tsx')],
      }).map((file) => file.slice(root.length + 1)),
    ).toEqual(['resources/css/app.css', 'resources/css/extra.scss']);
  });

  it("falls back to index.html: its stylesheet links and its module scripts' imports", () => {
    const root = project('zero-spa', {
      'package.json': '{}',
      'index.html':
        '<link rel="stylesheet" href="/src/base.css"><link rel="icon" href="/x.ico"><link rel="stylesheet" href="https://fonts.test/a.css"><script type="module" src="/src/main.tsx"></script>',
      'src/base.css': '.a{}',
      'src/main.tsx': "import './index.css'\n",
      'src/index.css': '.b{}',
    });
    expect(discoverStyleEntries(root).map((file) => file.slice(root.length + 1))).toEqual([
      'src/base.css',
      'src/index.css',
    ]);
  });

  it('the plugin with no options: those styles, and the components/ui folder', async () => {
    const root = project('zero-plugin', {
      'package.json': '{}',
      'index.html': '<script type="module" src="/src/main.tsx"></script>',
      'src/main.tsx': "import './index.css'\n",
      'src/index.css': ':root{--brand:#f00}.hero{color:var(--brand)}',
      'src/components/ui/badge.tsx':
        'export function Badge(){ return <span className="hero" /> }\n',
    });
    const plugin = genuiSandboxKit({ typescript: await import('typescript5') });
    const vite = await import('vite');
    await vite.build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [plugin],
      build: { outDir: join(root, 'dist'), manifest: true },
    });
    const { readFileSync } = await import('node:fs');
    const manifest = JSON.parse(readFileSync(join(root, 'dist/.vite/manifest.json'), 'utf8'));
    const descriptor = JSON.parse(
      readFileSync(join(root, 'dist', manifest['genui-sandbox-kit.json'].file), 'utf8'),
    );
    expect(descriptor.components.map((c: { name: string }) => c.name)).toEqual(['Badge']);
    expect(descriptor.vocabulary.groups.map((g: { name: string }) => g.name)).toEqual(['hero']);
    // Minified: `#f00` or `red`, depending on the CSS minifier of the Vite version.
    expect(descriptor.theme.vars['--brand']).toMatch(/^(red|#f00)$/);
    expect(descriptor.assets.css).not.toBeNull();
    expect(descriptor.assets.tailwind).toBeNull();
  }, 120_000);

  it('resolves package stylesheets the way CSS does (exports `style`, the `style` field)', () => {
    expect(resolveStyleImport('bootstrap/dist/css/bootstrap.css', variants)).toMatch(
      /bootstrap\.css$/,
    );
    expect(resolveStyleImport('bootstrap', variants)).toMatch(/bootstrap(\.min)?\.css$/);
    expect(resolveStyleImport('tailwindcss', variants)).toMatch(/tailwindcss\/index\.css$/);
    const sources = collectStyleSources([join(variants, 'tailwind/styles.css')]);
    // The tailwindcss package itself is not read (the frame brings the runtime); fontsource's is.
    expect(sources.map((source) => source.file.split('/').slice(-3).join('/'))).toEqual([
      'sandbox-kit-variants/tailwind/styles.css',
      '@fontsource-variable/geist/index.css',
    ]);
  });
});

describe('options from before 0.75', () => {
  it('the plugin, the hook, the docs writer and defineSandbox say what replaced them', async () => {
    expect(() => genuiSandboxKit({ include: 'components/ui/*.tsx' } as never)).toThrow(
      /option `include` was removed in 0\.75 — `include: G` is now `components: G`/,
    );
    expect(() =>
      genuiSandboxKit({ entry: 'kit.ts', tailwind: true, tailwindCss: ['a.css'] } as never),
    ).toThrow(
      /options `entry`, `tailwind`, `tailwindCss` were removed in 0\.75.*`components: X`.*detected from `styles`.*pass the stylesheet itself as `styles`/,
    );
    expect(() => genuiKitHook({ css: 'app.css' } as never)).toThrow(
      /genuiKitHook: option `css`.*`styles: G`/,
    );
    await expect(writeSandboxKitDocs({ output: 'x.json', include: 'a' } as never)).rejects.toThrow(
      /writeSandboxKitDocs/,
    );
    expect(() => defineSandbox({ kit: true, tailwind: true } as never)).toThrow(
      /defineSandbox: `tailwind` was removed in 0\.75/,
    );
  });
});

describe('the prompt describes only what exists', () => {
  it('no kit docs (yet): the plain sandbox, no JSX', () => {
    const sandbox = defineSandbox({ kit: () => undefined });
    expect(sandbox.description).not.toContain('function App()');
    expect(sandbox.description).not.toContain('Tailwind');
  });

  it('a wrapper without components: JSX with plain elements, inside the providers', () => {
    const sandbox = defineSandbox({
      kit: { version: 2, components: [], jsx: true, wrapper: true },
    });
    expect(sandbox.description).toContain('function App()');
    expect(sandbox.description).toContain('use plain elements');
    expect(sandbox.description).toContain("inside the app's own providers");
    expect(sandbox.description).not.toContain('Kit components');
  });

  it('the guide is appended, and root vars only come from theme selectors', () => {
    const sandbox = defineSandbox({
      kit: { version: 2, components: [], guide: 'Cards use .panel, never .card.' },
    });
    expect(sandbox.description).toContain("The app's notes on its styles:\nCards use .panel");
    expect(
      themeVarsFromCss('.btn{--x:1} :root{--y:2} html[data-theme=dark]{--z:3}', { rootOnly: true }),
    ).toEqual({
      '--y': '2',
      '--z': '3',
    });
  });
});

describe('discovery outside production', () => {
  it('a dev descriptor left over from an earlier dev server does not shadow a newer build', async () => {
    const { sandboxKitDiscovery } = await import('../src/genui/kit/discover.js');
    const { utimesSync } = await import('node:fs');
    const descriptor = (url: string) =>
      JSON.stringify({
        version: 2,
        components: [],
        assets: { kit: { url }, css: null, tailwind: null },
      });
    const root = project('freshness', {
      '.dev/kit.json': descriptor('/@genui-sandbox-kit/kit.js'),
      'dist/.vite/manifest.json': JSON.stringify({
        'genui-sandbox-kit.json': { file: 'assets/kit.json' },
      }),
      'dist/assets/kit.json': descriptor('/assets/genui-sandbox-kit-abc.js'),
    });
    const discovery = sandboxKitDiscovery({
      root,
      production: false,
      descriptor: '.dev/kit.json',
      manifest: { file: 'dist/.vite/manifest.json', outDir: 'dist' },
    });
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(root, '.dev/kit.json'), old, old);
    expect(discovery.descriptor()?.assets.kit?.url).toBe('/assets/genui-sandbox-kit-abc.js');
    // The dev server writes again: now it is the newer one.
    writeFileSync(join(root, '.dev/kit.json'), descriptor('/@genui-sandbox-kit/kit.js?v=2'));
    expect(discovery.descriptor()?.assets.kit?.url).toBe('/@genui-sandbox-kit/kit.js?v=2');
    // A dev server in this process always wins.
    const live = sandboxKitDiscovery({
      root,
      production: false,
      descriptor: '.dev/kit.json',
      plugin: () => ({
        descriptor: () => JSON.parse(descriptor('/live.js')),
        ready: async () => {},
      }),
    });
    expect(live.descriptor()?.assets.kit?.url).toBe('/live.js');
  });
});

describe('theme variables from workspace packages', () => {
  it('a stylesheet a workspace package provides (linked into node_modules) is followed by its imports', async () => {
    const { symlinkSync } = await import('node:fs');
    const root = project('workspace', {
      'package.json': '{}',
      'packages/ui/package.json':
        '{"name":"@workspace/ui","exports":{"./globals.css":"./src/globals.css"}}',
      'packages/ui/src/globals.css':
        ':root { --gold: #d6b46c; --surface: #101319; }\n.card-surface { background: var(--surface); }\n',
      'apps/web/app.css': '@import "@workspace/ui/globals.css";\n.page { color: var(--gold); }\n',
    });
    mkdirSync(join(root, 'node_modules/@workspace'), { recursive: true });
    symlinkSync(join(root, 'packages/ui'), join(root, 'node_modules/@workspace/ui'));
    const styles = await buildSandboxKitStyles({ root, entries: [join(root, 'apps/web/app.css')] });
    expect(styles?.vars).toMatchObject({ '--gold': '#d6b46c', '--surface': '#101319' });
    expect(
      styles?.files.some((file) => file.includes('@workspace/ui') || file.includes('packages/ui')),
    ).toBe(true);
    expect(styles?.vocabulary?.groups.map((group) => group.name)).toEqual(
      expect.arrayContaining(['card', 'page']),
    );
  }, 60_000);
});

describe('rebuilds in dev', () => {
  it('run one at a time: a slow build started first never lands after a newer one', async () => {
    const root = project('serial', {
      'package.json': '{}',
      'plain.css': ':root { --brand: #123456; }\n.plain-card { padding: 1rem; }\n',
      'slow.scss': `$primary: #7c3aed;\n@import "bootstrap/scss/bootstrap";\n`,
    });
    // Symlink-free: the scratch project resolves bootstrap from the package's node_modules.
    let styles = 'slow.scss';
    const plugin = genuiSandboxKit({
      get styles() {
        return styles;
      },
      descriptor: '.genui/kit.json',
    } as never);
    const vite = await import('vite');
    const server = await vite.createServer({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [plugin],
      server: { middlewareMode: true, watch: null },
      appType: 'custom',
    });
    try {
      await plugin.api.ready();
      styles = 'plain.css';
      server.watcher.emit('change', join(root, 'plain.css'));
      await new Promise((r) => setTimeout(r, 250));
      // Back to the slow one, then quickly to the plain one again: the last asked for must win.
      styles = 'slow.scss';
      server.watcher.emit('change', join(root, 'slow.scss'));
      await new Promise((r) => setTimeout(r, 250));
      styles = 'plain.css';
      server.watcher.emit('change', join(root, 'plain.css'));
      const deadline = Date.now() + 60_000;
      const groups = () =>
        plugin.api.descriptor()?.vocabulary?.groups.map((group: { name: string }) => group.name) ??
        [];
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        if (groups().includes('plain')) {
          // Settled? Give any older build time to (wrongly) land.
          await new Promise((r) => setTimeout(r, 6000));
          break;
        }
      }
      expect(groups()).toEqual(['plain']);
    } finally {
      await server.close();
    }
  }, 120_000);
});

describe('jsx or html', () => {
  it('a stylesheet-only kit offers no jsx field; a kit with a bundle does', async () => {
    const { defineSandbox: define } = await import('../src/genui/sandbox.js');
    let docs: { version: 2; components: never[]; jsx?: boolean } = { version: 2, components: [] };
    const sandbox = define({ kit: () => docs });
    const fields = () =>
      Object.keys((sandbox.props as { properties: Record<string, unknown> }).properties);
    expect(fields()).not.toContain('jsx');
    docs = { version: 2, components: [], jsx: true };
    expect(fields()).toContain('jsx');
    // `kit: true` (a browser's copy of the catalog) keeps it, as before.
    expect(
      Object.keys((define({ kit: true }).props as { properties: object }).properties),
    ).toContain('jsx');
  });

  it('a model filling every field (strict tool calls): the field holding the view wins', async () => {
    const { sandboxDrawsJsx } = await import('../src/genui/sandbox.js');
    const html =
      '<div class="card"><div class="card-body"><h5>Split the bill</h5><button class="btn btn-primary">Settle</button></div></div>';
    expect(sandboxDrawsJsx({ jsx: 'function App() {return null;}', html })).toBe(false);
    expect(
      sandboxDrawsJsx({
        jsx: `function App() { return (<Card>${'x'.repeat(200)}</Card>) }`,
        html: '<div></div>',
      }),
    ).toBe(true);
    expect(sandboxDrawsJsx({ jsx: '', html: '' })).toBe(false);
    expect(sandboxDrawsJsx({ jsx: 'function App() { return <p/> }' })).toBe(true);
    expect(defineSandbox({ kit: { version: 2, components: [], jsx: true } }).description).toContain(
      'never both',
    );
  });
});

describe('the names the model is given are the ones in the frame', () => {
  it('lists `var(--color-…)` as it is, and the Tailwind utility separately', () => {
    const vars = {
      '--color-surface-secondary': '#f4f4f5',
      '--color-primary': '#7c3aed',
      '--primary': '#111',
    };
    const text = themeToModelText(vars);
    expect(text).toContain('var(--color-surface-secondary)');
    expect(text).toContain('var(--color-primary)');
    expect(text).toContain('var(--primary)');
    expect(text).not.toContain('var(--surface-secondary)');
    const tokens = {
      colors: [],
      radius: [],
      fonts: [],
      shadows: [],
      text: [],
      animations: [],
      utilities: [],
      variants: [],
    };
    const sandbox = defineSandbox({
      kit: { version: 2, components: [], tailwind: { version: 4, tokens }, theme: { vars } },
    });
    expect(sandbox.description).toContain('var(--color-surface-secondary)');
    expect(sandbox.description).toContain('surface-secondary');
    expect(sandbox.description).toMatch(/colors [^.]*surface-secondary[^.]*\(bg-\*/);
    expect(sandbox.description).not.toContain('var(--surface-secondary)');
    // And the view uses the frame's width.
    expect(sandbox.description).toContain('full width');
  });

  it('follows the imports of a pnpm-injected workspace package from where it really is', async () => {
    const { symlinkSync } = await import('node:fs');
    const store = 'node_modules/.pnpm/@workspace+ui@file+packages+ui/node_modules';
    const root = project('injected', {
      'package.json': '{}',
      [`${store}/@workspace/ui/package.json`]:
        '{"name":"@workspace/ui","exports":{"./globals.css":"./src/globals.css"}}',
      [`${store}/@workspace/ui/src/globals.css`]:
        '@import "tailwindcss";\n@import "shadcn/tailwind.css";\n:root { --gold: #d6b46c; }\n',
      [`${store}/shadcn/package.json`]:
        '{"name":"shadcn","exports":{"./tailwind.css":{"style":"./dist/tailwind.css"}}}',
      [`${store}/shadcn/dist/tailwind.css`]:
        '@custom-variant data-open (&:where([data-state="open"]));\n@custom-variant data-horizontal (&:where([data-orientation="horizontal"]));\n',
      'apps/web/app.css': '@import "@workspace/ui/globals.css";\n',
    });
    mkdirSync(join(root, 'node_modules/@workspace'), { recursive: true });
    symlinkSync(join(root, store, '@workspace/ui'), join(root, 'node_modules/@workspace/ui'));
    const styles = await buildSandboxKitStyles({
      root,
      entries: [join(root, 'apps/web/app.css')],
      compile: false,
    });
    expect(styles?.tailwind?.tokens.variants).toEqual(['data-open', 'data-horizontal']);
    expect(styles?.files.some((file) => file.endsWith('shadcn/dist/tailwind.css'))).toBe(true);
  });
});
