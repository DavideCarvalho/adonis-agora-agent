import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseSync } from '@swc/core';
import { describe, expect, it } from 'vitest';

const packagesRoot = new URL('../../', import.meta.url);
const isAviary = (name: string) => name.startsWith('@dudousxd/nestjs-');

async function sourceFiles(root: URL): Promise<URL[]> {
  const files: URL[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), root);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(spec|test)\./.test(entry.name))
      files.push(path);
  }
  return files;
}

/** Parse import/export syntax so comments and compatible protocol names never count as coupling. */
function importedPackages(source: string, tsx = false): string[] {
  const packages: string[] = [];
  const tree = parseSync(source, { syntax: 'typescript', tsx, decorators: true });
  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const literal = (value: unknown): string | undefined => {
    const node = record(value);
    return node?.type === 'StringLiteral' && typeof node.value === 'string'
      ? node.value
      : undefined;
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = record(value);
    if (!node) return;
    if (
      [
        'ImportDeclaration',
        'ExportDeclaration',
        'ExportNamedDeclaration',
        'ExportAllDeclaration',
      ].includes(String(node.type))
    ) {
      const dependency = literal(node.source);
      if (dependency) packages.push(dependency);
    }
    if (node.type === 'CallExpression') {
      const callee = record(node.callee);
      if (
        callee?.type === 'Import' ||
        (callee?.type === 'Identifier' && callee.value === 'require')
      ) {
        const argument = Array.isArray(node.arguments) ? record(node.arguments[0]) : undefined;
        const dependency = literal(argument?.expression);
        if (dependency) packages.push(dependency);
      }
    }
    if (node.type === 'TsImportType') {
      const dependency = literal(node.argument);
      if (dependency) packages.push(dependency);
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(tree);
  return packages;
}

describe('Agora remains independent of Aviary', () => {
  it('recognizes all package-loading syntax without confusing protocol compatibility with dependencies', () => {
    expect(
      importedPackages(`
      // Compatible protocol producer: @dudousxd/nestjs-agent/ag-ui
      const eventName = 'aviary.ui';
      import { value } from '@dudousxd/nestjs-agent';
      export * from '@dudousxd/nestjs-agent/react';
      import '@dudousxd/nestjs-agent/genui';
      import('@dudousxd/nestjs-agent/react/genui/server');
      require('@dudousxd/nestjs-agent');
      type Foreign = import('@dudousxd/nestjs-agent').Foreign;
    `),
    ).toEqual([
      '@dudousxd/nestjs-agent',
      '@dudousxd/nestjs-agent/react',
      '@dudousxd/nestjs-agent/genui',
      '@dudousxd/nestjs-agent/react/genui/server',
      '@dudousxd/nestjs-agent',
      '@dudousxd/nestjs-agent',
    ]);
  });

  it('declares no Aviary dependency in any Agora package', async () => {
    const violations: string[] = [];
    for (const name of await readdir(packagesRoot)) {
      const manifest = JSON.parse(
        await readFile(new URL(`${name}/package.json`, packagesRoot), 'utf8'),
      ) as Record<string, unknown>;
      for (const key of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'peerDependenciesMeta',
        'optionalDependencies',
      ]) {
        const dependencies = manifest[key] as Record<string, string> | undefined;
        for (const dependency of Object.keys(dependencies ?? {})) {
          if (isAviary(dependency)) violations.push(`${name}/package.json ${key}: ${dependency}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('owns its implementations without Aviary imports or re-exports', async () => {
    const violations: string[] = [];
    for (const name of await readdir(packagesRoot)) {
      const files = await sourceFiles(new URL(`${name}/src/`, packagesRoot));
      for (const file of files) {
        const source = await readFile(file, 'utf8');
        for (const dependency of importedPackages(source, file.pathname.endsWith('.tsx'))) {
          if (isAviary(dependency)) violations.push(`${fileURLToPath(file)} imports ${dependency}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
