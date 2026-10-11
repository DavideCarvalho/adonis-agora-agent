/**
 * `genuiSandboxKit()` — the Vite plugin that puts the app's design system in the sandbox, whatever
 * its stack, with no command to run by hand:
 *
 * - `styles`: the app's style entries, compiled with Vite's own CSS pipeline (Sass, Less, PostCSS,
 *   CSS modules, Tailwind…), fonts and images inlined — the frame stays network-less. Tailwind is
 *   detected: the frame then runs Tailwind's browser runtime with the app's theme, variants and
 *   utilities; any other CSS is described to the model by its class vocabulary;
 * - `components`: modules exporting React components, bundled with React as one IIFE and documented
 *   from their TypeScript types (names and propTypes in a JavaScript project);
 * - `wrapper`: a module whose default export wraps the model's App (theme providers, baselines);
 * - dev: builds and serves all of it under `/@genui-sandbox-kit/`, writes the descriptor (docs + urls)
 *   for the server, rebuilds when a kit or style file changes and tells open pages (HMR);
 * - build: emits it all as hashed assets plus `genui-sandbox-kit.json`, listed in the Vite manifest.
 *
 * Zero-config: without `styles`, the style entries are found from the app's Vite entrypoints
 * (`build.rollupOptions.input` — where the AdonisJS plugin puts its `entrypoints` — or `index.html`);
 * without `components`, the first `components/ui` folder.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import type { SandboxKitComponentDoc, SandboxKitDescriptor } from '../sandbox-kit.js';
import { themeVarsFromCss } from '../sandbox-theme.js';
import { buildSandboxKitBundle, kitDocsFromBundle, type SandboxKitBundle } from './bundle.js';
import { generateSandboxKitDocs } from './docs.js';
import {
  assertNoLegacyKitOptions,
  resolveSandboxKitFiles,
  type SandboxKitFiles,
  type SandboxKitSourceOptions,
} from './files.js';
import {
  buildSandboxKitStyles,
  discoverStyleEntries,
  purgeSandboxKitStyles,
  readStylesGuide,
  resolveStyleEntries,
  type SandboxKitPurgeOption,
  type SandboxKitStyles,
  STYLE_EXTENSIONS,
  stylesDocs,
  tailwindVitePluginFor,
} from './styles.js';

export interface GenuiSandboxKitOptions extends SandboxKitSourceOptions {
  /**
   * A name, for several kits in one app (variants of the design system, a tenant's own, an A/B
   * test): each `genuiSandboxKit({ name })` builds its own kit, served under
   * `/@genui-sandbox-kit/<name>/`, written to its own descriptor and listed under its own manifest
   * keys ({@link sandboxKitManifestKeys}); the server picks one by that name (`kitName`). Unnamed:
   * the app's one kit.
   */
  name?: string;
  /**
   * The app's style entry files — plain CSS, Sass/Less, PostCSS, CSS modules, a `.scss` importing
   * Bootstrap, a Tailwind v3/v4 stylesheet… — compiled with the app's Vite CSS pipeline and inlined
   * into the frame. Paths or globs relative to the root, or package stylesheets
   * (`bootstrap/dist/css/bootstrap.css`). Default: the stylesheets among the app's Vite entrypoints.
   */
  styles?: string | readonly string[];
  /** Guidance on the styles for the model (a markdown/text file, or the text itself). */
  stylesDocs?: string;
  /** Where the dev descriptor is written, relative to the Vite root. */
  descriptor?: string;
  /** The tsconfig the kit's types are read with. Default: the nearest to the kit. */
  tsconfig?: string;
  /** A TypeScript module with the compiler API, when the project's own has none (TypeScript 7). */
  typescript?: unknown;
  /**
   * Extra Vite plugins for compiling the styles and the components (a CSS-in-JS compiler, a
   * PostCSS-less Tailwind setup…). The app's `@tailwindcss/vite` is added on its own.
   */
  plugins?: unknown[];
  /** Largest font or image a stylesheet's `url()` inlines, in bytes. Default 128 KB; larger ones are left out (warned). */
  inlineAssetLimit?: number;
  /** Most bytes of fonts and images inlined in all. Default 1 MB. */
  inlineAssetBudget?: number;
  /**
   * Take out of the compiled styles what the frame can never use (default on): with Tailwind v4,
   * every utility the kit's own code does not name (the frame's Tailwind runtime generates the
   * ones the model writes; the theme, base and components layers stay); with Tailwind v3, every
   * rule naming a class the kit does not use; with other CSS, generated CSS-modules classes the kit
   * does not use. `false` ships the whole stylesheet; `{ safelist }` keeps more classes (names or
   * patterns) — say, a Tailwind plugin's utilities the model is told about in `stylesDocs`.
   */
  purge?: SandboxKitPurgeOption;
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
  css: 'genui-sandbox-kit.css',
  tailwind: 'genui-sandbox-tailwind.js',
  descriptor: 'genui-sandbox-kit.json',
} as const;
/** The event a page gets (`window`) when the kit was rebuilt in dev. */
export const SANDBOX_KIT_UPDATE_EVENT = 'genui-sandbox-kit:update';

