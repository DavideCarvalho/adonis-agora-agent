/**
 * `@adonis-agora/agent/genui` — generative UI for the Adonis agent.
 *
 * The catalog itself (component definitions, validation, model-facing text, the tools that push `ui`
 * frames) is `@dudousxd/nestjs-agent-core/genui`, re-exported here unchanged: it is isomorphic and
 * framework-free, so ONE catalog file serves this server, a NestJS one, and the browser
 * (`@dudousxd/nestjs-agent-react`'s `GenuiProvider`) — duplicating it would let the three drift.
 * Install `@dudousxd/nestjs-agent-core` (an optional peer) to use this entry.
 *
 * What is Adonis's own is {@link genui}: the `config/agent.ts` factory that turns a catalog into
 * registered tools, with an optional per-request catalog resolver built through the container.
 */
import {
  type Catalog,
  defineCatalog,
  type GenuiCatalogScope,
  type GenuiToolsOptions,
  genuiTools,
} from '@dudousxd/nestjs-agent-core/genui';
import type { FunctionalTool } from '../ai-tool-ref.js';
import type { ToolHandler } from '../spi/tool.js';
import type { ToolSpec } from '../types.js';
import { AgentGenui, type GenuiFactory, type GenuiFactoryContext } from './factory.js';

export * from '@dudousxd/nestjs-agent-core/genui';
export {
  AgentGenui,
  type GenuiFactory,
  type GenuiFactoryContext,
  type GenuiSetup,
} from './factory.js';

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
 * Registers a `ui__show_<component>` tool per model-facing component (or one `ui__render` tree tool
 * with `mode: 'tree'`, and/or the generic `ui__show` with `showTool: true`). Each call validates
 * against the catalog and pushes through `ctx.emitUi`, so it streams as a `ui` frame and is persisted
 * on the message. Tools without `roles` get the config's `defaultRoles`, like every other tool.
 */
export function genui(options: GenuiOptions = {}): GenuiFactory {
  return async (ctx) => {
    const { catalog: given, resolver, ...rest } = options;
    const catalog = given ?? defineCatalog([]);
    const resolveCatalog = await resolveCatalogFn(resolver, ctx);
    const tools = genuiTools(catalog, {
      ...rest,
      ...(resolveCatalog !== undefined ? { resolveCatalog } : {}),
    });
    return {
      catalog,
      // The core's tools are typed against the NestJS core's SPI; the shapes are the same contract
      // (a spec, and a handler whose ctx carries `emitUi`), so they register here as they are.
      tools: tools.map(
        (tool): FunctionalTool => ({
          spec: tool.spec as unknown as ToolSpec,
          handler: tool.handler as unknown as ToolHandler,
        }),
      ),
    };
  };
}
