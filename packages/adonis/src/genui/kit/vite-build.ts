/**
 * One in-memory build with the app's Vite (`vite.build`, nothing written) — what both the kit bundle
 * and the compiled styles come from. The app's `resolve` (aliases) and `css` options (preprocessor
 * options, CSS modules, PostCSS, Lightning CSS) are kept, so `@/lib/utils`, a Sass `additionalData`
 * or a PostCSS plugin work as they do in the app; assets referenced by the CSS are inlined as
 * `data:` URIs up to a limit and a budget, the rest left out (the frame has no network).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { INLINE_ASSET_DEFAULTS, inlineCssUrls } from '../sandbox-styles.js';

/** What a build produced. */
export interface KitBuildOutput {
  /** The entry chunk (an IIFE). */
  code: string;
  /** Every CSS file the build emitted, together, its `url()`s made network-less. */
  css: string;
  /** The app modules the build read (`node_modules` and virtual ones left out). */
  modules: string[];
}

export interface KitBuildOptions {
  root: string;
  /** The entry module's source (a virtual module; may import anything the app can). */
  entry: string;
  /** `resolve` from the app's Vite config (aliases, dedupe, conditions). */
  resolve?: Record<string, unknown>;
  /** `css` from the app's Vite config (preprocessorOptions, modules, postcss, transformer…). */
  css?: Record<string, unknown>;
  /** The app's public directory (absolute urls in CSS are read from it), or `false`. */
  publicDir?: string | false;
  /** Extra Vite plugins (Tailwind's, one the components need to compile). */
  plugins?: unknown[];
  /** Largest asset inlined, in bytes. */
  inlineAssetLimit?: number;
  /** Most bytes inlined in all. */
  inlineAssetBudget?: number;
  /** Told about every asset left out. */
  warn?: (message: string) => void;
  /** Default true. */
  minify?: boolean;
}

/** The entry's file name (Vite resolves an input against the root) and its virtual id. */
const ENTRY_FILE = 'genui-sandbox-kit-entry.js';
const ENTRY_ID = '\0genui-sandbox-kit-entry';

interface OutputItemLike {
  type: 'chunk' | 'asset';
  fileName: string;
  isEntry?: boolean;
  code?: string;
  source?: string | Uint8Array;
  moduleIds?: string[];
  modules?: Record<string, unknown>;
  originalFileNames?: string[];
}

const MIME: Record<string, string> = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.cur': 'image/x-icon',
};