/** The manifest keys a named kit's assets are listed under (`genui-sandbox-kit.<name>.js`…). */
export function sandboxKitManifestKeys(
  name?: string,
): Record<keyof typeof SANDBOX_KIT_MANIFEST_KEYS, string> {
  if (name === undefined) return { ...SANDBOX_KIT_MANIFEST_KEYS };
  const keys = {} as Record<keyof typeof SANDBOX_KIT_MANIFEST_KEYS, string>;
  for (const [key, file] of Object.entries(SANDBOX_KIT_MANIFEST_KEYS) as [
    keyof typeof SANDBOX_KIT_MANIFEST_KEYS,
    string,
  ][])
    keys[key] = file.replace(/(\.[a-z]+)$/, `.${name}$1`);
  return keys;
}

/** A named kit's descriptor path, from the unnamed one's (`genui_sandbox_kit.json` → `genui_sandbox_kit.<name>.json`). */
export function sandboxKitDescriptorPath(path: string, name?: string): string {
  return name === undefined ? path : path.replace(/(\.json)?$/, `.${name}$1`);
}

/** Throws unless a kit name is a plain identifier (it goes into urls and file names). */
export function assertSandboxKitName(name: unknown): asserts name is string | undefined {
  if (name !== undefined && (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)))
    throw new TypeError(
      `genuiSandboxKit: name "${String(name)}" must be letters, digits, "-" or "_" (up to 64)`,
    );
}

/** What the plugin exposes to the server process it runs in (`plugin.api`). */
export interface GenuiSandboxKitApi {
  /** The kit's name (`genuiSandboxKit({ name })`), `undefined` for the unnamed one. */
  readonly kitName?: string | undefined;
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
  css?: Record<string, unknown>;
  publicDir?: string | false;
  plugins?: readonly { name?: string }[];
  build: {
    outDir: string;
    manifest: boolean | string;
    rollupOptions?: { input?: unknown };
    rolldownOptions?: { input?: unknown };
  };
  logger: { info(message: string): void; warn(message: string): void };
}

/** The plugin object: a Vite plugin with the {@link GenuiSandboxKitApi} on `api`. */
export type GenuiSandboxKitPlugin = Plugin & { api: GenuiSandboxKitApi };

/** A stylesheet under node_modules that is a workspace package (a symlink out of node_modules). */
function WORKSPACE_LINKED(path: string): boolean {
  if (!path.includes('/node_modules/')) return false;
  try {
    return !realpathSync(path).includes('/node_modules/');
  } catch {
    return false;
  }
}

/** A file a change to which may change the compiled styles. */
const STYLE_CHANGE = new RegExp(
  `(${STYLE_EXTENSIONS.map((ext) => ext.replace('.', '\\.')).join('|')}|tailwind\\.config\\.[cm]?[jt]s)$`,
  'i',
);

function kib(chars: number): string {
  return `${Math.round(chars / 1024)} KB`;
}

