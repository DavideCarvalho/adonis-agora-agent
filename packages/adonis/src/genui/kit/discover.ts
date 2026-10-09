/**
 * Finding the sandbox kit at runtime, the way an app's `@vite()` finds its assets: the Vite plugin
 * running in this process (dev), the descriptor it wrote (dev, Vite in another process), or the
 * production manifest (`genui-sandbox-kit.json` and the assets it names). And turning what is found
 * into what the sandbox definition tells the model and what `GET <agent>/config` tells the browser.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DefineSandboxOptions } from '../sandbox.js';
import type { SandboxClientConfig, SandboxKitDescriptor, SandboxKitDocs } from '../sandbox-kit.js';
import { type GenuiSandboxKitApi, SANDBOX_KIT_MANIFEST_KEYS } from './plugin.js';

export interface SandboxKitDiscoveryOptions {
  /** The app root (relative paths below resolve against it). */
  root: string;
  /** The descriptor the dev plugin (or a docs generator) writes. */
  descriptor?: string;
  /** The production manifest, and the directory its `file`s are relative to. */
  manifest?: { file: string; outDir: string };
  /** The plugin's live API, when Vite runs in this process (the Adonis dev server). */
  plugin?: () => GenuiSandboxKitApi | undefined;
  /** Read the manifest first (production). Default: `NODE_ENV === 'production'`. */
  production?: boolean;
  /** An explicit kit url (an SPA served from elsewhere), over what is found. */
  kitUrl?: string;
}

export interface SandboxKitDiscovery {
  /** What is known now: docs, theme names, asset urls — `null` when nothing was found. */
  descriptor(): SandboxKitDescriptor | null;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function isDescriptor(value: unknown): value is SandboxKitDescriptor {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { components?: unknown }).components)
  );
}

/** Find the kit (re-read when the files change — dev rewrites them). */
export function sandboxKitDiscovery(options: SandboxKitDiscoveryOptions): SandboxKitDiscovery {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const cache = new Map<string, { mtime: number; value: unknown }>();
  const cached = (path: string): unknown => {
    if (!existsSync(path)) return undefined;
    const mtime = statSync(path).mtimeMs;
    const hit = cache.get(path);
    if (hit !== undefined && hit.mtime === mtime) return hit.value;
    const value = readJson(path);
    cache.set(path, { mtime, value });
    return value;
  };
  const fromManifest = (): SandboxKitDescriptor | null => {
    if (options.manifest === undefined) return null;
    const manifest = cached(resolve(options.root, options.manifest.file)) as
      | Record<string, { file?: string }>
      | undefined;
    const file = manifest?.[SANDBOX_KIT_MANIFEST_KEYS.descriptor]?.file;
    if (file === undefined) return null;
    const value = cached(join(resolve(options.root, options.manifest.outDir), file));
    return isDescriptor(value) ? value : null;
  };
  const fromDev = (): SandboxKitDescriptor | null => {
    const live = options.plugin?.()?.descriptor();
    if (live !== undefined && live !== null) return live;
    if (options.descriptor === undefined) return null;
    const value = cached(resolve(options.root, options.descriptor));
    return isDescriptor(value) ? value : null;
  };
  return {
    descriptor() {
      const found = production ? (fromManifest() ?? fromDev()) : (fromDev() ?? fromManifest());
      if (found === null || options.kitUrl === undefined) return found;
      return { ...found, kit: { url: options.kitUrl } };
    },
  };
}

/** The server's sandbox options, resolved against what was discovered. */
export interface ResolvedSandboxServer {
  /** For `defineSandbox`: the kit's docs and the theme's names read from the discovery each time. */
  define: DefineSandboxOptions;
  /** For `GET <agent>/config` → `genui.sandbox`. */
  client(): SandboxClientConfig;
}

/**
 * `sandbox: { kit: true, tailwind: true }` (or `true`) as the definition and the browser need it:
 * docs and theme names from the discovery, asset urls for the client. A kit or Tailwind asked for
 * but not found is left out of what the browser is told (and the model is still told of a kit only
 * when docs exist), so a missing build degrades to the plain sandbox.
 */
export function resolveSandboxServer(
  sandbox: true | DefineSandboxOptions,
  discovery: SandboxKitDiscovery,
): ResolvedSandboxServer {
  const given: DefineSandboxOptions = sandbox === true ? {} : sandbox;
  const kitAsked = given.kit === true;
  const docs = (): SandboxKitDocs | undefined => {
    const found = discovery.descriptor();
    return found === null ? undefined : found;
  };
  const themeOn = given.theme !== false;
  const define: DefineSandboxOptions = {
    ...given,
    ...(kitAsked ? { kit: docs } : {}),
    ...(themeOn && typeof given.theme !== 'object'
      ? { theme: { vars: () => docs()?.theme?.vars } }
      : {}),
  };
  return {
    define,
    client() {
      const found = discovery.descriptor();
      return {
        theme: themeOn,
        ...(given.tailwind === true && found?.tailwind ? { tailwind: found.tailwind } : {}),
        ...(given.kit !== undefined && given.kit !== false && found?.kit ? { kit: found.kit } : {}),
      };
    },
  };
}
