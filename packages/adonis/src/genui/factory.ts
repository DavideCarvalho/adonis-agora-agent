/**
 * The framework-free half of the genui wiring: the types `config/agent.ts` holds and the provider
 * calls. Imports nothing from `@dudousxd/nestjs-agent-core`, so the main entry (and `defineConfig`'s
 * types) never needs that optional peer; only `@adonis-agora/agent/genui` does.
 */
import type { FunctionalTool } from '../ai-tool-ref.js';

/** What the provider hands a {@link GenuiFactory} at boot. */
export interface GenuiFactoryContext {
  /**
   * Build a class through the app's IoC container (so a catalog resolver can `@inject()` its
   * dependencies). The provider passes `app.container.make`.
   */
  make<T>(klass: abstract new (...args: never[]) => T): Promise<T>;
}

/** What a {@link GenuiFactory} produces: the tools to register, and the boot-time catalog. */
export interface GenuiSetup {
  tools: FunctionalTool[];
  /** The boot-time catalog, bound in the container as `AgentGenui`. */
  catalog: unknown;
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
  constructor(readonly catalog: unknown) {}
}
