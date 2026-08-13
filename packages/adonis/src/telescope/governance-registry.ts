import type { AgentGovernanceQueries } from '../spi/governance-queries.js';

/**
 * The package-internal slot `agent-governance-providers.ts` reads the governance read-model from.
 *
 * The Nest reference resolves `AGENT_GOVERNANCE_QUERIES` from the host's DI container at request
 * time (`ctx.moduleRef.get(...)`) — Nest's module system makes any provider resolvable by any
 * consumer that declares the token. AdonisJS's real IoC container (`@adonisjs/fold`) CAN bind
 * arbitrary values too, but resolving one back out without an unsafe cast requires a
 * `ContainerBindings` module augmentation naming the binding key's type — and that pattern has NO
 * other precedent anywhere in this package: every binding `AgentProvider#boot()` registers today
 * is class-keyed (`ToolRegistry`, `AgentRegistry`, `AgentService`), never an interface-shaped SPI
 * value like `AgentGovernanceQueries`. `governanceQueries` itself stays a boot-time-local variable,
 * used directly to mount the `/agent/governance/*` routes and never otherwise exposed. Introducing
 * a brand-new container-augmentation pattern purely so ONE telescope file can read it would be a
 * bigger footprint than the read is worth — and would need `packages/adonis/src/telescope/*` to
 * gain a hard dependency on `@adonisjs/core`'s container types, which it currently has none of.
 *
 * So this registry is the smaller alternative already precedented one file over: `src/diagnostics.ts`
 * publishes `emit`/`trace` on a `Symbol.for(...)` slot on `globalThis` so `@adonis-agora/agent` can
 * read `@adonis-agora/diagnostics`' capability structurally, without importing it. The same shape,
 * simplified: `providers/agent_provider.ts` (the producer) and this file (the consumer) are compiled
 * into the SAME package, so there's no cross-`node_modules`-copy identity problem for `Symbol.for`
 * to solve — an ordinary module-scoped variable is enough.
 */
let current: AgentGovernanceQueries | undefined;

/**
 * Set by `AgentProvider#boot()` once `config.governanceQueries` resolves (or back to `undefined`
 * when governance is disabled). Internal wiring only — not re-exported from `src/index.ts` or
 * `src/telescope/index.ts`'s public surface, only imported directly by the two files that need it.
 */
export function setTelescopeGovernanceQueries(queries: AgentGovernanceQueries | undefined): void {
  current = queries;
}

/**
 * Read by the governance-backed telescope providers. `undefined` before `AgentProvider#boot()` has
 * run, or when the host has `governanceQueries: false` / never installed a store that defaults one —
 * every provider in `agent-governance-providers.ts` degrades to an empty-but-valid shape in that case,
 * mirroring the Nest reference's "host hasn't bound the token" degrade path.
 */
export function getTelescopeGovernanceQueries(): AgentGovernanceQueries | undefined {
  return current;
}
