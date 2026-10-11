/**
 * Which modules make up the app's sandbox kit: `components` — files, globs, directories or package
 * specifiers whose exports are the kit — or, without it, the first shadcn-style `components/ui`
 * folder the project has; and the `wrapper` module whose default export wraps the model's App.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface SandboxKitSourceOptions {
  /**
   * The modules whose exports are the kit's components: files (`resources/js/genui/kit.ts`), globs
   * (`inertia/components/ui/*.tsx`), directories (`src/components/ui`) or packages
   * (`@mui/material`, `react-bootstrap`). Default: the first `components/ui` folder.
   */
  components?: string | readonly string[];
  /** A module whose default export wraps the model's App (`({ children }) => <ThemeProvider…>`). */
  wrapper?: string;
}

/** The options `genuiSandboxKit()` / `genuiKitHook()` took before 0.75, and what replaced each. */
const LEGACY_OPTIONS: Record<string, string> = {
  entry: '`entry: X` is now `components: X` (a module whose exports are the kit)',
  include: '`include: G` is now `components: G` (globs, files, directories or packages)',
  tailwind:
    '`tailwind` is gone: Tailwind is detected from `styles` (pass your Tailwind stylesheet there)',
  tailwindCss:
    '`tailwindCss: [...]` is gone: pass the stylesheet itself as `styles` — its @theme, @custom-variant and @utility (and those of the files it @imports) reach the frame on their own',
  css: "`css: G` is now `styles: G` (the app's style entry files)",
};

