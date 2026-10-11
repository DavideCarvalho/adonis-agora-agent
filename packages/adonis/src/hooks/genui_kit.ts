/**
 * An Assembler `init` hook (added by `node ace configure @adonis-agora/agent`) that writes the
 * sandbox kit's docs — its components and their props, the styles' Tailwind tokens or CSS class
 * vocabulary, the theme's variables — on `serve` and `build`, and again when a kit or style file
 * changes. For an app whose Vite does not run in the server's process (a separate SPA): with Vite
 * in-process, `genuiSandboxKit()` does this itself. Does nothing when the project has no kit
 * (no `components/ui`, no `components`, `wrapper` or `styles`).
 *
 * ```ts
 * // adonisrc.ts
 * hooks: { init: [() => import('@adonis-agora/agent/hooks/genui_kit')] }
 * // or, with options:
 * import { genuiKitHook } from '@adonis-agora/agent/hooks/genui_kit'
 * hooks: { init: [genuiKitHook({ components: 'web/src/components/ui/*.tsx', styles: 'web/src/app.css' })] }
 * ```
 */
import { relative, resolve } from 'node:path';
import type { SandboxKitSourceOptions } from '../genui/kit/files.js';
import { assertNoLegacyKitOptions, resolveSandboxKitFiles } from '../genui/kit/files.js';
import { resolveStyleEntries, STYLE_EXTENSIONS } from '../genui/kit/styles.js';
import { writeSandboxKitDocs } from '../genui/kit/write.js';
import { ADONIS_SANDBOX_KIT_DESCRIPTOR } from '../vite/index.js';

export interface GenuiKitHookOptions extends SandboxKitSourceOptions {
  /** The app's style entries (paths or globs): what the model is told about the styles. */
  styles?: string | readonly string[];
  /** Guidance on the styles for the model (a markdown file, or the text itself). */
  stylesDocs?: string;
  /** Where the docs go. Default `.adonisjs/agent/genui_sandbox_kit.json`. */
  output?: string;
  tsconfig?: string;
  /** A TypeScript module with the compiler API, when the project's own has none (TypeScript 7). */
  typescript?: unknown;
}

interface HooksLike {
  add(event: string, handler: (...args: unknown[]) => unknown): unknown;
}

export function genuiKitHook(options: GenuiKitHookOptions = {}) {
  assertNoLegacyKitOptions(options, 'genuiKitHook');
  const output = options.output ?? ADONIS_SANDBOX_KIT_DESCRIPTOR;
  const generate = async (root: string) => {
    try {
      await writeSandboxKitDocs({ ...options, root, output });
    } catch (error) {
      console.warn(
        `[@adonis-agora/agent] sandbox kit docs not generated: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  return {
    async run(parent: unknown, hooks?: HooksLike): Promise<void> {
      const cwd = (parent as { cwd?: URL | string } | undefined)?.cwd;
      const root =
        cwd === undefined
          ? process.cwd()
          : typeof cwd === 'string'
            ? cwd
            : decodeURIComponent(cwd.pathname);
      let files: ReturnType<typeof resolveSandboxKitFiles> = null;
      try {
        files = resolveSandboxKitFiles(root, options);
      } catch (error) {
        console.warn(
          `[@adonis-agora/agent] ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const styles =
        options.styles === undefined ? [] : resolveStyleEntries(root, options.styles).files;
      if (files === null && styles.length === 0) return;
      await generate(root);
      const onChange = (_relative: unknown, absolute: unknown) => {
        const path = typeof absolute === 'string' ? absolute : resolve(root, String(_relative));
        const inKit = files?.dirs.some((dir) => !relative(dir, path).startsWith('..')) === true;
        const isStyle = STYLE_EXTENSIONS.some((extension) => path.endsWith(extension));
        if (inKit || isStyle) void generate(root);
      };
      hooks?.add('fileChanged', onChange);
      hooks?.add('fileAdded', onChange);
      hooks?.add('fileRemoved', onChange);
    },
  };
}

/** `() => import('@adonis-agora/agent/hooks/genui_kit')` resolves to a ready hook. */
export default genuiKitHook();
