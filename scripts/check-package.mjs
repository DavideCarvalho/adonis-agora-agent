#!/usr/bin/env node
// Lint what each published package would ship: publint (package.json / exports / files) and
// Are the Types Wrong (type resolution of every export, ESM-only). Runs against the built
// `dist/`, so build first. Private packages are skipped.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packagesDir = join(root, 'packages');
const bin = (name) => join(root, 'node_modules', '.bin', name);

let failed = false;
for (const entry of readdirSync(packagesDir)) {
  const dir = join(packagesDir, entry);
  if (!statSync(dir).isDirectory()) continue;
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (manifest.private === true) continue;
  for (const [tool, args] of [
    ['publint', ['--strict']],
    ['attw', ['--pack', '.', '--profile', 'esm-only']],
  ]) {
    console.log(`\n▶ ${manifest.name}: ${tool}`);
    try {
      execFileSync(bin(tool), args, { cwd: dir, stdio: 'inherit' });
    } catch {
      failed = true;
    }
  }
}
process.exit(failed ? 1 : 0);
