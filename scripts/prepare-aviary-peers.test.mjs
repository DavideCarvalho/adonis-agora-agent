import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareAviaryPeers } from './prepare-aviary-peers.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'aviary-peers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'upstream');
  await mkdir(source);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('remote', 'add', 'origin', 'https://github.com/DavideCarvalho/nestjs-agent.git');
  await writeFile(path.join(source, '.gitignore'), 'node_modules/\ndist/\n');
  await writeFile(path.join(source, 'package.json'), '{}');
  git('add', '.');
  git('commit', '--quiet', '-m', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  await writeFile(
    path.join(root, '.aviary-preview.json'),
    JSON.stringify({ repository: 'https://github.com/DavideCarvalho/nestjs-agent.git', commit }),
  );
  const destinations = [];
  for (const name of ['core', 'react']) {
    const directory = path.join(
      root,
      'node_modules',
      '.pnpm',
      name,
      'node_modules',
      '@dudousxd',
      `nestjs-agent-${name}`,
    );
    await mkdir(path.join(directory, 'dist'), { recursive: true });
    await writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: `@dudousxd/nestjs-agent-${name}` }),
    );
    await writeFile(path.join(directory, 'dist', 'index.js'), 'old');
    const imports = path.join(root, 'packages', 'adonis', 'node_modules', '@dudousxd');
    await mkdir(imports, { recursive: true });
    const { symlink } = await import('node:fs/promises');
    await symlink(directory, path.join(imports, `nestjs-agent-${name}`));
    destinations.push(directory);
  }
  const calls = [];
  const run = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (args.includes('build'))
      for (const name of ['core', 'react']) {
        const directory = path.join(source, 'packages', name, 'dist');
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, 'index.js'), `built-${name}`);
        if (name === 'core') {
          await mkdir(path.join(directory, 'genui'));
          await writeFile(path.join(directory, 'genui', 'index.js'), 'genui');
        }
      }
  };
  return { root, source, git, commit, run, calls, destinations };
}
test('verifies the exact pin, frozen installs/builds, and replaces local dist without changing hardlinks', async (t) => {
  const f = await fixture(t);
  const globalFile = path.join(f.root, 'global-copy');
  await link(path.join(f.destinations[0], 'dist', 'index.js'), globalFile);
  await prepareAviaryPeers({ root: f.root, source: f.source, run: f.run });
  assert.equal(await readFile(globalFile, 'utf8'), 'old');
  assert.equal(
    await readFile(path.join(f.destinations[0], 'dist', 'index.js'), 'utf8'),
    'built-core',
  );
  assert.ok(f.calls.some((call) => call.args.includes('--frozen-lockfile')));
  assert.ok(f.calls.some((call) => call.args.includes('build')));
});
test('rejects mismatched or dirty source before running dependency commands', async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.root, '.aviary-preview.json'),
    JSON.stringify({
      repository: 'https://github.com/DavideCarvalho/nestjs-agent.git',
      commit: 'a'.repeat(40),
    }),
  );
  await assert.rejects(
    prepareAviaryPeers({ root: f.root, source: f.source, run: f.run }),
    /commit/,
  );
  assert.equal(f.calls.length, 0);
  await writeFile(
    path.join(f.root, '.aviary-preview.json'),
    JSON.stringify({
      repository: 'https://github.com/DavideCarvalho/nestjs-agent.git',
      commit: f.commit,
    }),
  );
  await writeFile(path.join(f.source, 'package.json'), 'changed');
  await assert.rejects(prepareAviaryPeers({ root: f.root, source: f.source, run: f.run }), /clean/);
});
test('rejects missing local peers without installing upstream or writing destinations', async (t) => {
  const f = await fixture(t);
  await rm(f.destinations[1], { recursive: true });
  await assert.rejects(prepareAviaryPeers({ root: f.root, source: f.source, run: f.run }), /peer/);
  assert.equal(f.calls.length, 0);
});
test('rejects an installed peer resolving outside this checkout', async (t) => {
  const f = await fixture(t);
  const { symlink } = await import('node:fs/promises');
  const imports = path.join(
    f.root,
    'packages',
    'adonis',
    'node_modules',
    '@dudousxd',
    'nestjs-agent-core',
  );
  await rm(imports);
  await symlink(await realpath(f.source), imports);
  await assert.rejects(
    prepareAviaryPeers({ root: f.root, source: f.source, run: f.run }),
    /local node_modules/,
  );
});
test('propagates build failure without modifying installed dist', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    prepareAviaryPeers({
      root: f.root,
      source: f.source,
      run: async () => {
        throw new Error('build failed');
      },
    }),
    /build failed/,
  );
  assert.equal(await readFile(path.join(f.destinations[0], 'dist', 'index.js'), 'utf8'), 'old');
});
