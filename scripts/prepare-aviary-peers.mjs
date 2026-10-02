import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repository = 'https://github.com/DavideCarvalho/nestjs-agent.git';
const peers = ['core', 'react'];
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalRepository = (value) =>
  value.replace('git@github.com:', 'https://github.com/').replace(/\.git$/, '');
async function git(source, ...args) {
  return (await exec('git', args, { cwd: source })).stdout.trim();
}
export async function readPreviewManifest(root) {
  const pin = JSON.parse(await readFile(path.join(root, '.aviary-preview.json'), 'utf8'));
  if (
    pin.repository !== repository ||
    typeof pin.commit !== 'string' ||
    !/^[0-9a-f]{40}$/.test(pin.commit)
  ) {
    throw new Error('Invalid Aviary preview repository or full commit pin');
  }
  return pin;
}
async function runCommand(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} failed with exit ${code}`)),
    );
  });
}
async function installedPeers(root) {
  const localModules = await realpath(path.join(root, 'node_modules')).catch(() => {
    throw new Error('Missing local peers: run pnpm install --frozen-lockfile first');
  });
  // Reject external node_modules symlinks; never write to another checkout or the global store.
  if (localModules !== path.join(root, 'node_modules'))
    throw new Error('Expected local node_modules inside this checkout');
  return Promise.all(
    peers.map(async (name) => {
      const target = await realpath(
        path.join(root, 'packages/adonis/node_modules/@dudousxd', `nestjs-agent-${name}`),
      ).catch(() => {
        throw new Error(`Missing installed local peer @dudousxd/nestjs-agent-${name}`);
      });
      if (!target.startsWith(`${localModules}${path.sep}`))
        throw new Error('Peer must resolve inside local node_modules');
      const pkg = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'));
      if (pkg.name !== `@dudousxd/nestjs-agent-${name}`)
        throw new Error(`Incorrect local peer ${name}`);
      return { name, target };
    }),
  );
}
async function verifySource(source, pin) {
  if ((await git(source, 'rev-parse', 'HEAD')) !== pin.commit)
    throw new Error(`Aviary source commit must equal ${pin.commit}`);
  if (
    canonicalRepository(await git(source, 'remote', 'get-url', 'origin')) !==
    canonicalRepository(pin.repository)
  )
    throw new Error('Aviary source origin must match the pinned repository');
  if (await git(source, 'status', '--porcelain', '--untracked-files=normal'))
    throw new Error('Aviary source must be clean');
}
export async function prepareAviaryPeers({ root = scriptRoot, source, run = runCommand } = {}) {
  root = await realpath(root);
  const pin = await readPreviewManifest(root);
  const targets = await installedPeers(root);
  if (source === undefined) {
    source = path.join(root, '.aviary-preview', 'source');
    try {
      await realpath(source);
    } catch {
      await mkdir(path.dirname(source), { recursive: true });
      await run('git', ['clone', '--no-checkout', pin.repository, source], root);
      await run('git', ['fetch', '--depth=1', 'origin', pin.commit], source);
      await run('git', ['checkout', '--detach', pin.commit], source);
    }
  }
  source = await realpath(source);
  await verifySource(source, pin);
  // Always build from the verified source. Ignored dist files alone cannot prove their origin.
  // pnpm reads the upstream packageManager and selects its pinned version automatically.
  await run('pnpm', ['install', '--frozen-lockfile'], source);
  await run(
    'pnpm',
    [
      'exec',
      'turbo',
      'run',
      'build',
      '--filter=@dudousxd/nestjs-agent-core',
      '--filter=@dudousxd/nestjs-agent-react',
      '--force',
    ],
    source,
  );
  await verifySource(source, pin);
  for (const { name } of targets) {
    await readFile(path.join(source, 'packages', name, 'dist', 'index.js'));
  }
  await readFile(path.join(source, 'packages/core/dist/genui/index.js'));
  for (const { name, target } of targets) {
    const dist = path.join(target, 'dist');
    // Removing first breaks pnpm hardlinks instead of overwriting the shared store's files.
    await rm(dist, { recursive: true, force: true });
    await cp(path.join(source, 'packages', name, 'dist'), dist, {
      recursive: true,
      dereference: true,
    });
  }
  console.log(`Prepared local Aviary core/React peers at ${pin.commit}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--print-pin' && args.length === 1) {
    const pin = await readPreviewManifest(scriptRoot);
    console.log(`repository=DavideCarvalho/nestjs-agent\ncommit=${pin.commit}`);
  } else if (args.length === 0 || (args.length === 2 && args[0] === '--source')) {
    await prepareAviaryPeers(args.length ? { source: args[1] } : {});
  } else
    throw new Error('Usage: node scripts/prepare-aviary-peers.mjs [--source PATH | --print-pin]');
}
