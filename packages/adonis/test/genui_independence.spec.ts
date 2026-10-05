import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const genuiRoot = new URL('../src/genui/', import.meta.url);

describe('independent Adonis GenUI implementation', () => {
  it('owns its implementation without importing or re-exporting Aviary packages', async () => {
    const files = await readdir(genuiRoot);
    const sources = await Promise.all(
      files
        .filter((file) => file.endsWith('.ts'))
        .map((file) => readFile(new URL(file, genuiRoot), 'utf8')),
    );
    expect(sources.join('\n')).not.toMatch(/@dudousxd\/nestjs-agent/);
  });
  it('ships every local GenUI implementation module', async () => {
    const files = await readdir(genuiRoot);
    for (const name of [
      'catalog',
      'schema',
      'text',
      'tree',
      'capabilities',
      'registry',
      'tools',
      'builtins',
    ]) {
      expect(files).toContain(`${name}.ts`);
    }
  });
});
