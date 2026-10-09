/**
 * `genuiSandboxKit()` — the Vite plugin that makes the app's design system available to the
 * sandbox, with no command to run by hand:
 *
 * - dev: builds the kit bundle (the app's components + React as one IIFE) and serves it, with the
 *   Tailwind runtime, under `/@genui-sandbox-kit/`; writes the descriptor (docs + urls) for the
 *   server; rebuilds when a kit file changes and tells open pages, whose sandboxes reload (HMR);
 * - build: emits both as hashed assets plus `genui-sandbox-kit.json` (the docs and their urls), and
 *   lists the three in the Vite manifest — where the server finds them, as it finds any asset;
 * - collects the theme's custom properties from the app's own CSS, for the prompt.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import type { SandboxKitComponentDoc, SandboxKitDescriptor } from '../sandbox-kit.js';
import { themeVarsFromCss } from '../sandbox-theme.js';
import { buildSandboxKitBundle, type SandboxKitBundle } from './bundle.js';
import { generateSandboxKitDocs } from './docs.js';
import {
  resolveSandboxKitFiles,
  type SandboxKitFiles,
  type SandboxKitSourceOptions,
} from './files.js';

export interface GenuiSandboxKitOptions extends SandboxKitSourceOptions {
  /** Serve (and emit) the Tailwind runtime for `sandbox({ tailwind: true })`. Default true. */
  tailwind?: boolean;
  /** Where the dev descriptor is written, relative to the Vite root. */
  descriptor?: string;
  /** The tsconfig the kit's types are read with. Default: the nearest to the kit. */
  tsconfig?: string;
  /** A TypeScript module with the compiler API, when the project's own has none (TypeScript 7). */
  typescript?: unknown;
  /** Extra Vite plugins for the kit build. */
  plugins?: unknown[];
}

/** The library-specific defaults the shared plugin is built with. */
export interface GenuiSandboxKitDefaults {
  /** Default dev descriptor path, relative to the Vite root. */
  descriptor: string;
  /** App modules importing the renderer get the HMR bridge: a test on their source. */
  rendererImport: RegExp;
}

/** Where the dev server serves the assets. */
export const SANDBOX_KIT_DEV_PREFIX = '@genui-sandbox-kit/';
/** The Vite manifest keys the build lists them under. */
export const SANDBOX_KIT_MANIFEST_KEYS = {
  kit: 'genui-sandbox-kit.js',
  tailwind: 'genui-sandbox-tailwind.js',
  descriptor: 'genui-sandbox-kit.json',
} as const;
/** The event a page gets (`window`) when the kit was rebuilt in dev. */
export const SANDBOX_KIT_UPDATE_EVENT = 'genui-sandbox-kit:update';

/** What the plugin exposes to the server process it runs in (`plugin.api`). */
export interface GenuiSandboxKitApi {
  /** The current descriptor (dev), once the first build is done. */
  descriptor(): SandboxKitDescriptor | null;
  /** Resolves when the first build is done. */
  ready(): Promise<void>;
}

function tailwindRuntimePath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve('@tailwindcss/browser');
  } catch {
    return null;
  }
}

function fallbackDocs(bundle: SandboxKitBundle | null): SandboxKitComponentDoc[] {
  return (bundle?.exports ?? []).map((name) => ({ name, props: [] }));
}

const HMR_BRIDGE = `
if (import.meta.hot && typeof window !== 'undefined' && !window.__genuiSandboxKitHmr) {
  window.__genuiSandboxKitHmr = true;
  import.meta.hot.on(${JSON.stringify(SANDBOX_KIT_UPDATE_EVENT)}, (data) => window.dispatchEvent(new CustomEvent(${JSON.stringify(SANDBOX_KIT_UPDATE_EVENT)}, { detail: data })));
}`;

interface ViteLikeConfig {
  root: string;
  base: string;
  command: 'serve' | 'build';
  resolve: Record<string, unknown>;
  build: { outDir: string; manifest: boolean | string };
  logger: { info(message: string): void; warn(message: string): void };
}

/** The plugin, with a library's defaults. */
/** The plugin object: a Vite plugin with the {@link GenuiSandboxKitApi} on `api`. */
export type GenuiSandboxKitPlugin = Plugin & { api: GenuiSandboxKitApi };

