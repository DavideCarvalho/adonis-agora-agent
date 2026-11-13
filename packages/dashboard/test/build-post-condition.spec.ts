// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The dashboard shares `packages/adonis`'s build defect and needs its own wiring assertion,
 *  because its exposure has a sharper edge: `build` is `vite build && tsc`, and vite keeps emitting
 *  into `dist/spa/` no matter what tsc does. A dist with no provider in it still holds a dozen
 *  `.js` files, so a bare "did we emit any JavaScript" count would wave it through. That is why
 *  `check:dist` here names the entrypoint.
 *
 *  The guard script's own behaviour is covered once, in packages/adonis. */
describe('dashboard build post-condition', () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { main: string; scripts: Record<string, string> };

  it('runs the guard as the last step of build', () => {
    expect(pkg.scripts.build).toContain('check:dist');
    expect(pkg.scripts['check:dist']).toContain('assert-build-output.mjs');
  });

  it('has a prepack that verifies rather than rebuilds', () => {
    // This one is a scar. `prepack` used to be `pnpm run build`, which was harmless until `build`
    // gained `clean`. Then `changeset publish` — which packs both workspace packages concurrently —
    // had `packages/adonis`'s prepack run `rm -rf dist` while THIS package's `vite build` + `tsc`
    // were resolving `@adonis-agora/agent` out of that very directory. Result: agent@0.18.0
    // published and agent-dashboard@0.4.0 died, with no output past its own `rm -rf dist`.
    //
    // The release workflow already runs a full build before publishing, so prepack's job is to
    // REFUSE a bad dist, not to produce one. Verification is idempotent and touches nothing.
    expect(pkg.scripts.prepack).toBe('pnpm run check:dist');
    expect(pkg.scripts.prepack).not.toContain('build');
  });

  it('asserts the entrypoint by name, not just that some JavaScript exists', () => {
    // vite's output would satisfy a count on its own. The name is the whole point.
    const entrypoint = pkg.main.replace(/^\.\/dist\//, '');

    expect(pkg.scripts['check:dist']).toContain(entrypoint);
  });

  it('keeps the bundled fonts: their CSS is a side effect the bundler must not drop', () => {
    // With `"sideEffects": false`, Vite tree-shakes `import '../agora-kit/fonts'` and every
    // fontsource stylesheet with it: the build still emits the .woff2 files, but the CSS has no
    // @font-face, so the console silently falls back to system fonts.
    const { sideEffects } = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { sideEffects: unknown };
    expect(sideEffects).toEqual(expect.arrayContaining(['*.css', './src/agora-kit/fonts.ts']));

    // When the SPA was built, its stylesheet carries the faces, with URLs relative to the CSS
    // (so they resolve under any mount path).
    const assets = fileURLToPath(new URL('../dist/spa/assets/', import.meta.url));
    if (!existsSync(assets)) return;
    const css = readdirSync(assets)
      .filter((file) => file.endsWith('.css'))
      .map((file) => readFileSync(`${assets}${file}`, 'utf8'))
      .join('\n');
    expect(css).toMatch(/@font-face\{font-family:Sora;[^}]*src:url\(\.\/sora-/);
    expect(css).toMatch(/@font-face\{font-family:JetBrains Mono;[^}]*src:url\(\.\/jetbrains-mono-/);
  });

  it('cleans before it compiles and compiles without incremental state', () => {
    const build = pkg.scripts.build!;

    expect(build.indexOf('clean')).toBeLessThan(build.indexOf('tsc'));
    expect(build).toContain('tsconfig.build.json');

    const buildConfig = JSON.parse(
      readFileSync(fileURLToPath(new URL('../tsconfig.build.json', import.meta.url)), 'utf8'),
    ) as { compilerOptions: { incremental: boolean; tsBuildInfoFile: string | null } };

    expect(buildConfig.compilerOptions.incremental).toBe(false);
    expect(buildConfig.compilerOptions.tsBuildInfoFile).toBeNull();
  });
});
