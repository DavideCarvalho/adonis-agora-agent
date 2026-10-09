/**
 * The sandbox kit in an Adonis app: found through `@adonisjs/vite` — the dev server running in this
 * process (its `genuiSandboxKit()` plugin), else the descriptor it (or the assembler hook) wrote,
 * and in production the Vite manifest under the configured build directory.
 */
import { fileURLToPath } from 'node:url';
import { ADONIS_SANDBOX_KIT_DESCRIPTOR } from '../../vite/index.js';
import { type SandboxKitDiscovery, sandboxKitDiscovery } from './discover.js';
import type { GenuiSandboxKitApi } from './plugin.js';

interface AdonisAppLike {
  appRoot: URL | string;
  inProduction?: boolean;
  config: { get<T>(key: string, fallback?: T): T };
  container: { make(binding: string): Promise<unknown> };
}

interface ViteServiceLike {
  getDevServer?(): { config: { plugins: readonly { name: string; api?: unknown }[] } } | undefined;
}

/** Find the kit through the app's Vite setup. `app` is the Adonis application. */
export async function adonisSandboxKitDiscovery(app: unknown): Promise<SandboxKitDiscovery> {
  const adonis = app as AdonisAppLike | undefined;
  const root =
    adonis === undefined
      ? process.cwd()
      : typeof adonis.appRoot === 'string'
        ? adonis.appRoot
        : fileURLToPath(adonis.appRoot);
  let vite: ViteServiceLike | undefined;
  try {
    vite = (await adonis?.container.make('vite')) as ViteServiceLike | undefined;
  } catch {
    vite = undefined;
  }
  const config =
    adonis?.config.get<{ buildDirectory?: string; manifestFile?: string }>('vite', {}) ?? {};
  const buildDirectory = config.buildDirectory ?? 'public/assets';
  return sandboxKitDiscovery({
    root,
    descriptor: ADONIS_SANDBOX_KIT_DESCRIPTOR,
    manifest: {
      file: config.manifestFile ?? `${buildDirectory}/.vite/manifest.json`,
      outDir: buildDirectory,
    },
    plugin: () =>
      vite?.getDevServer?.()?.config.plugins.find((plugin) => plugin.name === 'genui-sandbox-kit')
        ?.api as GenuiSandboxKitApi | undefined,
    ...(adonis?.inProduction !== undefined ? { production: adonis.inProduction } : {}),
  });
}
