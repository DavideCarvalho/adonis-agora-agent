/**
 * The app's styles in the sandbox — the Node half: which files they are (given, or found from the
 * app's Vite entrypoints), what they are (Tailwind v3/v4 or plain CSS), and what they compile to
 * with the app's own Vite CSS pipeline (Sass, Less, PostCSS, CSS modules, Tailwind's plugin…).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SandboxKitDocs } from '../sandbox-kit.js';
import {
  type CssVocabulary,
  extractCssVocabulary,
  type TailwindTokens,
  tailwindDirectivesFromCss,
  tailwindTokensFromCss,
  tailwindV3ConfigToCss,
  tailwindVersionOf,
} from '../sandbox-styles.js';
import { themeVarsFromCss } from '../sandbox-theme.js';
import { globFiles } from './files.js';
import { contentHash, runKitViteBuild } from './vite-build.js';

/** Extensions a style entry may have. */
export const STYLE_EXTENSIONS = [
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.styl',
  '.stylus',
  '.pcss',
  '.postcss',
  '.sss',
];

const isStyleFile = (file: string) =>
  STYLE_EXTENSIONS.includes(extname(file.split('?')[0] ?? file).toLowerCase());

/** The package a bare specifier names, found from `fromDir` up. */
function packageDir(name: string, fromDir: string): string | undefined {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** An `exports` target under the conditions a stylesheet import uses (`style`, then the defaults). */
function exportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const each of value) {
      const found = exportTarget(each);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    for (const condition of ['style', 'sass', 'import', 'default', 'require']) {
      if (condition in record) {
        const found = exportTarget(record[condition]);
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
}

/**
 * A stylesheet import as CSS resolves it: relative, absolute, an alias of the app's Vite config, or
 * a package (`bootstrap/dist/css/bootstrap.css`, `shadcn/tailwind.css`, `@fontsource-variable/geist`
 * — its `exports` under the `style` condition, its `style` field).
 */
export function resolveStyleImport(
  spec: string,
  fromDir: string,
  alias: Record<string, string> = {},
): string | undefined {
  let target = spec.replace(/^~(?!\/)/, '');
  for (const [key, value] of Object.entries(alias)) {
    if (target === key || target.startsWith(`${key}/`)) {
      target = `${value}${target.slice(key.length)}`;
      break;
    }
  }
  const file = (path: string) => (existsSync(path) && statSync(path).isFile() ? path : undefined);
  if (target.startsWith('.') || isAbsolute(target)) {
    const path = resolve(fromDir, target);
    return file(path) ?? file(`${path}.css`) ?? file(join(path, 'index.css'));
  }
  const parts = target.split('/');
  const name = target.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string);
  const sub = parts.slice(target.startsWith('@') ? 2 : 1).join('/');
  const dir = packageDir(name, fromDir);
  if (dir === undefined) return undefined;
  let manifest: { exports?: unknown; style?: string; main?: string } = {};
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    /* no manifest: paths only */
  }
  const exportsField = manifest.exports;
  if (typeof exportsField === 'object' && exportsField !== null && !Array.isArray(exportsField)) {
    const map = exportsField as Record<string, unknown>;
    const key = sub === '' ? '.' : `./${sub}`;
    const exact = map[key] !== undefined ? exportTarget(map[key]) : undefined;
    if (exact !== undefined) return file(join(dir, exact));
    for (const [pattern, value] of Object.entries(map)) {
      if (!pattern.includes('*')) continue;
      const [before, after] = pattern.split('*') as [string, string];
      if (key.startsWith(before) && key.endsWith(after)) {
        const star = key.slice(before.length, key.length - after.length);
        const found = exportTarget(value);
        if (found !== undefined) return file(join(dir, found.replace('*', star)));
      }
    }
  } else if (typeof exportsField === 'string' && sub === '') return file(join(dir, exportsField));
  if (sub !== '') return file(join(dir, sub)) ?? file(join(dir, `${sub}.css`));
  if (manifest.style !== undefined) return file(join(dir, manifest.style));
  if (manifest.main !== undefined && isStyleFile(manifest.main))
    return file(join(dir, manifest.main));
  return file(join(dir, 'index.css'));
}

