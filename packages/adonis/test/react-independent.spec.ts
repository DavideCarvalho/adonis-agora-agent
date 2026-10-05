import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const react = resolve(dirname(fileURLToPath(import.meta.url)), '../src/react');
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(resolve(directory, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [resolve(directory, entry.name)]
        : [],
  );
}
describe('independent Adonis React implementation', () => {
  it('owns every implementation without Aviary imports or re-exports', () => {
    const forbidden = sources(react).filter((path) =>
      readFileSync(path, 'utf8').includes('@dudousxd/'),
    );
    expect(forbidden).toEqual([]);
    expect(readFileSync(resolve(react, 'core/use-agent-chat.ts'), 'utf8')).toContain(
      'export function useAgentChat',
    );
  });
  it('never loads the server root through browser runtime imports', () => {
    for (const path of sources(resolve(react, 'core'))) {
      const source = readFileSync(path, 'utf8');
      for (const statement of source.matchAll(
        /^(?:import|export)\s+(?:type\s+)?[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/gm,
      )) {
        if (/^(?:\.\.\/){2,}index\.js$/.test(statement[1] ?? '')) {
          expect(statement[0]).toMatch(/^(?:import|export)\s+type\b/);
        }
      }
    }
  });
  it('keeps optional server, markdown, media and json-render entries out of the base entry', () => {
    const entry = readFileSync(resolve(react, 'index.ts'), 'utf8');
    expect(entry).not.toMatch(/from ['"][^'"]*(?:\/server|\/markdown|\/media|\/json-render)['"]/);
  });
});
