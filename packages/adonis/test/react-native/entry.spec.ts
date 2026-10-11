import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The real packages are Flow / native code: what loads in a React Native runtime is mocked.
vi.mock('react-native', () => ({ View: () => null, Text: () => null }));
vi.mock('react-native-webview', () => ({ WebView: () => null, default: () => null }));

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = resolve(root, 'src');

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(resolve(directory, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [resolve(directory, entry.name)]
        : [],
  );
}

/** Every module a file loads at runtime (type-only imports and exports left out), transitively. */
function runtimeGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /^(?:import|export)\s+(type\s+)?(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/gm,
    )) {
      if (match[1] !== undefined) continue;
      const specifier = match[2] as string;
      if (!specifier.startsWith('.')) {
        seen.add(specifier);
        continue;
      }
      const base = resolve(dirname(file), specifier).replace(/\.js$/, '');
      const target = [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')].find((path) => {
        try {
          readFileSync(path);
          return true;
        } catch {
          return false;
        }
      });
      if (target !== undefined) visit(target);
    }
  };
  visit(entry);
  return seen;
}

describe('the React Native entry', () => {
  const entry = resolve(src, 'react-native/genui/index.ts');

  it('loads neither the web sandbox renderer nor its assets module, react-dom or the server root', () => {
    const graph = [...runtimeGraph(entry)];
    expect(graph).not.toContain(resolve(src, 'react/core/genui/sandbox.tsx'));
    expect(graph).not.toContain(resolve(src, 'react/core/genui/sandbox-assets.ts'));
    expect(graph).not.toContain(resolve(src, 'react/core/genui/index.ts'));
    expect(graph).not.toContain(resolve(src, 'genui/index.ts'));
    expect(graph).not.toContain(resolve(src, 'index.ts'));
    expect(graph.filter((path) => !path.startsWith('/'))).toEqual(
      expect.arrayContaining(['react', 'react-native', 'react-native-webview']),
    );
    expect(graph.filter((path) => !path.startsWith('/')).sort()).toEqual(
      [
        '@standard-schema/spec',
        'react',
        'react/jsx-runtime',
        'react-native',
        'react-native-webview',
      ]
        .filter((name) => graph.includes(name))
        .sort(),
    );
  });

  it('is the only code that imports react-native', () => {
    const offenders = sources(src)
      .filter((path) => !path.startsWith(resolve(src, 'react-native')))
      .filter((path) => /from\s+['"]react-native(-webview)?['"]/.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('is a package export with its types, and react-native peers are optional', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(pkg.exports['./react-native/genui']).toEqual({
      types: './dist/src/react-native/genui/index.d.ts',
      import: './dist/src/react-native/genui/index.js',
      default: './dist/src/react-native/genui/index.js',
    });
    for (const name of ['react-native', 'react-native-webview']) {
      expect(pkg.peerDependencies[name]).toBeDefined();
      expect(pkg.peerDependenciesMeta[name]).toEqual({ optional: true });
      expect(pkg.dependencies?.[name]).toBeUndefined();
    }
  });
});

describe('loading in a React Native runtime (a `window` without DOM methods)', () => {
  const holder = globalThis as { window?: unknown };
  const original = holder.window;
  afterEach(() => {
    holder.window = original;
    vi.resetModules();
  });

  it('the native entry loads', async () => {
    holder.window = globalThis;
    vi.resetModules();
    const entry = await import('../../src/react-native/genui/index.js');
    expect(typeof entry.createNativeSandboxRenderer).toBe('function');
    expect(typeof entry.GenuiProvider).toBe('function');
  });

  it('the web genui entry does not (its sandbox assets module listens on window as it loads)', async () => {
    holder.window = globalThis;
    vi.resetModules();
    await expect(import('../../src/react/genui/index.js')).rejects.toThrow(/addEventListener/);
  });
});
