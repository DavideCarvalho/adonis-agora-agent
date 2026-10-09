/**
 * Framework-independent GenUI owned by the Adonis agent: schemas, catalogs, presentations,
 * renderers and UI tools. The same local definitions can be imported by browser code.
 */

import { assertGenuiChannels, type GenuiChannels } from './channels.js';
import { type GenuiFactory, type GenuiFactoryContext } from './factory.js';
import type { SandboxKitDiscovery } from './kit/discover.js';
import {
  type Catalog,
  defineCatalog,
  type GenuiCatalogScope,
  type GenuiToolsOptions,
  genuiTools,
} from './public.js';
import { type DefineSandboxOptions, defineSandbox } from './sandbox.js';
import type { SandboxClientConfig } from './sandbox-kit.js';

export {
  AgentGenui,
  type GenuiFactory,
  type GenuiFactoryContext,
  type GenuiSetup,
} from './factory.js';
export * from './public.js';

/**
 * Picks the catalog for ONE request — a tenant's own components, a plan's versions. Extend it and
 * pass the class as `resolver`: the provider builds it through the container, so it can `@inject()`
 * whatever it reads (a model, a service).
 */
export abstract class GenuiCatalogResolver {
  abstract resolve(scope: GenuiCatalogScope): Catalog | Promise<Catalog>;
}

type ResolverOption =
  | GenuiCatalogResolver
  | (abstract new (
      ...args: never[]
    ) => GenuiCatalogResolver)
  | ((scope: GenuiCatalogScope) => Catalog | Promise<Catalog>);

/** `genui({ … })` — everything `genuiTools` takes, plus the catalog and an optional resolver. */
export interface GenuiOptions extends Omit<GenuiToolsOptions, 'resolveCatalog'> {
  /** The boot-time catalog: names the per-component tools, and serves every request without a resolver. */
  catalog?: Catalog;
  /**
   * The catalog for each request: a {@link GenuiCatalogResolver} (instance or class — a class is built
   * through the container) or a plain `(scope) => catalog`. With one, calls validate against the
   * resolved catalog and each turn's tool descriptions come from it (`ToolHandler.describe`).
   */
  resolver?: ResolverOption;
  /**
   * Add the sandbox component (`Sandbox`): the model may write HTML, CSS and JS for a one-off
   * interactive answer when no catalog component fits. `true` for the defaults (no network), or
   * the {@link DefineSandboxOptions} (a policy listing origins, extra instructions). Off by default.
   * The browser's catalog should carry the same definition (`defineSandbox(...)` in the shared
   * catalog file) so the renderer enforces the same policy.
   */
  sandbox?: boolean | DefineSandboxOptions;
}

/** What every configured sandbox (top level and channels) needs from the browser, together. */
function mergeSandboxClients(clients: Array<() => SandboxClientConfig>): SandboxClientConfig {
  const merged: SandboxClientConfig = { theme: false };
  for (const client of clients) {
    const one = client();
    merged.theme ||= one.theme;
    if (one.tailwind !== undefined) merged.tailwind ??= one.tailwind;
    if (one.kit !== undefined) merged.kit ??= one.kit;
  }
  return merged;
}

function isResolverClass(
  value: ResolverOption,
): value is abstract new (
  ...args: never[]
) => GenuiCatalogResolver {
  return typeof value === 'function' && value.prototype instanceof GenuiCatalogResolver;
}

async function resolveCatalogFn(
  resolver: ResolverOption | undefined,
  ctx: GenuiFactoryContext,
): Promise<GenuiToolsOptions['resolveCatalog']> {
  if (resolver === undefined) return undefined;
  if (resolver instanceof GenuiCatalogResolver) return (scope) => resolver.resolve(scope);
  if (isResolverClass(resolver)) {
    const instance = await ctx.make(resolver);
    return (scope) => instance.resolve(scope);
  }
  return resolver as (scope: GenuiCatalogScope) => Catalog | Promise<Catalog>;
}

/**
 * Generative UI for `config/agent.ts`:
 *
 * ```ts
 * import { genui } from '@adonis-agora/agent/genui'
 * import { catalog } from '#genui/catalog' // defineCatalog([...]) — shared with the browser
 *
 * export default defineConfig({ model, genui: genui({ catalog }) })
 * ```
 *
 * Registers one `ui__render` tool taking a component tree composed from the catalog (or, with
 * `mode: 'per-component'`, a `ui__show_<component>` tool per model-facing component; and/or the
 * generic `ui__show` with `showTool: true`). Each call validates
 * against the catalog and pushes through `ctx.emitUi`, so it streams as a `ui` frame and is persisted
 * on the message. Tools without `roles` get the config's `defaultRoles`, like every other tool.
 */
export function genui(options: GenuiOptions = {}): GenuiFactory {
  return async (ctx) => {
    const { catalog: given, resolver, sandbox: asked, channels: askedChannels, ...rest } = options;
    assertGenuiChannels(askedChannels);
    const base = given ?? defineCatalog([]);
    // A sandbox's kit, Tailwind and theme names are found through the app's Vite setup.
    const clients: Array<() => SandboxClientConfig> = [];
    let discovery: SandboxKitDiscovery | undefined;
    const resolveSandbox = async (
      value: boolean | DefineSandboxOptions | undefined,
    ): Promise<boolean | DefineSandboxOptions | undefined> => {
      if (value === undefined || value === false) return value;
      // Node-only, and only with a sandbox: kept out of a browser bundle of this module.
      const [{ adonisSandboxKitDiscovery }, { resolveSandboxServer }] = await Promise.all([
        import('./kit/adonis.js'),
        import('./kit/discover.js'),
      ]);
      discovery ??= await adonisSandboxKitDiscovery(ctx.app);
      const resolved = resolveSandboxServer(value, discovery);
      clients.push(resolved.client);
      return resolved.define;
    };
    const sandbox = await resolveSandbox(asked);
    let channels: GenuiChannels | undefined;
    if (askedChannels !== undefined) {
      channels = {};
      for (const [name, entry] of Object.entries(askedChannels)) {
        if (entry === undefined) continue;
        const own = await resolveSandbox(entry.sandbox);
        channels[name] = { ...entry, ...(own !== undefined ? { sandbox: own } : {}) };
      }
    }
    const catalog =
      sandbox === undefined || sandbox === false
        ? base
        : base.extend([defineSandbox(sandbox === true ? {} : sandbox)]);
    const resolveCatalog = await resolveCatalogFn(resolver, ctx);
    const tools = genuiTools(catalog, {
      ...rest,
      ...(channels !== undefined ? { channels } : {}),
      ...(sandbox !== undefined ? { sandbox } : {}),
      ...(resolveCatalog !== undefined ? { resolveCatalog } : {}),
    });
    return {
      catalog,
      ...(resolveCatalog === undefined ? {} : { resolveCatalog }),
      tools,
      ...(channels !== undefined ? { channels } : {}),
      ...(clients.length > 0 ? { sandboxClient: () => mergeSandboxClients(clients) } : {}),
      base: {
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
        ...(options.streaming !== undefined ? { streaming: options.streaming } : {}),
        ...(sandbox !== undefined ? { sandbox } : {}),
      },
    };
  };
}
