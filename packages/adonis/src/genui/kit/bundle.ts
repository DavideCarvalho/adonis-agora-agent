/**
 * The kit bundle: the app's components, its wrapper, React and ReactDOM as ONE classic script (an
 * IIFE) that sets `window.Kit`, `window.KitWrapper`, `window.React` and `window.ReactDOM` — what the
 * sandbox frame inlines, so it needs no network and no module loader. Built with the app's own Vite
 * (nothing written), its aliases kept, so `@/lib/utils` resolves as it does in the app.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { SandboxKitComponentDoc } from '../sandbox-kit.js';
import type { SandboxKitFiles } from './files.js';
import { contentHash, runKitViteBuild } from './vite-build.js';

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
  /** `css` from the app's Vite config (for CSS the components import). */
  css?: Record<string, unknown>;
  /** Extra Vite plugins for the kit build (e.g. one the components need to compile). */
  plugins?: unknown[];
  inlineAssetLimit?: number;
  inlineAssetBudget?: number;
  warn?: (message: string) => void;
  /** Default true. */
  minify?: boolean;
}

function entryCode(files: SandboxKitFiles): string {
  const modules = [...files.files, ...files.packages];
  return [
    'import * as React from "react";',
    'import * as ReactDOMClient from "react-dom/client";',
    ...modules.map((module, index) => `import * as __kit${index} from ${JSON.stringify(module)};`),
    ...(files.wrapper !== undefined
      ? [`import __KitWrapper from ${JSON.stringify(files.wrapper)};`]
      : []),
    'var Kit = {};',
    // In order, the first module naming a component wins (what `export *` would leave ambiguous).
    ...modules.map(
      (_, index) =>
        `for (var k in __kit${index}) { if (!(k in Kit) && k !== "default") Kit[k] = __kit${index}[k]; }`,
    ),
    'window.React = React;',
    'window.ReactDOM = ReactDOMClient;',
    'window.Kit = Kit;',
    ...(files.wrapper !== undefined ? ['window.KitWrapper = __KitWrapper;'] : []),
  ].join('\n');
}

/** The names the kit's source files export in PascalCase (read off the text: no TypeScript needed). */
function sourceExportNames(files: readonly string[]): string[] {
  const names = new Set<string>();
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(
      /export\s+(?:const|function|class|let|var)\s+([A-Z][A-Za-z0-9]*)/g,
    ))
      names.add(match[1] as string);
    for (const match of text.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of (match[1] as string).split(',')) {
        const name = part
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (name !== undefined && /^[A-Z][A-Za-z0-9]*$/.test(name)) names.add(name);
      }
    }
  }
  return [...names];
}

/** Build the kit bundle with the app's Vite. */
export async function buildSandboxKitBundle(
  options: BuildSandboxKitOptions,
): Promise<SandboxKitBundle> {
  const built = await runKitViteBuild({
    root: options.root,
    entry: entryCode(options.files),
    ...(options.resolve !== undefined ? { resolve: options.resolve } : {}),
    ...(options.css !== undefined ? { css: options.css } : {}),
    ...(options.plugins !== undefined ? { plugins: options.plugins } : {}),
    ...(options.inlineAssetLimit !== undefined
      ? { inlineAssetLimit: options.inlineAssetLimit }
      : {}),
    ...(options.inlineAssetBudget !== undefined
      ? { inlineAssetBudget: options.inlineAssetBudget }
      : {}),
    ...(options.warn !== undefined ? { warn: options.warn } : {}),
    ...(options.minify !== undefined ? { minify: options.minify } : {}),
  });
  let code = built.code;
  if (built.css !== '') code = `window.__GENUI_KIT_CSS__=${JSON.stringify(built.css)};\n${code}`;
  const exports = sourceExportNames(options.files.files);
  return { code, hash: contentHash(code), exports, modules: built.modules };
}

/**
 * The kit's components as a JavaScript project can document them, without TypeScript: run the
 * bundle in a bare context (no DOM) and read each PascalCase export's `propTypes` keys and
 * `defaultProps`. `[]` when the bundle does not run outside a browser.
 */
export function kitDocsFromBundle(code: string): SandboxKitComponentDoc[] {
  const window: Record<string, unknown> = {};
  try {
    runInNewContext(
      code,
      {
        window,
        self: window,
        globalThis: window,
        console: { log() {}, warn() {}, error() {} },
        setTimeout,
        clearTimeout,
        queueMicrotask,
      },
      { timeout: 2000 },
    );
  } catch {
    if (window.Kit === undefined) return [];
  }
  const kit = (window.Kit ?? {}) as Record<string, unknown>;
  const docs: SandboxKitComponentDoc[] = [];
  for (const [name, value] of Object.entries(kit)) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) continue;
    if (typeof value !== 'function' && (typeof value !== 'object' || value === null)) continue;
    const component = value as {
      propTypes?: unknown;
      defaultProps?: unknown;
      render?: { propTypes?: unknown; defaultProps?: unknown };
    };
    const propTypes = (component.propTypes ?? component.render?.propTypes ?? {}) as Record<
      string,
      unknown
    >;
    const defaults = (component.defaultProps ?? component.render?.defaultProps ?? {}) as Record<
      string,
      unknown
    >;
    const names = [...new Set([...Object.keys(propTypes), ...Object.keys(defaults)])];
    docs.push({
      name,
      props: names.slice(0, 40).map((prop) => {
        const value = defaults[prop];
        const shown =
          value === undefined || typeof value === 'function'
            ? undefined
            : (() => {
                try {
                  return JSON.stringify(value);
                } catch {
                  return undefined;
                }
              })();
        return {
          name: prop,
          type: value === undefined ? 'unknown' : Array.isArray(value) ? 'array' : typeof value,
          required: false,
          ...(shown !== undefined && shown.length <= 80 ? { default: shown } : {}),
        };
      }),
    });
  }
  return docs;
}
