#!/usr/bin/env node
// Keep the `export const VERSION = '...'` literal(s) in every package's source in lockstep with
// the package.json `version` that `changeset version` just wrote. Runs recursively over each
// workspace package's `src/` so a stray VERSION literal anywhere under src can't silently drift
// from the published version.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packagesDir = join(root, 'packages');

/** Recursively collect every `.ts` file under `dir` (skipping node_modules / dist / .turbo). */
function collectTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') {
      continue;
    }
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// `export const VERSION = '...'` — single or double quoted.
const VERSION_RE = /(export\s+const\s+VERSION\s*=\s*)(['"])[^'"]*\2/g;

let changed = 0;
for (const pkg of readdirSync(packagesDir)) {
  const pkgDir = join(packagesDir, pkg);
  if (!statSync(pkgDir).isDirectory()) {
    continue;
  }
  const manifestPath = join(pkgDir, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    continue;
  }
  const version = manifest.version;
  if (typeof version !== 'string') {
    continue;
  }
  const srcDir = join(pkgDir, 'src');
  let files;
  try {
    files = collectTsFiles(srcDir);
  } catch {
    continue;
  }
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const next = source.replace(VERSION_RE, `$1'${version}'`);
    if (next !== source) {
      writeFileSync(file, next);
      changed += 1;
      console.log(`synced VERSION → ${version} in ${file}`);
    }
  }
}

console.log(`sync-version: ${changed} file(s) updated`);
