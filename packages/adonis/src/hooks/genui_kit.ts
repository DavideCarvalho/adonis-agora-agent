/**
 * An Assembler `init` hook (added by `node ace configure @adonis-agora/agent`) that writes the
 * sandbox kit's docs — its components and their props, from their types — on `serve` and `build`,
 * and again when a kit file changes. For an app whose Vite does not run in the server's process (a
 * separate SPA): with Vite in-process, `genuiSandboxKit()` does this itself. Does nothing when the
 * project has no kit (`components/ui`, or `include`).
 *
 * ```ts
 * // adonisrc.ts
 * hooks: { init: [() => import('@adonis-agora/agent/hooks/genui_kit')] }
 * // or, with options:
 * import { genuiKitHook } from '@adonis-agora/agent/hooks/genui_kit'
 * hooks: { init: [genuiKitHook({ include: 'web/src/components/ui/*.tsx', css: 'web/src/app.css' })] }
 * ```
 */
import { relative, resolve } from 'node:path';
import type { SandboxKitSourceOptions } from '../genui/kit/files.js';
import { resolveSandboxKitFiles } from '../genui/kit/files.js';
import { writeSandboxKitDocs } from '../genui/kit/write.js';
import { ADONIS_SANDBOX_KIT_DESCRIPTOR } from '../vite/index.js';

export interface GenuiKitHookOptions extends SandboxKitSourceOptions {
  /** Stylesheets whose custom properties are the theme (globs). */
  css?: string | readonly string[];
  /** Where the docs go. Default `.adonisjs/agent/genui_sandbox_kit.json`. */
  output?: string;
  tsconfig?: string;
}

interface HooksLike {
  add(event: string, handler: (...args: unknown[]) => unknown): unknown;
}

export function genuiKitHook(options: GenuiKitHookOptions = {}) {
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
      const files = resolveSandboxKitFiles(root, options);
      if (files === null) return;
      await generate(root);
      const onChange = (_relative: unknown, absolute: unknown) => {
        const path = typeof absolute === 'string' ? absolute : resolve(root, String(_relative));
        if (files.dirs.some((dir) => !relative(dir, path).startsWith('..'))) void generate(root);
      };
      hooks?.add('fileChanged', onChange);
      hooks?.add('fileAdded', onChange);
      hooks?.add('fileRemoved', onChange);
    },
  };
}

/** `() => import('@adonis-agora/agent/hooks/genui_kit')` resolves to a ready hook. */
export default genuiKitHook();
