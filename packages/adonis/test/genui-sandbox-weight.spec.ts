// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { sandboxKitDiscovery } from '../src/genui/kit/discover.js';
import {
  assertSandboxKitName,
  sandboxKitDescriptorPath,
  sandboxKitManifestKeys,
} from '../src/genui/kit/plugin.js';
import { purgeSandboxKitStyles, type SandboxKitStyles } from '../src/genui/kit/styles.js';
import {
  buildSandboxDocument,
  SANDBOX_MESSAGE,
  sandboxCsp,
  sandboxSharedAssetsWanted,
} from '../src/genui/sandbox.js';
import {
  classTokensOf,
  compressClassNames,
  extractCssVocabulary,
  purgeCss,
  vocabularyToModelText,
} from '../src/genui/sandbox-styles.js';

/*
 * What a sandbox frame weighs: the shared-asset document (no kit, styles or Tailwind runtime in each
 * srcdoc), the compiled styles purged to what can be used, and a class vocabulary written as
 * patterns (complete, and still small) — plus named kits, several in one app.
 */

const BIG = 'x'.repeat(50_000);

describe('the shared-asset document', () => {
  const base = { token: 'tok', hostOrigin: 'https://app.test', mode: 'live' as const };

  it('carries none of the heavy assets, only where they go, and asks for them', () => {
    const doc = buildSandboxDocument(
      { css: '.mine{}' },
      {
        ...base,
        inlineJs: false,
        styles: `.kit{}${BIG}`,
        tailwind: { runtime: `/*tw*/${BIG}`, theme: '@theme { --color-gold: gold; }' },
        kit: `/*kit*/${BIG}`,
        initialJsx: { code: 'function App(){return <p>hi</p>}', final: true },
        sharedAssets: { styles: true, tailwind: true, kit: true },
      },
    );
    expect(doc.length).toBeLessThan(40_000);
    expect(doc).not.toContain(BIG);
    // The places the assets go, in the inlined document's order: kit styles, theme, Tailwind, model.
    const order = [
      'agora-sandbox-kit-css',
      'agora-sandbox-theme',
      'agora-sandbox-tw',
      'agora-sandbox-css',
    ];
    const at = order.map((id) => doc.indexOf(`id="${id}"`));
    expect(at.every((index) => index > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(doc).toContain('@theme { --color-gold: gold; }');
    // Hidden until the assets are in; the JSX runtime runs after them.
    expect(doc).toContain('<style id="agora-sandbox-wait">body{visibility:hidden}</style>');
    expect(doc).toContain('window.__agoraAfterAssets=function(){');
    expect(doc).toContain('post(M.load,{})');
    expect(SANDBOX_MESSAGE.load).toBe('agora:sandbox:load');
  });

  it('keeps the inline CSP: nothing more allowed than an inlined document', () => {
    const doc = buildSandboxDocument(
      {},
      { ...base, sharedAssets: { styles: true, tailwind: true, kit: true } },
    );
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(doc)?.[1];
    expect(csp?.replace(/&quot;/g, '"')).toBe(sandboxCsp());
    expect(csp).not.toMatch(/script-src[^;]*blob:/);
    expect(csp).not.toMatch(/style-src[^;]*blob:/);
  });

  it('runs the model’s scripts after the assets, in order', () => {
    const doc = buildSandboxDocument(
      { html: '<p id="x"></p>', jsFunctions: 'function f(){}', jsExpressions: ['f()', 'g()'] },
      { ...base, styles: '.kit{}', sharedAssets: { styles: true } },
    );
    const after = doc.slice(doc.indexOf('window.__agoraAfterAssets=function(){'));
    expect(after.indexOf('function f(){}')).toBeLessThan(after.indexOf('f()'));
    expect(after.indexOf('"f()"')).toBeLessThan(after.indexOf('"g()"'));
    // Not run a second time inline.
    expect(doc.match(/function f\(\)\{\}/g)).toHaveLength(1);
  });

  it('a script closing tag in shared code cannot close the element', () => {
    const doc = buildSandboxDocument(
      { jsExpressions: ['document.body.append("</script><b>")'] },
      { ...base, sharedAssets: { styles: true } },
    );
    expect(doc).not.toContain('</script><b>');
  });

  it('react-native always inlines (its bridge carries strings only)', () => {
    const options = {
      ...base,
      transport: 'react-native' as const,
      styles: '.kit{}',
      sharedAssets: { styles: true },
    };
    expect(sandboxSharedAssetsWanted(options)).toEqual({
      styles: false,
      tailwind: false,
      kit: false,
    });
    const doc = buildSandboxDocument({}, options);
    expect(doc).toContain('.kit{}');
    expect(doc).not.toContain('post(M.load,{})');
  });

  it('without sharedAssets the document is the inlined one, as before', () => {
    const doc = buildSandboxDocument({}, { ...base, styles: `.kit{}${BIG}` });
    expect(doc).toContain(BIG);
    expect(doc).not.toContain('agora-sandbox-wait');
    expect(doc).toContain('post(M.ready,{height:last})}');
    expect(doc).not.toContain('post(M.load,{})');
  });

  it('measures open overlays (dialogs, menus, popovers) as well as the content', () => {
    const doc = buildSandboxDocument({}, base);
    expect(doc).toContain('dialog[open]');
    expect(doc).toContain(':popover-open');
    expect(doc).toContain('[aria-modal="true"]');
  });

  it("the frame's page is see-through, whatever a baseline paints on the body", () => {
    const doc = buildSandboxDocument({}, base);
    expect(doc).toContain('html,body{background-color:transparent!important');
  });
});

describe('purging the compiled styles', () => {
  const TAILWIND = [
    '@layer theme,base,components,utilities;',
    '@layer theme{:root{--color-gold:gold}}',
    '@layer base{*,:after{box-sizing:border-box}h1{font-size:2em}}',
    '@layer components{.kit-title{font-weight:700}}',
    '@layer utilities{.flex{display:flex}.p-6{padding:1.5rem}.hover\\:bg-gold:hover{background:gold}@media (min-width:40rem){.sm\\:p-6{padding:1.5rem}.sm\\:flex{display:flex}}.text-\\[13px\\]{font-size:13px}}',
    '@font-face{font-family:Geist;src:url(data:font/woff2;base64,AAAA)}',
    '@keyframes spin{to{transform:rotate(1turn)}}',
    '@property --tw-x{syntax:"*";inherits:false}',
    '.app-shell{display:grid}',
  ].join('');

  it('Tailwind v4: only the utilities the kit names stay; theme, base, components and at-rules stay whole', () => {
    const used = classTokensOf('cn("flex hover:bg-gold", `sm:flex ${x}`, "text-[13px]")');
    const out = purgeCss(TAILWIND, { keep: (name) => used.has(name), scope: 'utilities' });
    expect(out).toContain('.flex{display:flex}');
    expect(out).toContain('.hover\\:bg-gold:hover');
    expect(out).toContain('.sm\\:flex');
    expect(out).toContain('.text-\\[13px\\]');
    expect(out).not.toContain('.p-6');
    expect(out).not.toContain('.sm\\:p-6');
    for (const kept of [
      '@layer theme,base,components,utilities;',
      '--color-gold:gold',
      'h1{font-size:2em}',
      '.kit-title{font-weight:700}',
      '@font-face',
      '@keyframes spin',
      '@property --tw-x',
      '.app-shell{display:grid}',
    ])
      expect(out).toContain(kept);
  });

  it('drops a grouping rule left empty, and single selectors of a list', () => {
    const out = purgeCss('@media print{.a{x:1}}.a,.b,p{y:2}.c:not(.d){z:3}', {
      keep: (name) => name === 'b' || name === 'c',
      scope: 'all',
    });
    expect(out).not.toContain('@media');
    expect(out).toContain('.b,p{y:2}');
    // A class under :not() is not required to be on the page.
    expect(out).toContain('.c:not(.d){z:3}');
  });

  it('keeping everything returns the stylesheet as it was', () => {
    expect(purgeCss(TAILWIND, { keep: () => true, scope: 'all' })).toBe(TAILWIND);
  });

  const styles = (css: string, tailwind?: 3 | 4): SandboxKitStyles => ({
    css,
    hash: 'h',
    files: [],
    vars: {},
    ...(tailwind !== undefined
      ? {
          tailwind: {
            version: tailwind,
            tokens: {
              colors: [],
              radius: [],
              fonts: [],
              shadows: [],
              text: [],
              animations: [],
              utilities: [],
              variants: [],
            },
            directives: '',
          },
        }
      : {}),
  });

  it('plain CSS: every class the model is told stays; generated CSS-modules ones only if the kit uses them', () => {
    const css = '.btn{a:1}.btn-primary{b:2}._card_x1y2z_3{c:3}._unused_q9w8e_1{d:4}';
    const out = purgeSandboxKitStyles(styles(css), { kitCode: 'className:"_card_x1y2z_3"' });
    expect(out.css).toContain('.btn{a:1}');
    expect(out.css).toContain('.btn-primary');
    expect(out.css).toContain('._card_x1y2z_3');
    expect(out.css).not.toContain('_unused_');
    expect(out.purged?.before).toBe(css.length);
    expect(out.hash).not.toBe('h');
  });

  it('Tailwind v3 (no layers): rules naming a class the kit does not use go; the safelist keeps more', () => {
    const css = '*{margin:0}.flex{display:flex}.prose{max-width:65ch}.grid{display:grid}';
    const out = purgeSandboxKitStyles(styles(css, 3), { kitCode: '"flex"', safelist: [/^pro/] });
    expect(out.css).toBe('*{margin:0}.flex{display:flex}.prose{max-width:65ch}');
  });

  it('nothing to take out: the same styles object back', () => {
    const given = styles('.btn{a:1}');
    expect(purgeSandboxKitStyles(given)).toBe(given);
  });
});

/** Every class a pattern stands for (`{a,b}`, `{0..3}`, `m{,t}`). */
function expand(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (match === null) return [pattern];
  const alternatives = (match[1] as string).split(',').flatMap((each) => {
    const range = /^(\d+)\.\.(\d+)$/.exec(each);
    if (range === null) return [each];
    const out: string[] = [];
    for (let n = Number(range[1]); n <= Number(range[2]); n++) out.push(String(n));
    return out;
  });
  return alternatives.flatMap((each) =>
    expand(pattern.slice(0, match.index) + each + pattern.slice(match.index + match[0].length)),
  );
}

describe('the class vocabulary as patterns', () => {
  it('ranges, shared tails and breakpoints, every name covered exactly once', () => {
    const names = [
      ...['m', 'mt', 'mb'].flatMap((p) => ['0', '1', '2', '3', 'auto'].map((v) => `${p}-${v}`)),
      ...['m', 'mt', 'mb'].flatMap((p) =>
        ['sm', 'md'].flatMap((bp) => ['0', '1', '2', '3'].map((v) => `${p}-${bp}-${v}`)),
      ),
    ];
    const patterns = compressClassNames(names);
    expect(patterns).toEqual(['m{,t,b}-{0..3,auto}', 'm{,t,b}-{sm,md}-{0..3}']);
    expect(patterns.flatMap(expand).sort()).toEqual([...names].sort());
  });

  it('bare words never merge with each other', () => {
    expect(compressClassNames(['alert', 'alert-info', 'alert-danger', 'fade'])).toEqual([
      'alert',
      'alert-{info,danger}',
      'fade',
    ]);
  });

  it('Bootstrap: every class, spacing included, in a prompt-sized text', () => {
    const require = createRequire(import.meta.url);
    const css = readFileSync(require.resolve('bootstrap/dist/css/bootstrap.css'), 'utf8');
    const vocabulary = extractCssVocabulary(css);
    expect(vocabulary.listed).toBe(vocabulary.total);
    const text = vocabularyToModelText(vocabulary);
    expect(text.length).toBeLessThan(12_000);
    expect(text).not.toContain('rarer classes not listed');
    // Spacing as one pattern per family shape, not 600 names.
    expect(text).toContain('m{,b,e,s,t,x,y}-{0..5,auto}');
    expect(text).toContain('m{,b,e,s,t,x,y}-{lg,md,sm,xl,xxl}-{0..5,auto}');
    const covered = new Set(vocabulary.groups.flatMap((group) => group.classes.flatMap(expand)));
    for (const name of [
      'mt-3',
      'px-2',
      'p-md-4',
      'gap-2',
      'btn-outline-primary',
      'col-lg-6',
      'd-md-flex',
      'ms-auto',
    ])
      expect(covered.has(name), name).toBe(true);
    // And nothing the stylesheet does not define.
    for (const name of covered) expect(css.includes(`.${name}`), name).toBe(true);
  });
});

describe('named kits', () => {
  it('their own manifest keys and descriptor file', () => {
    expect(sandboxKitManifestKeys()).toEqual({
      kit: 'genui-sandbox-kit.js',
      css: 'genui-sandbox-kit.css',
      tailwind: 'genui-sandbox-tailwind.js',
      descriptor: 'genui-sandbox-kit.json',
    });
    expect(sandboxKitManifestKeys('bootstrap')).toEqual({
      kit: 'genui-sandbox-kit.bootstrap.js',
      css: 'genui-sandbox-kit.bootstrap.css',
      tailwind: 'genui-sandbox-tailwind.bootstrap.js',
      descriptor: 'genui-sandbox-kit.bootstrap.json',
    });
    expect(sandboxKitDescriptorPath('.adonisjs/agent/genui_sandbox_kit.json', 'mui')).toBe(
      '.adonisjs/agent/genui_sandbox_kit.mui.json',
    );
    expect(sandboxKitDescriptorPath('.adonisjs/agent/genui_sandbox_kit.json')).toBe(
      '.adonisjs/agent/genui_sandbox_kit.json',
    );
  });

  it('a name is a plain identifier (it goes into urls and file names)', () => {
    expect(() => assertSandboxKitName('../x')).toThrow(TypeError);
    expect(() => assertSandboxKitName('a b')).toThrow(TypeError);
    expect(() => assertSandboxKitName('lastro_v2')).not.toThrow();
    expect(() => assertSandboxKitName(undefined)).not.toThrow();
  });

  it('the discovery of a named kit reads its own manifest key', () => {
    const descriptor = {
      version: 2,
      components: [],
      assets: { kit: null, css: null, tailwind: null },
    };
    const read = new Map<string, unknown>();
    const discovery = sandboxKitDiscovery({
      root: '/nowhere',
      name: 'mui',
      production: true,
      plugin: () => ({
        kitName: 'mui',
        descriptor: () => descriptor as never,
        ready: async () => {},
      }),
    });
    expect(discovery.name).toBe('mui');
    expect(discovery.descriptor()).toBe(descriptor);
    expect(read.size).toBe(0);
  });
});