export function createGenuiSandboxKitPlugin(
  options: GenuiSandboxKitOptions,
  defaults: GenuiSandboxKitDefaults,
): GenuiSandboxKitPlugin {
  let config: ViteLikeConfig | undefined;
  let files: SandboxKitFiles | null = null;
  let bundle: SandboxKitBundle | null = null;
  let docs: SandboxKitComponentDoc[] = [];
  const themeVars: Record<string, string> = {};
  let descriptor: SandboxKitDescriptor | null = null;
  let firstBuild: Promise<void> | undefined;
  let onReady!: () => void;
  const ready = new Promise<void>((resolveReady) => {
    onReady = resolveReady;
  });
  let warnedDocs = false;
  const tailwindOn = options.tailwind !== false;

  const devUrl = (name: string, hash?: string) =>
    `${config?.base ?? '/'}${SANDBOX_KIT_DEV_PREFIX}${name}${hash ? `?v=${hash}` : ''}`;

  const describeDev = (): SandboxKitDescriptor => ({
    version: 1,
    components: docs,
    ...(Object.keys(themeVars).length > 0 ? { theme: { vars: { ...themeVars } } } : {}),
    kit: bundle === null ? null : { url: devUrl('kit.js', bundle.hash), hash: bundle.hash },
    tailwind: tailwindOn && tailwindRuntimePath() !== null ? { url: devUrl('tailwind.js') } : null,
  });

  const writeDescriptor = () => {
    if (config === undefined) return;
    descriptor = describeDev();
    const path = resolve(config.root, options.descriptor ?? defaults.descriptor);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(descriptor, null, 2)}\n`);
    } catch (error) {
      config.logger.warn(
        `[genui-sandbox-kit] could not write ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const buildAll = async (): Promise<void> => {
    if (config === undefined) return;
    files = resolveSandboxKitFiles(config.root, options);
    if (files === null) {
      bundle = null;
      docs = [];
      return;
    }
    const [built, generated] = await Promise.all([
      buildSandboxKitBundle({
        root: config.root,
        files,
        resolve: config.resolve,
        ...(options.plugins !== undefined ? { plugins: options.plugins } : {}),
      }),
      generateSandboxKitDocs({
        root: config.root,
        files,
        ...(options.tsconfig !== undefined ? { tsconfig: options.tsconfig } : {}),
        ...(options.typescript !== undefined ? { typescript: options.typescript } : {}),
      }).catch((error: unknown) => {
        if (!warnedDocs) {
          warnedDocs = true;
          config?.logger.warn(
            `[genui-sandbox-kit] kit docs from names only: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return null;
      }),
    ]);
    bundle = built;
    docs = generated ?? fallbackDocs(built);
  };

  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;

  const plugin = {
    name: 'genui-sandbox-kit',
    enforce: 'pre' as const,
    api: {
      descriptor: () => descriptor,
      ready: () => ready,
    } satisfies GenuiSandboxKitApi,

    configResolved(resolved: ViteLikeConfig) {
      config = resolved;
    },

    transform(code: string, id: string) {
      const path = id.split('?')[0] ?? id;
      if (path.endsWith('.css') && !path.includes('/node_modules/')) {
        const found = themeVarsFromCss(code);
        let changed = false;
        for (const [name, value] of Object.entries(found)) {
          if (themeVars[name] === undefined) {
            themeVars[name] = value;
            changed = true;
          }
        }
        if (changed && config?.command === 'serve' && firstBuild !== undefined) writeDescriptor();
        return null;
      }
      if (
        config?.command === 'serve' &&
        /\.[cm]?[jt]sx?$/.test(path) &&
        !path.includes('/node_modules/') &&
        defaults.rendererImport.test(code)
      ) {
        return { code: `${code}\n${HMR_BRIDGE}`, map: null };
      }
      return null;
    },

    configureServer(server: {
      middlewares: {
        use(handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): void;
      };
      watcher: {
        on(event: string, listener: (file: string) => void): void;
        add?(paths: string[]): void;
      };
      ws: { send(payload: unknown): void };
    }) {
      firstBuild = buildAll()
        .catch((error: unknown) => {
          config?.logger.warn(
            `[genui-sandbox-kit] the kit did not build: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          writeDescriptor();
          if (files !== null) server.watcher.add?.(files.dirs);
          onReady();
        });
      server.middlewares.use((req, res, next) => {
        const url = String(req.url ?? '').split('?')[0] ?? '';
        const prefix = `${config?.base ?? '/'}${SANDBOX_KIT_DEV_PREFIX}`;
        if (!url.startsWith(prefix) && !url.startsWith(`/${SANDBOX_KIT_DEV_PREFIX}`)) return next();
        const name = url.slice(url.lastIndexOf('/') + 1);
        void (async () => {
          await firstBuild;
          let body: string | null = null;
          let type = 'text/javascript; charset=utf-8';
          if (name === 'kit.js') body = bundle?.code ?? null;
          else if (name === 'tailwind.js' && tailwindOn) {
            const path = tailwindRuntimePath();
            body = path === null ? null : readFileSync(path, 'utf8');
          } else if (name === 'descriptor.json') {
            body = JSON.stringify(descriptor);
            type = 'application/json';
          }
          if (body === null) {
            res.statusCode = 404;
            res.end('not found');
            return;
          }
          res.setHeader('content-type', type);
          res.setHeader('cache-control', 'no-cache');
          res.end(body);
        })();
      });
      const changed = (file: string) => {
        if (config === undefined) return;
        const inKit =
          files?.dirs.some((dir) => file.startsWith(dir)) === true ||
          bundle?.modules.includes(file) === true;
        if (!inKit) return;
        clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(() => {
          firstBuild = buildAll()
            .then(() => {
              writeDescriptor();
              server.ws.send({
                type: 'custom',
                event: SANDBOX_KIT_UPDATE_EVENT,
                data: { hash: bundle?.hash ?? null, url: descriptor?.kit?.url ?? null },
              });
              config?.logger.info('[genui-sandbox-kit] kit rebuilt');
            })
            .catch((error: unknown) => {
              config?.logger.warn(
                `[genui-sandbox-kit] the kit did not rebuild: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
        }, 150);
      };
      server.watcher.on('change', changed);
      server.watcher.on('add', changed);
      server.watcher.on('unlink', changed);
    },

    async generateBundle(this: {
      emitFile(file: {
        type: 'asset';
        name?: string;
        fileName?: string;
        source: string;
        originalFileName?: string;
      }): string;
      getFileName(ref: string): string;
    }) {
      if (config?.command !== 'build') return;
      await buildAll();
      const base = config.base ?? '/';
      let kit: SandboxKitDescriptor['kit'] = null;
      if (bundle !== null) {
        const ref = this.emitFile({
          type: 'asset',
          name: SANDBOX_KIT_MANIFEST_KEYS.kit,
          originalFileName: SANDBOX_KIT_MANIFEST_KEYS.kit,
          source: bundle.code,
        });
        kit = { url: `${base}${this.getFileName(ref)}`, hash: bundle.hash };
        emitted.kit = this.getFileName(ref);
      }
      let tailwind: SandboxKitDescriptor['tailwind'] = null;
      const runtime = tailwindOn ? tailwindRuntimePath() : null;
      if (runtime !== null) {
        const ref = this.emitFile({
          type: 'asset',
          name: SANDBOX_KIT_MANIFEST_KEYS.tailwind,
          originalFileName: SANDBOX_KIT_MANIFEST_KEYS.tailwind,
          source: readFileSync(runtime, 'utf8'),
        });
        tailwind = { url: `${base}${this.getFileName(ref)}` };
        emitted.tailwind = this.getFileName(ref);
      }
      descriptor = {
        version: 1,
        components: docs,
        ...(Object.keys(themeVars).length > 0 ? { theme: { vars: { ...themeVars } } } : {}),
        kit,
        tailwind,
      };
      const ref = this.emitFile({
        type: 'asset',
        name: SANDBOX_KIT_MANIFEST_KEYS.descriptor,
        originalFileName: SANDBOX_KIT_MANIFEST_KEYS.descriptor,
        source: JSON.stringify(descriptor),
      });
      emitted.descriptor = this.getFileName(ref);
    },

    /** The manifest lists the three by their names, whatever Vite's own manifest did with them. */
    writeBundle() {
      if (config?.command !== 'build' || config.build.manifest === false) return;
      const manifestPath = join(
        resolve(config.root, config.build.outDir),
        typeof config.build.manifest === 'string' ? config.build.manifest : '.vite/manifest.json',
      );
      if (!existsSync(manifestPath)) return;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      for (const [key, file] of Object.entries(emitted) as [
        keyof typeof emitted,
        string | undefined,
      ][]) {
        if (file === undefined) continue;
        const name = SANDBOX_KIT_MANIFEST_KEYS[key];
        manifest[name] = { file, src: name };
      }
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    },
  };
  const emitted: { kit?: string; tailwind?: string; descriptor?: string } = {};
  return plugin as unknown as GenuiSandboxKitPlugin;
}
