import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { AiToolCtx, ToolHandler } from './spi/tool.js';
import type { ToolPresentation } from './tool-presentation.js';
import type { Actor, ToolSpec } from './types.js';

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
  /**
   * What the model calls it. Omit on a class → the class name, camelCased, with a trailing `Tool`
   * dropped (`GetWeatherTool` → `getWeather`). Required on {@link defineTool}, which has no class.
   */
  name?: string;
  /**
   * `read` auto-executes; `action` requires HITL approval. Default `'read'`. (Core's `ToolKind` also
   * has `agent` for delegation, but that kind is synthesized from an agent's `delegatesTo` — never
   * authored here.)
   */
  kind?: 'read' | 'action';
  description: string;
  /**
   * Input schema as a [Standard Schema](https://standardschema.dev) — Zod, Valibot, or ArkType.
   * Validated (again) before the handler runs.
   */
  input: StandardSchemaV1;
  /** Roles allowed to invoke. Omit to inherit the config's `defaultRoles` (unrestricted by default). */
  roles?: string[];
  /**
   * Authz ability checked by an ability-aware `RolesPolicy` (e.g. an `@adonis-agora/authz` Bouncer
   * adapter → `bouncer.forUser(actor).allows(ability)`). Ignored by the default role-based policy.
   */
  ability?: string;
  /**
   * Whether this tool exists in this deployment. `false` — or a predicate returning `false`, which
   * is re-evaluated every turn — drops it before the role filter, so the model is never shown it.
   * Omit → enabled.
   *
   * Use this for availability that is knowable without the container (a constant, `env.get(...)`, a
   * closure over something the app already holds). When the answer lives in an injected service,
   * implement `isEnabled()` on the tool class instead: this object is built at import time and
   * cannot reach the container.
   */
  enabled?: boolean | (() => boolean | Promise<boolean>);
  /**
   * How a chat surface talks about this tool without naming it — sentence templates over the call's
   * input, an icon key, the approval prompt's wording, and how its output reads. Never shown to the
   * model. Served by `GET <path>/tools` to the actors who can reach the tool:
   *
   * ```ts
   * presentation: {
   *   label: 'Cache purge', running: 'Purging {key}', done: 'Purged {key}', icon: 'cache',
   *   tone: 'destructive', confirm: { title: 'Purge {key}?', verb: 'Purge' },
   * }
   * ```
   */
  presentation?: ToolPresentation;
  replacementKey?: ToolSpec['replacementKey'];
  /** A successful call ends the turn — no model call narrates what it already showed. */
  terminal?: boolean;
}

/**
 * The metadata a tool class carries for discovery + registration — from `@AiTool` or `static tool` —
 * with the defaults applied.
 */
export type AiToolMeta = AiToolOptions & { name: string; kind: 'read' | 'action' };

/** `GetWeatherTool` → `getWeather`; `SQLQueryTool` → `sqlQuery`. */
export function toolNameFromClass(className: string): string {
  const base = className.replace(/Tool$/, '') || className;
  const leadingCaps = /^[A-Z]+(?=[A-Z][a-z]|$)/.exec(base)?.[0];
  if (leadingCaps !== undefined && leadingCaps.length > 1) {
    return leadingCaps.toLowerCase() + base.slice(leadingCaps.length);
  }
  return base.charAt(0).toLowerCase() + base.slice(1);
}

/** Apply the `name` / `kind` defaults, the name taken from `className`. */
function resolveMeta(options: AiToolOptions, className: string): AiToolMeta {
  return {
    ...options,
    name: options.name ?? toolNameFromClass(className),
    kind: options.kind ?? 'read',
  };
}

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
      value: resolveMeta(options, (target as { name?: string }).name ?? ''),
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
  if (config && typeof config === 'object' && typeof config.description === 'string') {
    // `kind` may come from the config itself (BaseTool / @AiTool) or from the kind-specific base's static
    // (ReadTool → 'read', ActionTool → 'action'), which keeps it out of the subclass's `static tool`.
    const kind = config.kind ?? (target as { kind?: AiToolOptions['kind'] }).kind;
    return resolveMeta(
      { ...config, ...(kind !== undefined ? { kind } : {}) } as AiToolOptions,
      (target as { name?: string }).name ?? '',
    );
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

/**
 * What {@link defineTool} takes: the `@AiTool` options with a required `name`, plus the per-actor
 * gate a class would implement as a `canUse()` method.
 */
export interface DefineToolOptions extends AiToolOptions {
  name: string;
  /**
   * Whether THIS actor may use the tool, decided per turn — after `enabled` and the `RolesPolicy`,
   * on both the offered list and the invoke. For a decision the app-wide policy cannot express (the
   * actor's plan, an entitlement row, ownership of the record). Omit → the role gate alone decides.
   */
  canUse?: (actor: Actor) => boolean | Promise<boolean>;
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
  options: DefineToolOptions,
  execute: ((input: I, ctx: AiToolCtx) => Promise<O> | O) | ToolHandler<I, O>,
): BrandedFunctionalTool {
  const spec: ToolSpec = {
    name: options.name,
    kind: options.kind ?? 'read',
    description: options.description,
    inputSchema: options.input,
    ...(options.roles !== undefined ? { roles: options.roles } : {}),
    ...(options.ability !== undefined ? { ability: options.ability } : {}),
    ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
    ...(options.presentation !== undefined ? { presentation: options.presentation } : {}),
    ...(options.replacementKey !== undefined ? { replacementKey: options.replacementKey } : {}),
    ...(options.terminal === true ? { terminal: true } : {}),
  };
  const canUse = options.canUse;
  const implementation = typeof execute === 'function' ? undefined : execute;
  return {
    [AGENT_TOOL_BRAND]: true,
    spec,
    handler: {
      ...(implementation?.preflight !== undefined
        ? {
            preflight: (input, ctx, options) => implementation.preflight!(input as I, ctx, options),
          }
        : {}),
      ...(implementation?.isEnabled !== undefined
        ? { isEnabled: () => implementation.isEnabled!() }
        : {}),
      ...(implementation?.describe !== undefined
        ? { describe: (scope) => implementation.describe!(scope) }
        : {}),
      execute: (input, ctx) =>
        Promise.resolve(
          typeof execute === 'function'
            ? execute(input as I, ctx)
            : execute.execute(input as I, ctx),
        ),
      ...(canUse !== undefined || implementation?.canUse !== undefined
        ? {
            canUse: async (actor) =>
              (canUse === undefined || (await canUse(actor))) &&
              (implementation?.canUse === undefined || (await implementation.canUse(actor))),
          }
        : {}),
    },
  };
}
