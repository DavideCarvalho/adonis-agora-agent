/**
 * Which files make up the app's sandbox kit: an `entry` module (its exports are the kit), or an
 * `include` glob (every matching file's exports are), or — with neither — the first shadcn-style
 * `components/ui` folder the project has.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface SandboxKitSourceOptions {
  /** A module whose exports are the kit (`resources/js/genui/kit.ts`). */
  entry?: string;
  /** A glob (or several) whose files' exports are the kit (`inertia/components/ui/*.tsx`). */
  include?: string | readonly string[];
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

/** What the kit is made of: an entry, or the files of `include`, or the default `components/ui`. */
export interface SandboxKitFiles {
  /** The entry module, when the kit has one. */
  entry?: string;
  /** Every file whose exports are kit components (the entry alone, or each matched file). */
  files: string[];
  /** Directories to watch for changes. */
  dirs: string[];
}

/**
 * Resolve the kit's files. `null` when there is nothing to build — no `entry`, no file matching
 * `include`, and none of the {@link DEFAULT_KIT_DIRS}.
 */
export function resolveSandboxKitFiles(
  root: string,
  options: SandboxKitSourceOptions,
): SandboxKitFiles | null {
  if (options.entry !== undefined) {
    const entry = isAbsolute(options.entry) ? options.entry : resolve(root, options.entry);
    if (!existsSync(entry)) return null;
    return { entry, files: [entry], dirs: [resolve(entry, '..')] };
  }
  const include =
    options.include ??
    DEFAULT_KIT_DIRS.filter((dir) => existsSync(resolve(root, dir))).map(
      (dir) => `${dir}/*.{tsx,jsx,ts,js}`,
    )[0];
  if (include === undefined) return null;
  const files = globFiles(root, include);
  if (files.length === 0) return null;
  const globs = typeof include === 'string' ? [include] : [...include];
  return {
    files,
    dirs: [...new Set(globs.map((glob) => resolve(root, globBase(glob.replace(/\\/g, '/')))))],
  };
}