/** Throws a migration message when options from before 0.75 are passed. */
export function assertNoLegacyKitOptions(options: object, where: string): void {
  const found = Object.keys(LEGACY_OPTIONS).filter(
    (key) => (options as Record<string, unknown>)[key] !== undefined,
  );
  if (found.length === 0) return;
  throw new TypeError(
    `${where}: option${found.length > 1 ? 's' : ''} ${found.map((key) => `\`${key}\``).join(', ')} ${found.length > 1 ? 'were' : 'was'} removed in 0.75 — ${found.map((key) => LEGACY_OPTIONS[key]).join('; ')}. See "Migration from 0.74" in the sandbox kit docs.`,
  );
}

/** Where a shadcn `components.json` puts `ui` by default, per framework layout. */
export const DEFAULT_KIT_DIRS = [
  'inertia/components/ui',
  'resources/js/components/ui',
  'src/components/ui',
  'app/components/ui',
  'components/ui',
] as const;

/** A glob as a regular expression over `/`-separated paths: `**`, `*`, `?`, `{a,b}`. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let index = 0; index < glob.length; index++) {
    const c = glob[index] as string;
    if (c === '*') {
      if (glob[index + 1] === '*') {
        index++;
        if (glob[index + 1] === '/') {
          index++;
          out += '(?:.*/)?';
        } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const close = glob.indexOf('}', index);
      if (close < 0) {
        out += '\\{';
        continue;
      }
      out += `(?:${glob
        .slice(index + 1, close)
        .split(',')
        .map((part) => part.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
        .join('|')})`;
      index = close;
    } else out += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** The part of a glob before its first wildcard: where to start walking. */
function globBase(glob: string): string {
  const parts = glob.split('/');
  const base: string[] = [];
  for (const part of parts) {
    if (/[*?{]/.test(part)) break;
    base.push(part);
  }
  return base.join('/');
}

function walk(dir: string, into: string[], depth = 0): void {
  if (depth > 12 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, into, depth + 1);
    else into.push(path);
  }
}

/** The files matching `globs` under `root`, sorted, absolute. Test and story files are left out. */
export function globFiles(root: string, globs: string | readonly string[]): string[] {
  const list = typeof globs === 'string' ? [globs] : [...globs];
  const found = new Set<string>();
  for (const glob of list) {
    const normalized = glob.replace(/\\/g, '/').replace(/^\.\//, '');
    const base = globBase(normalized);
    const pattern = globToRegExp(normalized);
    const files: string[] = [];
    const start = resolve(root, base);
    if (existsSync(start) && statSync(start).isFile()) files.push(start);
    else walk(start, files);
    for (const file of files) {
      const rel = relative(root, file).split(sep).join('/');
      if (
        pattern.test(rel) &&
        !/\.(test|spec|stories)\.[jt]sx?$/.test(rel) &&
        !rel.endsWith('.d.ts')
      )
        found.add(file);
    }
  }
  return [...found].sort();
}

/** What the kit is made of. */
export interface SandboxKitFiles {
  /** Every local file whose exports are kit components (what the docs read, and what is watched). */
  files: string[];
  /** Package specifiers whose exports are kit components (`@mui/material`). */
  packages: string[];
  /** The wrapper module (absolute path or package specifier), when there is one. */
  wrapper?: string;
  /** Directories to watch for changes. */
  dirs: string[];
  /** `components` entries that matched nothing (what the plugin warns about). */
  missing?: string[];
}

const SOURCE_GLOB = '*.{tsx,jsx,ts,js,mts,mjs}';

function isPackageSpecifier(spec: string): boolean {
  return !spec.startsWith('.') && !isAbsolute(spec) && /^(@[\w.-]+\/)?[\w.-]+(\/.*)?$/.test(spec);
}

function resolvesAsPackage(root: string, spec: string): boolean {
  try {
    createRequire(resolve(root, 'package.json')).resolve(spec);
    return true;
  } catch {
    // An ESM-only package (no `require` condition) still resolves its package.json directory.
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    let dir = root;
    for (;;) {
      if (existsSync(join(dir, 'node_modules', name as string, 'package.json'))) return true;
      const parent = resolve(dir, '..');
      if (parent === dir) return false;
      dir = parent;
    }
  }
}

/** A module path (with or without extension), resolved like an import would be. */
function resolveModuleFile(path: string): string | undefined {
  if (existsSync(path) && statSync(path).isFile()) return path;
  for (const extension of ['.tsx', '.ts', '.jsx', '.js', '.mts', '.mjs']) {
    if (existsSync(`${path}${extension}`)) return `${path}${extension}`;
  }
  for (const extension of ['.tsx', '.ts', '.jsx', '.js']) {
    const index = join(path, `index${extension}`);
    if (existsSync(index)) return index;
  }
  return undefined;
}

/** The wrapper: a file (relative to the root) or a package specifier. Throws when it is neither. */
export function resolveSandboxKitWrapper(
  root: string,
  wrapper: string | undefined,
): string | undefined {
  if (wrapper === undefined) return undefined;
  const local = resolveModuleFile(isAbsolute(wrapper) ? wrapper : resolve(root, wrapper));
  if (local !== undefined) return local;
  if (isPackageSpecifier(wrapper) && resolvesAsPackage(root, wrapper)) return wrapper;
  throw new Error(
    `genuiSandboxKit: the wrapper "${wrapper}" was not found (a file relative to ${root}, or a package)`,
  );
}

/**
 * Resolve the kit's modules. `null` when there is nothing to build — no `components` match, none of
 * the {@link DEFAULT_KIT_DIRS} exists, and there is no `wrapper`.
 */
export function resolveSandboxKitFiles(
  root: string,
  options: SandboxKitSourceOptions,
): SandboxKitFiles | null {
  const wrapper = resolveSandboxKitWrapper(root, options.wrapper);
  const specs =
    options.components === undefined
      ? DEFAULT_KIT_DIRS.filter((dir) => existsSync(resolve(root, dir))).slice(0, 1)
      : typeof options.components === 'string'
        ? [options.components]
        : [...options.components];
  const files = new Set<string>();
  const packages: string[] = [];
  const dirs = new Set<string>();
  const missing: string[] = [];
  for (const spec of specs) {
    const normalized = spec.replace(/\\/g, '/');
    if (/[*?{]/.test(normalized)) {
      const matched = globFiles(root, normalized);
      for (const file of matched) files.add(file);
      dirs.add(resolve(root, globBase(normalized)));
      if (matched.length === 0) missing.push(spec);
      continue;
    }
    const path = isAbsolute(normalized) ? normalized : resolve(root, normalized);
    if (existsSync(path) && statSync(path).isDirectory()) {
      for (const file of globFiles(path, SOURCE_GLOB)) files.add(file);
      dirs.add(path);
      continue;
    }
    const file = resolveModuleFile(path);
    if (file !== undefined) {
      files.add(file);
      dirs.add(resolve(file, '..'));
      continue;
    }
    if (isPackageSpecifier(normalized) && resolvesAsPackage(root, normalized)) {
      packages.push(normalized);
      continue;
    }
    missing.push(spec);
  }
  if (files.size === 0 && packages.length === 0 && wrapper === undefined) return null;
  if (wrapper !== undefined && isAbsolute(wrapper)) dirs.add(resolve(wrapper, '..'));
  return {
    files: [...files].sort(),
    packages,
    ...(wrapper !== undefined ? { wrapper } : {}),
    dirs: [...dirs],
    ...(missing.length > 0 ? { missing } : {}),
  };
}