export function createGenuiSandboxKitPlugin(
  options: GenuiSandboxKitOptions,
  defaults: GenuiSandboxKitDefaults,
): GenuiSandboxKitPlugin {
  assertNoLegacyKitOptions(options, 'genuiSandboxKit');
  // Read once: the kit's identity (its urls, files, manifest keys) does not change while it runs.
  const kitName = options.name;
  assertSandboxKitName(kitName);
  const manifestKeys = sandboxKitManifestKeys(kitName);
  let config: ViteLikeConfig | undefined;
  let files: SandboxKitFiles | null = null;
  let bundle: SandboxKitBundle | null = null;
  let styles: SandboxKitStyles | null = null;
  let docs: SandboxKitComponentDoc[] = [];
  const scannedVars: Record<string, string> = {};
  let descriptor: SandboxKitDescriptor | null = null;
  let firstBuild: Promise<void> | undefined;
  let onReady!: () => void;
  const ready = new Promise<void>((resolveReady) => {
    onReady = resolveReady;
  });
  const warned = new Set<string>();
  const warn = (message: string) => {
    if (warned.has(message)) return;
    warned.add(message);
    config?.logger.warn(`[genui-sandbox-kit] ${message}`);
  };

  const devDir = `${SANDBOX_KIT_DEV_PREFIX}${kitName === undefined ? '' : `${kitName}/`}`;
  const devUrl = (name: string, hash?: string) =>
    `${config?.base ?? '/'}${devDir}${name}${hash ? `?v=${hash}` : ''}`;

  /** The descriptor, given where each asset is (`null`: none). */
  const describe = (urls: {
    kit: string | null;
    css: string | null;
    tailwind: string | null;
  }): SandboxKitDescriptor => {
    const vars = styles !== null && Object.keys(styles.vars).length > 0 ? styles.vars : scannedVars;
    const guide = readStylesGuide(config?.root ?? process.cwd(), options.stylesDocs);
    return {
      version: 2,
      components: docs,
      jsx: bundle !== null,
      ...(files?.wrapper !== undefined && bundle !== null ? { wrapper: true } : {}),
      ...(Object.keys(vars).length > 0 ? { theme: { vars: { ...vars } } } : {}),
      ...stylesDocs(styles),
      ...(guide !== undefined ? { guide } : {}),
      assets: {
        kit: bundle !== null && urls.kit !== null ? { url: urls.kit, hash: bundle.hash } : null,
        css:
          styles !== null && styles.css !== '' && urls.css !== null
            ? { url: urls.css, hash: styles.hash }
            : null,
        tailwind:
          styles?.tailwind !== undefined && urls.tailwind !== null
            ? {
                url: urls.tailwind,
                ...(styles.tailwind.directives !== '' ? { css: styles.tailwind.directives } : {}),
              }
            : null,
      },
    };
  };

  const describeDev = () =>
    describe({
      kit: bundle === null ? null : devUrl('kit.js', bundle.hash),
      css: styles === null ? null : devUrl('styles.css', styles.hash),
      tailwind: tailwindRuntimePath() === null ? null : devUrl('tailwind.js'),
    });

  const writeDescriptor = () => {
    if (config === undefined) return;
    descriptor = describeDev();
    const path = resolve(
      config.root,
      options.descriptor ?? sandboxKitDescriptorPath(defaults.descriptor, kitName),
    );
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(descriptor, null, 2)}\n`);
    } catch (error) {
      warn(`could not write ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const styleEntries = (): string[] => {
    if (config === undefined) return [];
    if (options.styles === undefined) {
      return discoverStyleEntries(config.root, {
        input: config.build.rolldownOptions?.input ?? config.build.rollupOptions?.input,
      });
    }
    const found = resolveStyleEntries(config.root, options.styles);
    for (const spec of found.missing) warn(`styles: "${spec}" matched no file`);
    return found.files;
  };

  // One build at a time, each reading the options as they are when it starts: a change that comes
  // while a build runs waits for it, so a slower, older build never lands after a newer one.
  let building: Promise<void> = Promise.resolve();
  const buildAll = (): Promise<void> => {
    const run = building.then(buildOnce);
    building = run.catch(() => {});
    return run;
  };

  const buildOnce = async (): Promise<void> => {
    if (config === undefined) return;
    const root = config.root;
    try {
      files = resolveSandboxKitFiles(root, options);
    } catch (error) {
      warn(error instanceof Error ? error.message : String(error));
      files = null;
    }
    for (const spec of files?.missing ?? []) warn(`components: "${spec}" matched no module`);
    const plugins = [
      ...(options.plugins ?? []),
      ...(await tailwindVitePluginFor(root, config.plugins ?? [], options.plugins ?? [])),
    ];
    const shared = {
      root,
      resolve: config.resolve,
      ...(config.css !== undefined ? { css: config.css } : {}),
      plugins,
      ...(options.inlineAssetLimit !== undefined
        ? { inlineAssetLimit: options.inlineAssetLimit }
        : {}),
      ...(options.inlineAssetBudget !== undefined
        ? { inlineAssetBudget: options.inlineAssetBudget }
        : {}),
      warn,
    };
    const current = files;
    const [builtStyles, built, generated] = await Promise.all([
      buildSandboxKitStyles({
        ...shared,
        entries: styleEntries(),
        ...(config.publicDir !== undefined ? { publicDir: config.publicDir } : {}),
      }).catch((error: unknown) => {
        warn(
          `the styles did not compile: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }),
      current === null
        ? Promise.resolve(null)
        : buildSandboxKitBundle({ ...shared, files: current }).catch((error: unknown) => {
            warn(
              `the kit did not build: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
          }),
      current === null || (current.files.length === 0 && current.packages.length === 0)
        ? Promise.resolve([] as SandboxKitComponentDoc[])
        : generateSandboxKitDocs({
            root,
            files: current,
            ...(options.tsconfig !== undefined ? { tsconfig: options.tsconfig } : {}),
            ...(options.typescript !== undefined ? { typescript: options.typescript } : {}),
          }).catch((error: unknown) => {
            warn(
              `kit docs from names (and propTypes) only: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
          }),
    ]);
    const purge = options.purge ?? true;
    styles =
      builtStyles === null || purge === false
        ? builtStyles
        : purgeSandboxKitStyles(builtStyles, {
            ...(built !== null ? { kitCode: built.code } : {}),
            ...(typeof purge === 'object' && purge.safelist !== undefined
              ? { safelist: purge.safelist }
              : {}),
          });
    if (styles?.purged !== undefined)
      config.logger.info(
        `[genui-sandbox-kit] styles purged: ${kib(styles.purged.before)} → ${kib(styles.css.length)}`,
      );
    bundle = built;
    docs = generated ?? (built === null ? [] : kitDocsFromBundle(built.code));
    if (generated === null && docs.length === 0 && built !== null)
      docs = built.exports.map((name) => ({ name, props: [] }));
  };

  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;

  const plugin = {
    name: 'genui-sandbox-kit',
    enforce: 'pre' as const,
    api: {
      kitName,
      descriptor: () => descriptor,
      ready: () => ready,
    } satisfies GenuiSandboxKitApi,

    configResolved(resolved: ViteLikeConfig) {
      config = resolved;
    },

    transform(code: string, id: string) {
      const path = id.split('?')[0] ?? id;
      // The app's own CSS — workspace packages pnpm injects under node_modules (`file:` deps) too —
      // never a third-party library's.
      const appCss =
        !path.includes('/node_modules/') ||
        /\/node_modules\/\.pnpm\/[^/]*@file\+/.test(path) ||
        WORKSPACE_LINKED(path);
      if (path.endsWith('.css') && appCss) {
        // The theme's variables as the app's CSS declares them — used when there are no styles.
        const found = themeVarsFromCss(code, { rootOnly: true });
        let changed = false;
        for (const [name, value] of Object.entries(found)) {
          if (scannedVars[name] === undefined) {
            scannedVars[name] = value;
            changed = true;
          }
        }
        if (changed && styles === null && config?.command === 'serve' && firstBuild !== undefined)
          writeDescriptor();
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
      const watchAll = () => {
        const paths = [...(files?.dirs ?? []), ...(styles?.files ?? [])];
        if (paths.length > 0) server.watcher.add?.(paths);
      };
      firstBuild = buildAll()
        .catch((error: unknown) => {
          warn(`the kit did not build: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          writeDescriptor();
          watchAll();
          onReady();
        });
      server.middlewares.use((req, res, next) => {
        const url = String(req.url ?? '').split('?')[0] ?? '';
        const prefix = `${config?.base ?? '/'}${devDir}`;
        const rest = url.startsWith(prefix)
          ? url.slice(prefix.length)
          : url.startsWith(`/${devDir}`)
            ? url.slice(devDir.length + 1)
            : undefined;
        // Its own files only: `<prefix>kit.js` — another kit's (`<prefix><name>/kit.js`) is not its.
        if (rest === undefined || rest.includes('/')) return next();
        const name = rest;
        void (async () => {
          await firstBuild;
          let body: string | null = null;
          let type = 'text/javascript; charset=utf-8';
          if (name === 'kit.js') body = bundle?.code ?? null;
          else if (name === 'styles.css') {
            body = styles?.css ?? null;
            type = 'text/css; charset=utf-8';
          } else if (name === 'tailwind.js' && styles?.tailwind !== undefined) {
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
        // Under node_modules only what the kit itself read (an injected workspace package).
        if (
          file.includes('/node_modules/') &&
          styles?.files.includes(file) !== true &&
          bundle?.modules.includes(file) !== true
        )
          return;
        const inKit =
          files?.dirs.some((dir) => file.startsWith(dir)) === true ||
          bundle?.modules.includes(file) === true ||
          files?.wrapper === file;
        const inStyles = styles?.files.includes(file) === true || STYLE_CHANGE.test(file);
        if (!inKit && !inStyles) return;
        clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(() => {
          firstBuild = buildAll()
            .then(() => {
              writeDescriptor();
              watchAll();
              server.ws.send({
                type: 'custom',
                event: SANDBOX_KIT_UPDATE_EVENT,
                data: {
                  ...(kitName !== undefined ? { name: kitName } : {}),
                  hash: bundle?.hash ?? null,
                  url: descriptor?.assets.kit?.url ?? null,
                  css: descriptor?.assets.css?.url ?? null,
                },
              });
              config?.logger.info('[genui-sandbox-kit] kit rebuilt');
            })
            .catch((error: unknown) => {
              warn(
                `the kit did not rebuild: ${error instanceof Error ? error.message : String(error)}`,
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
      const emit = (key: keyof typeof SANDBOX_KIT_MANIFEST_KEYS, source: string): string => {
        const ref = this.emitFile({
          type: 'asset',
          name: manifestKeys[key],
          originalFileName: manifestKeys[key],
          source,
        });
        const fileName = this.getFileName(ref);
        emitted[key] = fileName;
        return `${base}${fileName}`;
      };
      const kitUrl = bundle !== null ? emit('kit', bundle.code) : null;
      const cssUrl = styles !== null && styles.css !== '' ? emit('css', styles.css) : null;
      const runtime = styles?.tailwind !== undefined ? tailwindRuntimePath() : null;
      const tailwindUrl = runtime !== null ? emit('tailwind', readFileSync(runtime, 'utf8')) : null;
      descriptor = describe({ kit: kitUrl, css: cssUrl, tailwind: tailwindUrl });
      emit('descriptor', JSON.stringify(descriptor));
    },

    /** The manifest lists them by their names, whatever Vite's own manifest did with them. */
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
        const name = manifestKeys[key];
        manifest[name] = { file, src: name };
      }
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    },
  };
  const emitted: { kit?: string; css?: string; tailwind?: string; descriptor?: string } = {};
  return plugin as unknown as GenuiSandboxKitPlugin;
}
