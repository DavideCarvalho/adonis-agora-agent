/**
 * The kit bundle: the app's design-system components, React and ReactDOM as ONE classic script (an
 * IIFE) that sets `window.Kit`, `window.React` and `window.ReactDOM` — what the sandbox frame inlines,
 * so it needs no network and no module loader. Built with the app's own Vite (`vite.build`, nothing
 * written), its aliases kept, so `@/lib/utils` resolves as it does in the app.
 */
import { createHash } from 'node:crypto';
import type { SandboxKitFiles } from './files.js';

/** What a kit build produced. */
export interface SandboxKitBundle {
  /** The IIFE (its CSS, if the components import any, rides along as `window.__GENUI_KIT_CSS__`). */
  code: string;
  /** A short content hash — what a client caches it by. */
  hash: string;
  /** The component names the bundle exports (what the docs fall back to without TypeScript). */
  exports: string[];
  /** Every module of the app the bundle read — what to watch for a rebuild. */
  modules: string[];
}

export interface BuildSandboxKitOptions {
  root: string;
  files: SandboxKitFiles;
  /** `resolve` from the app's Vite config (aliases, dedupe, conditions). */
  resolve?: Record<string, unknown>;
  /** Extra Vite plugins for the kit build (e.g. one the components need to compile). */
  plugins?: unknown[];
  /** Default true. */
  minify?: boolean;
}

/** The entry's file name (Vite resolves a lib entry against the root) and its virtual id. */
const ENTRY_FILE = 'genui-sandbox-kit-entry.js';
const ENTRY_ID = '\0genui-sandbox-kit-entry';
const EXPORTS_ID = '\0genui-sandbox-kit-exports';

function exportsCode(files: SandboxKitFiles): string {
  return files.entry
    ? `export * from ${JSON.stringify(files.entry)};`
    : files.files.map((file) => `export * from ${JSON.stringify(file)};`).join('\n');
}

interface OutputChunkLike {
  type: 'chunk' | 'asset';
  fileName: string;
  code?: string;
  source?: string | Uint8Array;
  exports?: string[];
  moduleIds?: string[];
  modules?: Record<string, unknown>;
}

/** Build the kit bundle with the app's Vite. */
export async function buildSandboxKitBundle(
  options: BuildSandboxKitOptions,
): Promise<SandboxKitBundle> {
  const vite = (await import('vite')) as typeof import('vite');
  const major = Number.parseInt(String(vite.version).split('.')[0] ?? '0', 10);
  const files = options.files;
  const kitExports = new Set<string>();
  const result = await vite.build({
    configFile: false,
    root: options.root,
    logLevel: 'silent',
    mode: 'production',
    publicDir: false,
    ...(options.resolve !== undefined ? { resolve: options.resolve as never } : {}),
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    // Vite 8 compiles with Oxc, earlier versions with esbuild: the automatic JSX runtime on both.
    ...(major >= 8
      ? ({ oxc: { jsx: { runtime: 'automatic' } } } as Record<string, unknown>)
      : { esbuild: { jsx: 'automatic' } }),
    plugins: [
      {
        name: 'genui-sandbox-kit-entry',
        resolveId(id: string) {
          if (id === ENTRY_ID || id.endsWith(ENTRY_FILE)) return ENTRY_ID;
          if (id === EXPORTS_ID) return EXPORTS_ID;
          return null;
        },
        load(id: string) {
          if (id === ENTRY_ID) {
            return [
              'import * as React from "react";',
              'import * as ReactDOMClient from "react-dom/client";',
              'import * as Kit from "\\0genui-sandbox-kit-exports";',
              'window.React = React;',
              'window.ReactDOM = ReactDOMClient;',
              'window.Kit = Kit;',
            ].join('\n');
          }
          if (id === EXPORTS_ID) return exportsCode(files);
          return null;
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
      lib: {
        entry: ENTRY_FILE,
        formats: ['iife'],
        name: '__genuiSandboxKit',
        fileName: () => 'genui-sandbox-kit.js',
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  } as never);
  const outputs = (Array.isArray(result) ? result : [result]) as unknown as {
    output: OutputChunkLike[];
  }[];
  let code = '';
  let css = '';
  const modules = new Set<string>();
  for (const out of outputs) {
    for (const item of out.output ?? []) {
      if (item.type === 'chunk') {
        code += item.code ?? '';
        for (const id of item.moduleIds ?? Object.keys(item.modules ?? {})) {
          if (!id.startsWith('\0') && !id.includes('/node_modules/')) modules.add(id);
        }
      } else if (item.fileName.endsWith('.css')) {
        css +=
          typeof item.source === 'string'
            ? item.source
            : Buffer.from(item.source ?? new Uint8Array()).toString('utf8');
      }
    }
  }
  if (css !== '') code = `window.__GENUI_KIT_CSS__=${JSON.stringify(css)};\n${code}`;
  // The names the kit exports, read off the entry's re-exports at runtime would need a browser:
  // list what the source files export by name instead (good enough for the fallback docs).
  for (const file of files.files) {
    try {
      const { readFileSync } = await import('node:fs');
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(
        /export\s+(?:const|function|class|let|var)\s+([A-Z][A-Za-z0-9]*)/g,
      ))
        kitExports.add(match[1] as string);
      for (const match of text.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const part of (match[1] as string).split(',')) {
          const name = part
            .split(/\s+as\s+/)
            .pop()
            ?.trim();
          if (name !== undefined && /^[A-Z][A-Za-z0-9]*$/.test(name)) kitExports.add(name);
        }
      }
    } catch {
      /* unreadable: no fallback names from it */
    }
  }
  return {
    code,
    hash: createHash('sha256').update(code).digest('hex').slice(0, 12),
    exports: [...kitExports],
    modules: [...modules],
  };
}
