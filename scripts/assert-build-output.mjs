#!/usr/bin/env node
/**
 * Post-condition for package `build` scripts: refuse to let a build exit 0 when it
 * emitted no JavaScript.
 *
 * Why this exists: `tsc` with `incremental: true` treats its `.tsbuildinfo` as the
 * record of what is already on disk. Delete `dist/` but leave the buildinfo behind and
 * `tsc` concludes every output is current and emits nothing — exit code 0, empty
 * `dist/`. Turbo then caches that empty directory as a successful `build`, and serves
 * it to every later run. `prepack` has no turbo in front of it at all, so a manual
 * `pnpm publish` from such a tree would ship a package with no code in it.
 *
 * The build script now removes `dist/` and builds with `incremental: false`, so the
 * stale-state trigger is gone. This check is the belt to that pair of braces: it runs
 * inside the build itself, so it protects the `prepack` path too, and it fires before
 * turbo can write a vacuum into the cache.
 *
 * A count alone is not enough. A partial emit that produced only the root entrypoint
 * still satisfies "dist has JavaScript" *and* "the entrypoint is there", while every
 * subpath export (`@pkg/agent/rag-media`, …) resolves to a file that does not exist —
 * and consumers, not this build, are the ones who find out. So the check also walks
 * `package.json`'s `exports` and requires every target it declares. That list is the
 * package's actual publish contract, and it extends itself: adding an export adds a
 * post-condition without anyone remembering to.
 *
 * Usage, from a package directory:
 *   node ../../scripts/assert-build-output.mjs <dist-dir> [required-file...]
 * where required files are relative to <dist-dir>.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [distArg, ...requiredFiles] = process.argv.slice(2);

if (!distArg) {
  fail('usage: assert-build-output.mjs <dist-dir> [required-file...]');
}

const cwd = process.cwd();
const distDir = resolve(cwd, distArg);

function fail(message) {
  console.error(`\nbuild post-condition failed: ${message}\n`);
  process.exit(1);
}

function countJsFiles(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += countJsFiles(full);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      total += 1;
    }
  }
  return total;
}

const recovery = [
  'How to recover:',
  // Both globs on purpose: the buildinfo files here are dotfiles, and a shell `*` does
  // not match those. `rm -rf dist *.tsbuildinfo` alone leaves the stale state in place.
  `  rm -rf ${distArg} .*tsbuildinfo *.tsbuildinfo`,
  '  pnpm run build',
  '',
  'If that produces JavaScript, the tree had stale incremental state: tsc believed',
  'its outputs were already on disk and emitted nothing. Do NOT publish a tree in',
  'this state — package `files` ships dist/, so the tarball would contain no code.',
].join('\n');

if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
  fail(`${distArg} does not exist after the build.\n\n${recovery}`);
}

const jsFiles = countJsFiles(distDir);
if (jsFiles === 0) {
  fail(`${distArg} contains no JavaScript after the build (0 .js files).\n\n${recovery}`);
}

for (const required of requiredFiles) {
  if (!existsSync(resolve(distDir, required))) {
    fail(
      `${distArg} is missing the required entrypoint ${required}, though it does ` +
        `contain ${jsFiles} .js file(s).\n\n${recovery}`,
    );
  }
}

/** Every string leaf under `exports` that points at a file in this package. */
function collectExportTargets(node, into) {
  if (typeof node === 'string') {
    if (node.startsWith('./')) into.add(node);
    return into;
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectExportTargets(value, into);
  }
  return into;
}

const pkgPath = resolve(cwd, 'package.json');
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const targets = [...collectExportTargets(pkg.exports ?? {}, new Set())].sort();
  const missing = targets.filter((target) => !existsSync(resolve(cwd, target)));
  if (missing.length > 0) {
    fail(
      [
        `${missing.length} of ${targets.length} paths declared in package.json "exports" do not`,
        `exist after the build, though ${distArg} contains ${jsFiles} .js file(s) — this is a`,
        'partial emit. Importing these subpaths would fail for consumers:',
        ...missing.map((target) => `  ${target}`),
        '',
        recovery,
      ].join('\n'),
    );
  }
}