/** The `@import`s of a stylesheet (plain CSS, and Sass/Less `@use`/`@forward`/`@import`). */
function importsOf(text: string): string[] {
  const out: string[] = [];
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of clean.matchAll(/@(?:import|use|forward)\s+(?:url\(\s*)?["']([^"']+)["']/g))
    out.push(match[1] as string);
  return out;
}

/** One stylesheet the app's styles are made of, as written. */
export interface StyleSource {
  file: string;
  text: string;
}

/**
 * The style entries and every stylesheet they `@import` (plain CSS imports are followed through
 * packages; Sass/Less partials are read for detection only). The `tailwindcss` package itself is
 * not read (the frame brings its own runtime).
 */
export function collectStyleSources(
  entries: readonly string[],
  options: { alias?: Record<string, string> } = {},
): StyleSource[] {
  const seen = new Set<string>();
  const out: StyleSource[] = [];
  const visit = (file: string, depth: number) => {
    if (seen.has(file) || depth > 16) return;
    seen.add(file);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    out.push({ file, text });
    for (const spec of importsOf(text)) {
      if (/^(https?:)?\/\//.test(spec) || /^tailwindcss(\/|$)/.test(spec)) continue;
      const found = resolveStyleImport(spec, dirname(file), options.alias);
      if (found !== undefined && /\.(css|pcss|postcss)$/i.test(found)) visit(found, depth + 1);
    }
  };
  for (const entry of entries) visit(entry, 0);
  return out;
}

/** The `styles` option as files: paths and globs relative to the root, or package stylesheets. */
export function resolveStyleEntries(
  root: string,
  styles: string | readonly string[],
): { files: string[]; missing: string[] } {
  const files: string[] = [];
  const missing: string[] = [];
  for (const spec of typeof styles === 'string' ? [styles] : styles) {
    if (/[*?{]/.test(spec)) {
      const matched = globFiles(root, spec);
      if (matched.length === 0) missing.push(spec);
      files.push(...matched);
      continue;
    }
    const path = isAbsolute(spec) ? spec : resolve(root, spec);
    if (existsSync(path) && statSync(path).isFile()) {
      files.push(path);
      continue;
    }
    const found = spec.startsWith('.') ? undefined : resolveStyleImport(spec, root);
    if (found !== undefined) files.push(found);
    else missing.push(spec);
  }
  return { files: [...new Set(files)], missing };
}

function inputList(input: unknown): string[] {
  if (typeof input === 'string') return [input];
  if (Array.isArray(input)) return input.filter((each): each is string => typeof each === 'string');
  if (typeof input === 'object' && input !== null)
    return Object.values(input).filter((each): each is string => typeof each === 'string');
  return [];
}

/**
 * The app's style entries, found from its Vite setup — what `genuiSandboxKit()` uses without
 * `styles`: the stylesheets among `build.rollupOptions.input` (the AdonisJS plugin puts its
 * `entrypoints` there) or linked from `index.html`, and those the script entries import directly
 * (`import './app.css'`). CSS modules are left out.
 */
export function discoverStyleEntries(root: string, options: { input?: unknown } = {}): string[] {
  const entries = inputList(options.input).map((each) =>
    isAbsolute(each) ? each : resolve(root, each),
  );
  if (entries.length === 0) {
    const html = join(root, 'index.html');
    if (existsSync(html)) {
      const text = readFileSync(html, 'utf8');
      for (const match of text.matchAll(/<link\b[^>]*>/gi)) {
        const tag = match[0];
        if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) continue;
        const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
        if (href !== undefined && !/^(https?:)?\/\//.test(href))
          entries.push(resolve(root, href.replace(/^\//, '')));
      }
      for (const match of text.matchAll(/<script\b[^>]*type\s*=\s*["']module["'][^>]*>/gi)) {
        const src = /src\s*=\s*["']([^"']+)["']/i.exec(match[0])?.[1];
        if (src !== undefined && !/^(https?:)?\/\//.test(src))
          entries.push(resolve(root, src.replace(/^\//, '')));
      }
    }
  }
  const styles: string[] = [];
  const add = (file: string) => {
    if (!/\.module\.[a-z]+$/i.test(file) && existsSync(file) && !styles.includes(file))
      styles.push(file);
  };
  for (const entry of entries) {
    if (isStyleFile(entry)) {
      add(entry);
      continue;
    }
    if (!existsSync(entry)) continue;
    let text: string;
    try {
      text = readFileSync(entry, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) {
      const spec = match[1] as string;
      if (!isStyleFile(spec)) continue;
      const found =
        spec.startsWith('.') || isAbsolute(spec)
          ? resolve(dirname(entry), spec)
          : resolveStyleImport(spec, dirname(entry));
      if (found !== undefined) add(found);
    }
  }
  return styles;
}

/** A Tailwind v3 config's theme as v4 directives (`tailwind.config.*` in the root, or `@config`). */
async function tailwindV3Css(
  root: string,
  sources: readonly StyleSource[],
  warn?: (message: string) => void,
): Promise<string> {
  let path: string | undefined;
  for (const source of sources) {
    const spec = /@config\s+["']([^"']+)["']/.exec(source.text)?.[1];
    if (spec !== undefined) {
      path = resolve(dirname(source.file), spec);
      break;
    }
  }
  path ??= ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs']
    .map((extension) => join(root, `tailwind.config.${extension}`))
    .find((candidate) => existsSync(candidate));
  if (path === undefined || !existsSync(path)) return '';
  try {
    const mod = (await import(`${pathToFileURL(path).href}?t=${statSync(path).mtimeMs}`)) as {
      default?: unknown;
    };
    return tailwindV3ConfigToCss(mod.default ?? mod);
  } catch (error) {
    warn?.(
      `the Tailwind v3 config ${path} did not load (${error instanceof Error ? error.message : String(error)}); the frame's Tailwind has the default theme`,
    );
    return '';
  }
}

/** The app's styles, compiled and understood. */
export interface SandboxKitStyles {
  /** Compiled CSS (fonts and images inlined). */
  css: string;
  hash: string;
  /** The files the styles are made of (entries and what they import) — what to watch. */
  files: string[];
  tailwind?: { version: 3 | 4; tokens: TailwindTokens; directives: string };
  vocabulary?: CssVocabulary;
  /** Custom properties on the styles' root. */
  vars: Record<string, string>;
}

export interface BuildSandboxKitStylesOptions {
  root: string;
  entries: readonly string[];
  resolve?: Record<string, unknown>;
  css?: Record<string, unknown>;
  publicDir?: string | false;
  plugins?: unknown[];
  inlineAssetLimit?: number;
  inlineAssetBudget?: number;
  warn?: (message: string) => void;
  /** Compile with Vite. Default true; false reads the files as they are (plain CSS only). */
  compile?: boolean;
}

/** Aliases of a resolved Vite `resolve` (object or array form) as `find → replacement` strings. */
export function stringAliases(
  resolveOptions: Record<string, unknown> | undefined,
): Record<string, string> {
  const alias = resolveOptions?.alias;
  const out: Record<string, string> = {};
  if (Array.isArray(alias)) {
    for (const entry of alias as { find?: unknown; replacement?: unknown }[])
      if (typeof entry.find === 'string' && typeof entry.replacement === 'string')
        out[entry.find] = entry.replacement;
  } else if (typeof alias === 'object' && alias !== null) {
    for (const [find, replacement] of Object.entries(alias as Record<string, unknown>))
      if (typeof replacement === 'string') out[find] = replacement;
  }
  return out;
}

/**
 * Compile the style entries with the app's Vite CSS pipeline and work out what they are: Tailwind
 * (its version, tokens, and the directives the frame's runtime needs — v3's config theme mapped to
 * v4), or plain CSS (its class vocabulary). `null` with no entries.
 */
export async function buildSandboxKitStyles(
  options: BuildSandboxKitStylesOptions,
): Promise<SandboxKitStyles | null> {
  if (options.entries.length === 0) return null;
  const sources = collectStyleSources(options.entries, { alias: stringAliases(options.resolve) });
  let css: string;
  if (options.compile === false) {
    css = sources
      .filter((source) => /\.css$/i.test(source.file))
      .map((source) => source.text)
      .join('\n');
  } else {
    const built = await runKitViteBuild({
      root: options.root,
      entry: options.entries.map((file) => `import ${JSON.stringify(file)};`).join('\n'),
      ...(options.resolve !== undefined ? { resolve: options.resolve } : {}),
      ...(options.css !== undefined ? { css: options.css } : {}),
      ...(options.publicDir !== undefined ? { publicDir: options.publicDir } : {}),
      ...(options.plugins !== undefined ? { plugins: options.plugins } : {}),
      ...(options.inlineAssetLimit !== undefined
        ? { inlineAssetLimit: options.inlineAssetLimit }
        : {}),
      ...(options.inlineAssetBudget !== undefined
        ? { inlineAssetBudget: options.inlineAssetBudget }
        : {}),
      ...(options.warn !== undefined ? { warn: options.warn } : {}),
    });
    css = built.css;
  }
  const versions = [
    ...sources.map((source) => tailwindVersionOf(source.text)),
    tailwindVersionOf(css),
  ].filter((version): version is 3 | 4 => version !== null);
  const version = versions.includes(4) ? 4 : versions.includes(3) ? 3 : undefined;
  const result: SandboxKitStyles = {
    css,
    hash: contentHash(css),
    files: sources.map((source) => source.file),
    vars: themeVarsFromCss(css, { rootOnly: true }),
  };
  if (version !== undefined) {
    const parts = new Set<string>();
    if (version === 3) {
      const mapped = await tailwindV3Css(options.root, sources, options.warn);
      if (mapped !== '') parts.add(mapped);
    }
    for (const source of sources) {
      const directives = tailwindDirectivesFromCss(source.text);
      if (directives !== '') parts.add(directives);
    }
    const directives = [...parts].join('\n');
    result.tailwind = { version, tokens: tailwindTokensFromCss(directives), directives };
    // The theme is what the app's stylesheets declare on their root — not the variables Tailwind's
    // compiled theme layer adds (`--color-white`, `--spacing`, `--text-xs`…), which are no theme of
    // the app's. Off the compiled CSS only when the sources declare none.
    const declared: Record<string, string> = {};
    for (const source of sources)
      for (const [name, value] of Object.entries(themeVarsFromCss(source.text, { rootOnly: true })))
        declared[name] ??= value;
    if (Object.keys(declared).length > 0) result.vars = declared;
  } else {
    result.vocabulary = extractCssVocabulary(css);
  }
  return result;
}

/** The docs half of compiled styles (what the model is told). */
export function stylesDocs(
  styles: SandboxKitStyles | null,
): Pick<SandboxKitDocs, 'tailwind' | 'vocabulary'> {
  if (styles === null) return {};
  if (styles.tailwind !== undefined)
    return { tailwind: { version: styles.tailwind.version, tokens: styles.tailwind.tokens } };
  return styles.vocabulary !== undefined ? { vocabulary: styles.vocabulary } : {};
}

/** `stylesDocs`: a file (markdown, text) relative to the root, or the guidance itself. */
export function readStylesGuide(root: string, stylesDocs: string | undefined): string | undefined {
  if (stylesDocs === undefined) return undefined;
  if (!stylesDocs.includes('\n') && stylesDocs.length < 400) {
    const path = isAbsolute(stylesDocs) ? stylesDocs : resolve(root, stylesDocs);
    if (existsSync(path) && statSync(path).isFile()) return readFileSync(path, 'utf8');
  }
  return stylesDocs;
}

/** A fresh instance of the app's Tailwind Vite plugin, when the app has one and the kit has none. */
export async function tailwindVitePluginFor(
  root: string,
  appPlugins: readonly { name?: string }[],
  given: readonly unknown[],
): Promise<unknown[]> {
  const named = (list: readonly unknown[]): string[] =>
    list
      .flat(Number.POSITIVE_INFINITY as 1)
      .map((plugin) => String((plugin as { name?: unknown } | null)?.name ?? ''));
  if (!appPlugins.some((plugin) => String(plugin.name ?? '').startsWith('@tailwindcss/vite')))
    return [];
  if (named(given).some((name) => name.startsWith('@tailwindcss/vite'))) return [];
  try {
    const path = createRequire(resolve(root, 'package.json')).resolve('@tailwindcss/vite');
    const mod = (await import(pathToFileURL(path).href)) as { default: () => unknown };
    return [mod.default()];
  } catch {
    return [];
  }
}
