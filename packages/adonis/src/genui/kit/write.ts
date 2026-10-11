import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SandboxKitDescriptor } from '../sandbox-kit.js';
import { kitDocsFromBundle } from './bundle.js';
import { type GenerateSandboxKitDocsOptions, generateSandboxKitDocs } from './docs.js';
import { assertNoLegacyKitOptions, resolveSandboxKitFiles } from './files.js';
import {
  buildSandboxKitStyles,
  discoverStyleEntries,
  readStylesGuide,
  resolveStyleEntries,
  stylesDocs,
} from './styles.js';

export interface WriteSandboxKitDocsOptions extends GenerateSandboxKitDocsOptions {
  /** Where the descriptor goes, relative to the root. */
  output: string;
  /** The app's style entries (default: found from `index.html` / the Vite input, when given). */
  styles?: string | readonly string[];
  /** Guidance on the styles for the model: a file (markdown) or the text itself. */
  stylesDocs?: string;
  /** Vite's `build.rollupOptions.input`, for finding the style entries without `styles`. */
  input?: unknown;
  /** Compile the styles with Vite (Sass, PostCSS…). Default true when `vite` is installed. */
  compileStyles?: boolean;
  /** Extra Vite plugins for compiling the styles. */
  plugins?: unknown[];
}

async function viteAvailable(): Promise<boolean> {
  try {
    await import('vite');
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate the kit docs and write them as a descriptor with no asset urls (a dev server or a build
 * provides those) — what the assembler hook and the Nest codegen run for an app whose Vite does not
 * run in the server's process: the components and their props, the styles' Tailwind tokens or CSS
 * vocabulary, the theme's variables, `stylesDocs`. Returns the descriptor, or `null` when the
 * project has neither components, a wrapper nor styles. Leaves an unchanged file untouched (no
 * needless reloads).
 */
export async function writeSandboxKitDocs(
  options: WriteSandboxKitDocsOptions,
): Promise<SandboxKitDescriptor | null> {
  assertNoLegacyKitOptions(options, 'writeSandboxKitDocs');
  const root = options.root ?? process.cwd();
  const files = options.files ?? resolveSandboxKitFiles(root, options);
  const entries =
    options.styles !== undefined
      ? resolveStyleEntries(root, options.styles).files
      : discoverStyleEntries(root, { input: options.input });
  if (files === null && entries.length === 0) return null;
  const compile = options.compileStyles ?? (await viteAvailable());
  const styles = await buildSandboxKitStyles({
    root,
    entries,
    compile,
    ...(options.plugins !== undefined ? { plugins: options.plugins } : {}),
  }).catch(() => null);
  let components =
    files === null
      ? []
      : await generateSandboxKitDocs({ ...options, root, files }).catch(() => null);
  if (components === null) {
    // No TypeScript: the names (and propTypes) a bundle of the kit exports, when Vite can build it.
    components = [];
    if (files !== null && compile) {
      try {
        const { buildSandboxKitBundle } = await import('./bundle.js');
        components = kitDocsFromBundle((await buildSandboxKitBundle({ root, files })).code);
      } catch {
        components = [];
      }
    }
  }
  const guide = readStylesGuide(root, options.stylesDocs);
  const descriptor: SandboxKitDescriptor = {
    version: 2,
    components,
    jsx: files !== null,
    ...(files?.wrapper !== undefined ? { wrapper: true } : {}),
    ...(styles !== null && Object.keys(styles.vars).length > 0
      ? { theme: { vars: styles.vars } }
      : {}),
    ...stylesDocs(styles),
    ...(guide !== undefined ? { guide } : {}),
    assets: { kit: null, css: null, tailwind: null },
  };
  const path = resolve(root, options.output);
  const text = `${JSON.stringify(descriptor, null, 2)}\n`;
  if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return descriptor;
}
