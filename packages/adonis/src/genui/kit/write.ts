import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SandboxKitDescriptor } from '../sandbox-kit.js';
import { themeVarsFromCss } from '../sandbox-theme.js';
import { type GenerateSandboxKitDocsOptions, generateSandboxKitDocs } from './docs.js';
import { globFiles, resolveSandboxKitFiles } from './files.js';

/**
 * Generate the kit docs and write them as a descriptor (no asset urls: a dev server or a build
 * provides those) — what the assembler hook and the Nest codegen run for an app whose Vite does not
 * run in the server's process. `css` globs name the stylesheets whose custom properties are the
 * theme. Returns the descriptor, or `null` when the project has no kit. Leaves an unchanged file
 * untouched (no needless reloads).
 */
export async function writeSandboxKitDocs(
  options: GenerateSandboxKitDocsOptions & { output: string; css?: string | readonly string[] },
): Promise<SandboxKitDescriptor | null> {
  const root = options.root ?? process.cwd();
  const files = options.files ?? resolveSandboxKitFiles(root, options);
  if (files === null) return null;
  const components = await generateSandboxKitDocs({ ...options, root, files });
  const vars: Record<string, string> = {};
  for (const file of options.css === undefined ? [] : globFiles(root, options.css)) {
    for (const [name, value] of Object.entries(themeVarsFromCss(readFileSync(file, 'utf8'))))
      vars[name] ??= value;
  }
  const descriptor: SandboxKitDescriptor = {
    version: 1,
    components,
    ...(Object.keys(vars).length > 0 ? { theme: { vars } } : {}),
    kit: null,
    tailwind: null,
  };
  const path = resolve(root, options.output);
  const text = `${JSON.stringify(descriptor, null, 2)}\n`;
  if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return descriptor;
}
