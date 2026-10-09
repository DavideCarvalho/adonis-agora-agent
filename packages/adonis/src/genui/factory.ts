/** Framework-independent wiring for the local Adonis GenUI catalog and provider. */
import type { FunctionalTool } from '../ai-tool-ref.js';
import type { Catalog } from './catalog.js';
import type { GenuiChannelBase, GenuiChannels } from './channels.js';
import type { SandboxClientConfig } from './sandbox-kit.js';
import type { GenuiCatalogScope } from './tools.js';

/** What the provider hands a {@link GenuiFactory} at boot. */
export interface GenuiFactoryContext {
  /**
   * Build a class through the app's IoC container (so a catalog resolver can `@inject()` its
   * dependencies). The provider passes `app.container.make`.
   */
  make<T>(klass: abstract new (...args: never[]) => T): Promise<T>;
  /** The Adonis application — where the sandbox kit is looked up (its Vite setup). */
  app?: unknown;
}

/** What a {@link GenuiFactory} produces: the tools to register, and the boot-time catalog. */
export interface GenuiSetup {
  resolveCatalog?: (scope: GenuiCatalogScope) => Catalog | Promise<Catalog>;
  tools: FunctionalTool[];
  /** The boot-time catalog, bound in the container as `AgentGenui`. */
  catalog: Catalog;
  /** `genui({ channels })` — what text channels read to draw natively. */
  channels?: GenuiChannels;
  /** The top-level mode, streaming and sandbox a channel falls back to. */
  base?: GenuiChannelBase;
  /** What the sandbox renderer is told (`GET <agent>/config` → `genui.sandbox`). */
  sandboxClient?: () => SandboxClientConfig;
}

/**
 * `genui` in `config/agent.ts`: a lazy factory, built by `genui({ … })` from
 * `@adonis-agora/agent/genui`, that the provider calls at boot.
 */
export type GenuiFactory = (ctx: GenuiFactoryContext) => Promise<GenuiSetup>;

/**
 * The genui catalog the app booted with, bound in the container: `@inject() constructor(private
 * genui: AgentGenui)` → `this.genui.catalog` (the same object a browser build imports).
 */
export class AgentGenui {
  constructor(
    readonly catalog: Catalog,
    readonly resolveCatalog?: GenuiSetup['resolveCatalog'],
    /** `genui({ channels })`, when configured. */
    readonly channels?: GenuiChannels,
    /** The top-level options a channel falls back to. */
    readonly base: GenuiChannelBase = {},
    /** What the sandbox renderer is told, when a sandbox is configured. */
    readonly sandboxClient?: () => SandboxClientConfig,
  ) {}
}
