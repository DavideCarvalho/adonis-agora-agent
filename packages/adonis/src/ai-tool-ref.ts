import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { AiToolCtx, ToolHandler } from './spi/tool.js';
import type { ToolSpec } from './types.js';

/**
 * The symbol the `@AiTool` decorator stamps its options onto (the tool class), read back by
 * discovery to register the class into the {@link import('./tool-registry.js').ToolRegistry}. A
 * global-registry symbol (`Symbol.for`) so it survives duplicate copies of this package in a tree.
 */
export const AI_TOOL_META_KEY: unique symbol = Symbol.for('@agora/agent:ai-tool-meta');

/**
 * Brand stamped on the object {@link defineTool} returns so discovery picks it up when it walks a
 * module's exports — the functional alternative to an `@AiTool` class.
 */
export const AGENT_TOOL_BRAND: unique symbol = Symbol.for('@agora/agent:functional-tool');

export interface AiToolOptions {
  name: string;
  /**
   * `read` auto-executes; `action` requires HITL approval. (Core's `ToolKind` also has `agent` for
   * delegation, but that kind is synthesized from an agent's `delegatesTo` — never authored here.)
   */
  kind: 'read' | 'action';
  description: string;
  /**
   * Input schema as a [Standard Schema](https://standardschema.dev) — Zod, Valibot, or ArkType.
   * Validated (again) before the handler runs.
   */
  input: StandardSchemaV1;
  /** Roles allowed to invoke. Omit to inherit the config's `defaultRoles` (ADMIN-only by default). */
  roles?: string[];
  /**
   * Authz ability checked by an ability-aware `RolesPolicy` (e.g. an `@adonis-agora/authz` Bouncer
   * adapter → `bouncer.forUser(actor).allows(ability)`). Ignored by the default role-based policy.
   */
  ability?: string;
}

/** The metadata a tool class carries for discovery + registration — from `@AiTool` or `static tool`. */
export type AiToolMeta = AiToolOptions;

/** Structural shape of a tool class: a constructor whose instance implements `execute`. */
export type ToolClass = abstract new (...args: never[]) => ToolHandler;

/**
 * Marks a class as an AI tool. The class must implement `execute(input, ctx)`. The provider's
 * `app/agent_tools` discovery (or the generated `hooks/tools` barrel) registers every `@AiTool`
 * class into the shared `ToolRegistry` at boot.
 *
 * ```ts
 * @AiTool({ name: 'getWeather', kind: 'read', description: '...', input: z.object({ city: z.string() }) })
 * export default class GetWeatherTool implements ToolHandler<{ city: string }> {
 *   async execute(input: { city: string }, ctx: AiToolCtx) { return { tempC: 21 } }
 * }
 * ```
 */
export function AiTool(options: AiToolOptions) {
  return <T extends ToolClass>(target: T): T => {
    Object.defineProperty(target, AI_TOOL_META_KEY, {
      value: options,
      enumerable: false,
      configurable: true,
    });
    return target;
  };
}

/** Read the `@AiTool` decorator's stamped {@link AI_TOOL_META_KEY} metadata off a value, if present. */
function decoratorMeta(target: unknown): AiToolMeta | undefined {
  if (target === null || (typeof target !== 'function' && typeof target !== 'object')) {
    return undefined;
  }
  return (target as { [AI_TOOL_META_KEY]?: AiToolMeta })[AI_TOOL_META_KEY];
}

/** Read a class's tool metadata off its `static tool = { name, kind, … }` config, if any. */
function staticToolMeta(target: unknown): AiToolMeta | undefined {
  if (typeof target !== 'function') return undefined;
  const config = (target as { tool?: Partial<AiToolOptions> }).tool;
  if (config && typeof config === 'object' && typeof config.name === 'string') {
    // `kind` may come from the config itself (BaseTool / @AiTool) or from the kind-specific base's static
    // (ReadTool → 'read', ActionTool → 'action'), which keeps it out of the subclass's `static tool`.
    const kind = config.kind ?? (target as { kind?: AiToolOptions['kind'] }).kind;
    return { ...config, kind } as AiToolMeta;
  }
  return undefined;
}

/** Resolve either authoring mechanism — `@AiTool` decorator or `static tool` — from one value. */
function metaOn(target: unknown): AiToolMeta | undefined {
  return decoratorMeta(target) ?? staticToolMeta(target);
}

/**
 * Read a tool class's {@link AiToolMeta}. Two authoring forms are supported:
 *
 * 1. The `@AiTool({ … })` decorator (stamps {@link AI_TOOL_META_KEY}).
 * 2. A decorator-free `static tool = { name, kind, description, input, … }` config on the class — the
 *    same shape, mirroring `@adonis-agora/durable`'s `static workflow`. Preferred where you'd rather
 *    not rely on decorators.
 *
 * Accepts either the class itself or an instance: each mechanism is tried on the value, then on its
 * constructor (so an instance resolves the class's metadata).
 */
export function readAiToolMeta(target: unknown): AiToolMeta | undefined {
  if (target === null || (typeof target !== 'function' && typeof target !== 'object')) {
    return undefined;
  }
  const ctor = (target as { constructor?: unknown }).constructor;
  return metaOn(target) ?? metaOn(ctor);
}

/** A tool expressed as data + handler (from {@link defineTool}), not an `@AiTool` class. */
export interface FunctionalTool {
  spec: ToolSpec;
  handler: ToolHandler;
}

/** A {@link FunctionalTool} carrying {@link AGENT_TOOL_BRAND} — what {@link defineTool} returns. */
export interface BrandedFunctionalTool extends FunctionalTool {
  readonly [AGENT_TOOL_BRAND]: true;
}

/** Narrows an arbitrary module export to a branded functional tool for boot-time registration. */
export function isBrandedFunctionalTool(value: unknown): value is BrandedFunctionalTool {
  return (
    typeof value === 'object' &&
    value !== null &&
    AGENT_TOOL_BRAND in value &&
    'spec' in value &&
    'handler' in value
  );
}

/**
 * The functional form of a tool: pass the same options as `@AiTool` plus an `execute` function, get
 * back a branded `{ spec, handler }` that discovery auto-registers. Export it from an `app/agent_tools`
 * module (or pass it to `defineConfig({ tools })`).
 *
 * ```ts
 * export const purgeCache = defineTool(
 *   { name: 'purgeCache', kind: 'action', description: '...', input: z.object({ key: z.string() }) },
 *   async ({ key }, ctx) => { ... },
 * )
 * ```
 */
export function defineTool<I = unknown, O = unknown>(
  options: AiToolOptions,
  execute: (input: I, ctx: AiToolCtx) => Promise<O> | O,
): BrandedFunctionalTool {
  const spec: ToolSpec = {
    name: options.name,
    kind: options.kind,
    description: options.description,
    inputSchema: options.input,
    ...(options.roles !== undefined ? { roles: options.roles } : {}),
    ...(options.ability !== undefined ? { ability: options.ability } : {}),
  };
  return {
    [AGENT_TOOL_BRAND]: true,
    spec,
    handler: { execute: (input, ctx) => Promise.resolve(execute(input as I, ctx)) },
  };
}