export async function runKitViteBuild(options: KitBuildOptions): Promise<KitBuildOutput> {
  const vite = (await import('vite')) as typeof import('vite');
  const major = Number.parseInt(String(vite.version).split('.')[0] ?? '0', 10);
  const limit = options.inlineAssetLimit ?? INLINE_ASSET_DEFAULTS.limit;
  const budget = options.inlineAssetBudget ?? INLINE_ASSET_DEFAULTS.budget;
  let inlined = 0;
  const reasons = new Map<string, string>();
  const result = await vite.build({
    configFile: false,
    root: options.root,
    logLevel: 'silent',
    mode: 'production',
    publicDir: options.publicDir ?? false,
    // One React: components living outside the app (a workspace package, another repo) resolve
    // `react` from the app root too, never a second copy that would break their hooks.
    resolve: {
      ...(options.resolve ?? {}),
      dedupe: [
        ...(((options.resolve as { dedupe?: string[] } | undefined)?.dedupe ?? []) as string[]),
        'react',
        'react-dom',
      ],
    } as never,
    css: quietCss(options.css) as never,
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    // Vite 8 compiles with Oxc, earlier versions with esbuild: the automatic JSX runtime on both.
    // Production JSX (`jsx`, never `jsxDEV`) whatever NODE_ENV the dev server runs under.
    ...(major >= 8
      ? ({ oxc: { jsx: { runtime: 'automatic', development: false } } } as Record<string, unknown>)
      : { esbuild: { jsx: 'automatic', jsxDev: false } }),
    plugins: [
      {
        name: 'genui-sandbox-kit-entry',
        resolveId(id: string) {
          if (id === ENTRY_ID || id.endsWith(ENTRY_FILE)) return ENTRY_ID;
          return null;
        },
        load(id: string) {
          return id === ENTRY_ID ? options.entry : null;
        },
      },
      ...((options.plugins ?? []) as never[]),
    ],
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: options.minify ?? true,
      sourcemap: false,
      cssCodeSplit: false,
      reportCompressedSize: false,
      modulePreload: false,
      // Inlined (`data:`) within the limit and the budget; the rest is emitted, then left out below.
      assetsInlineLimit: (file: string, content: Buffer) => {
        const name = relative(options.root, file) || file;
        if (content.length > limit) {
          reasons.set(file, `${name} (${kb(content.length)}) is over the ${kb(limit)} limit`);
          return false;
        }
        if (inlined + content.length > budget) {
          reasons.set(file, `${name} is over the ${kb(budget)} budget for inlined assets`);
          return false;
        }
        inlined += content.length;
        return true;
      },
      rollupOptions: {
        input: ENTRY_FILE,
        output: {
          format: 'iife',
          name: '__genuiSandboxKit',
          // One file (Rolldown already bundles an IIFE into one, and warns about the option).
          ...(major >= 8 ? {} : { inlineDynamicImports: true }),
          entryFileNames: 'genui-sandbox-kit.js',
        },
      },
    },
  } as never);
  const outputs = (Array.isArray(result) ? result : [result]) as unknown as {
    output: OutputItemLike[];
  }[];
  let code = '';
  let css = '';
  const modules = new Set<string>();
  const emitted = new Map<string, string | undefined>();
  for (const out of outputs) {
    for (const item of out.output ?? []) {
      if (item.type === 'chunk') {
        code += item.code ?? '';
        for (const id of item.moduleIds ?? Object.keys(item.modules ?? {})) {
          if (
            !id.startsWith('\0') &&
            (!id.includes('/node_modules/') || /\/node_modules\/\.pnpm\/[^/]*@file\+/.test(id))
          )
            modules.add(id.split('?')[0] ?? id);
        }
      } else if (item.fileName.endsWith('.css')) {
        css +=
          typeof item.source === 'string'
            ? item.source
            : Buffer.from(item.source ?? new Uint8Array()).toString('utf8');
      } else {
        const original = item.originalFileNames?.[0];
        emitted.set(
          item.fileName,
          original === undefined ? undefined : resolve(options.root, original),
        );
      }
    }
  }
  const publicDir =
    options.publicDir === false || options.publicDir === undefined ? undefined : options.publicDir;
  css = inlineCssUrls(css, {
    limit,
    // Vite counted what it inlined; this pass only checks what is left.
    budget: Number.POSITIVE_INFINITY,
    ...(options.warn !== undefined ? { warn: options.warn } : {}),
    resolve(url) {
      const path = (url.split(/[?#]/)[0] ?? url).replace(/^\.?\//, '');
      for (const [fileName, original] of emitted) {
        if (path === fileName || path.endsWith(`/${fileName}`) || path.endsWith(fileName)) {
          return {
            dropped:
              (original !== undefined ? reasons.get(original) : undefined) ??
              `${fileName} was not inlined`,
          };
        }
      }
      if (publicDir !== undefined && url.startsWith('/')) {
        const file = join(publicDir, decodeURIComponent(path));
        if (existsSync(file) && statSync(file).isFile()) {
          const bytes = readFileSync(file);
          if (inlined + bytes.length > budget)
            return { dropped: `over the ${kb(budget)} budget for inlined assets` };
          inlined += bytes.length;
          return {
            data: bytes.toString('base64'),
            mime: MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
            bytes: bytes.length,
          };
        }
      }
      return null;
    },
  });
  return { code, css, modules: [...modules] };
}

/** Sass's deprecation warnings (Bootstrap's own, by the thousand) are not the kit's to print. */
const QUIET_SASS = { quietDeps: true, logger: { warn() {}, debug() {} } };

/** The app's `css` options, with Sass told to keep quiet unless the app said otherwise. */
function quietCss(css: Record<string, unknown> | undefined): Record<string, unknown> {
  const given = (css ?? {}) as {
    preprocessorOptions?: Record<string, Record<string, unknown> | undefined>;
  };
  const pre = given.preprocessorOptions ?? {};
  return {
    ...given,
    preprocessorOptions: {
      ...pre,
      scss: { ...QUIET_SASS, ...(pre.scss ?? {}) },
      sass: { ...QUIET_SASS, ...(pre.sass ?? {}) },
    },
  };
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}
