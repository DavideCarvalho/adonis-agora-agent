import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `@adonis-agora/agent/genui` is imported by browsers. Its runtime imports must stay inside
 * this folder: anything else (the loop, diagnostics, `node:*`) would drag server code into a client
 * bundle. Type-only imports are erased, so they may reach the rest of core.
 */
const dir = fileURLToPath(new URL('../src/genui/', import.meta.url));
const sources = readdirSync(dir).filter(
  (file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'),
);

function runtimeImports(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /^\s*(import|export)\s+(type\s+)?[^'";]*?from\s+['"]([^'"]+)['"]/gms;
  for (const match of source.matchAll(pattern)) {
    if (match[2] === undefined) specifiers.push(match[3] as string);
  }
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    specifiers.push(match[1] as string);
  }
  return specifiers;
}

describe('Adonis genui stays isomorphic', () => {
  it.each(sources)('%s imports only its siblings at runtime', (file) => {
    const imports = runtimeImports(readFileSync(`${dir}/${file}`, 'utf8'));
    for (const specifier of imports) {
      expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\/[\w-]+\.js$/);
    }
  });
});
