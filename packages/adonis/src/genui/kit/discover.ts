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
import { type GenuiSandboxKitApi, sandboxKitManifestKeys } from './plugin.js';

export interface SandboxKitDiscoveryOptions {
  /** The app root (relative paths below resolve against it). */
  root: string;
  /**
   * The kit's name (`genuiSandboxKit({ name })`): its manifest keys. `descriptor` and `plugin` are
   * given for that kit already. Unnamed: the app's one kit.
   */
  name?: string;
  /** The descriptor the dev plugin (or a docs generator) writes. */
  descriptor?: string;
  /** The production manifest, and the directory its `file`s are relative to. */
  manifest?: { file: string; outDir: string };
  /** The plugin's live API, when Vite runs in this process (the Adonis dev server). */
  plugin?: () => GenuiSandboxKitApi | undefined;
  /**
   * Production: the manifest first. Otherwise the in-process dev server, else whichever of the dev
   * descriptor and the build's descriptor was written last. Default: `NODE_ENV === 'production'`.
   */
  production?: boolean;
  /** An explicit kit url (an SPA served from elsewhere), over what is found. */
  kitUrl?: string;
}

export interface SandboxKitDiscovery {
  /** The kit's name, for a named kit. */
  readonly name?: string;
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
    (value as { version?: unknown }).version === 2 &&
    Array.isArray((value as { components?: unknown }).components) &&
    typeof (value as { assets?: unknown }).assets === 'object'
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
  const mtimeOf = (path: string): number => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  };
  /** The build's descriptor, and when it was written. */
  const fromManifest = (): { value: SandboxKitDescriptor; mtime: number } | null => {
    if (options.manifest === undefined) return null;
    const manifest = cached(resolve(options.root, options.manifest.file)) as
      | Record<string, { file?: string }>
      | undefined;
    const file = manifest?.[sandboxKitManifestKeys(options.name).descriptor]?.file;
    if (file === undefined) return null;
    const path = join(resolve(options.root, options.manifest.outDir), file);
    const value = cached(path);
    return isDescriptor(value) ? { value, mtime: mtimeOf(path) } : null;
  };
  /** The dev server's descriptor file, and when it was written. */
  const fromDevFile = (): { value: SandboxKitDescriptor; mtime: number } | null => {
    if (options.descriptor === undefined) return null;
    const path = resolve(options.root, options.descriptor);
    const value = cached(path);
    return isDescriptor(value) ? { value, mtime: mtimeOf(path) } : null;
  };
  const find = (): SandboxKitDescriptor | null => {
    // A dev server in this process is current by definition.
    const live = options.plugin?.()?.descriptor();
    if (live !== undefined && live !== null) return live;
    const built = fromManifest();
    if (production) return built?.value ?? fromDevFile()?.value ?? null;
    // Outside production, a dev descriptor left over from an earlier `vite dev` must not shadow a
    // newer build (or the other way round): the one written last wins.
    const dev = fromDevFile();
    if (dev === null || built === null) return dev?.value ?? built?.value ?? null;
    return dev.mtime >= built.mtime ? dev.value : built.value;
  };
  return {
    ...(options.name !== undefined ? { name: options.name } : {}),
    descriptor() {
      const found = find();
      if (found === null || options.kitUrl === undefined) return found;
      return { ...found, jsx: true, assets: { ...found.assets, kit: { url: options.kitUrl } } };
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
 * `sandbox: { kit: true }` (or `true`) as the definition and the browser need it: docs and theme
 * names from the discovery, asset urls for the client. What was asked for but not found is left out
 * of what the browser is told (and of what the model is told), so a missing build degrades to the
 * plain sandbox.
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
      const kitOn = given.kit !== undefined && given.kit !== false;
      const assets = kitOn ? discovery.descriptor()?.assets : undefined;
      return {
        theme: themeOn,
        ...(assets !== undefined && discovery.name !== undefined ? { name: discovery.name } : {}),
        ...(assets?.kit ? { kit: assets.kit } : {}),
        ...(assets?.css ? { css: assets.css } : {}),
        ...(assets?.tailwind ? { tailwind: assets.tailwind } : {}),
      };
    },
  };
}
