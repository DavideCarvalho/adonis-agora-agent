import type { StandardSchemaV1 } from '@standard-schema/spec';
import { filterToolsByRole, personaFilterTools } from './personas.js';
import type { RolesPolicy } from './spi/roles-policy.js';
import type { AiToolCtx, ToolDescribeScope, ToolHandler, ToolPreflightResult } from './spi/tool.js';
import {
  canActorUseTool,
  filterToolsByCanUse,
  filterToolsByEnabled,
  isToolEnabled,
} from './tool-filters.js';
import { createNoopEmitUi } from './tool-ui.js';
import type { Actor, ToolDefinition, ToolSpec } from './types.js';

/** Thrown when an actor invokes a tool their role is not allowed. */
export class ToolForbiddenError extends Error {
  constructor(public readonly toolName: string) {
    super(`Tool "${toolName}" is not allowed for this role`);
    this.name = 'ToolForbiddenError';
  }
}

/**
 * Thrown when a registered tool is invoked while this deployment has it turned off (`enabled` /
 * `isEnabled()`). Distinct from {@link ToolForbiddenError}, which is about the actor, and from
 * {@link ToolNotFoundError}, which is about a name nobody registered — an operator reading a log
 * needs to tell "you flipped the flag" apart from "that tool does not exist in this build".
 *
 * Reachable in normal operation, not just from a forged call: a HITL `action` approved before the
 * flag was turned off runs its tool afterwards.
 */
export class ToolDisabledError extends Error {
  constructor(public readonly toolName: string) {
    super(`Tool "${toolName}" is disabled in this deployment`);
    this.name = 'ToolDisabledError';
  }
}

/** Thrown when a tool is invoked that was never registered. */
export class ToolNotFoundError extends Error {
  constructor(public readonly toolName: string) {
    super(`Tool "${toolName}" is not registered`);
    this.name = 'ToolNotFoundError';
  }
}

/** Thrown when a tool's input fails its Standard Schema validation. */
export class ToolInputInvalidError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly issues: readonly StandardSchemaV1.Issue[],
  ) {
    super(
      `Invalid input for tool "${toolName}": ${issues.map((issue) => issue.message).join('; ')}`,
    );
    this.name = 'ToolInputInvalidError';
  }
}

export class ToolPreflightDeniedError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly reason: string,
  ) {
    super(reason);
    this.name = 'ToolPreflightDeniedError';
  }
}

interface Entry {
  spec: ToolSpec;
  handler: ToolHandler;
}

/**
 * Holds every registered tool and gates invocation.
 *
 * Note: `definitionsFor` returns NEUTRAL definitions (no `execute`). The agent loop runs
 * each tool itself as a (durable) step — so even read tools are not auto-executed by the
 * model. `action` tools additionally require HITL approval before the loop runs them.
 */
export class ToolRegistry {
  private readonly entries = new Map<string, Entry>();

  register(spec: ToolSpec, handler: ToolHandler): void {
    this.entries.set(spec.name, { spec, handler });
  }

  /**
   * Drop a tool, so it is neither offered to the model nor invocable. Returns whether there was one.
   *
   * For a tool whose EXISTENCE is not decided here: an MCP server may stop exporting a tool between
   * one `tools/list` and the next, and leaving the old spec registered would go on offering the
   * model a tool whose next call fails on somebody else's machine. Whoever registered a name is
   * responsible for deciding when it is gone — nothing in the registry itself expires.
   */
  unregister(name: string): boolean {
    return this.entries.delete(name);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  spec(name: string): ToolSpec | undefined {
    return this.entries.get(name)?.spec;
  }

  allSpecs(): ToolSpec[] {
    return [...this.entries.values()].map((entry) => entry.spec);
  }

  /**
   * The tools to offer the model for this actor+agent, after the four filter layers: what this
   * agent pinned, what this deployment has enabled, what this actor's role allows, and what each
   * tool's own `canUse` allows this actor.
   *
   * Every layer only ever removes tools, so no arrangement of them can widen what a turn reaches.
   * The allow-list goes FIRST, even though it is the narrowest statement: it is a pure name-set
   * match, while each of the three below it may be a round trip — an authz service, a feature-flag
   * store, an entitlement table — and this runs once per model step.
   */
  async definitionsFor(
    actor: Actor,
    policy: RolesPolicy,
    allowedTools?: string[],
    scope: Omit<ToolDescribeScope, 'actor'> = {},
  ): Promise<ToolDefinition[]> {
    const visible = await this.visibleEntries(actor, policy, allowedTools);
    return Promise.all(
      visible.map(async ({ spec, handler }) => {
        // After every gate: a tool this actor cannot reach is never asked to describe itself.
        const override =
          handler.describe === undefined ? undefined : await handler.describe({ actor, ...scope });
        return {
          name: spec.name,
          kind: spec.kind,
          description: override?.description ?? spec.description,
          inputSchema: override?.inputSchema ?? spec.inputSchema,
        };
      }),
    );
  }

  /**
   * The specs {@link definitionsFor} offers the model, whole — the same four gates (allow-list,
   * enabled, role, `canUse`) in the same order. For a surface that lists what an actor can reach
   * (`GET <path>/tools`), which must never disagree with what the model is actually shown.
   */
  async visibleSpecs(
    actor: Actor,
    policy: RolesPolicy,
    allowedTools?: string[],
  ): Promise<ToolSpec[]> {
    return (await this.visibleEntries(actor, policy, allowedTools)).map(({ spec }) => spec);
  }

  private async visibleEntries(
    actor: Actor,
    policy: RolesPolicy,
    allowedTools?: string[],
  ): Promise<Entry[]> {
    const pinnedNames = new Set(
      personaFilterTools(this.allSpecs(), allowedTools).map((spec) => spec.name),
    );
    const pinned = [...this.entries.values()].filter((entry) => pinnedNames.has(entry.spec.name));
    const live = await filterToolsByEnabled(pinned);
    const allowedByRole = new Set(
      (
        await filterToolsByRole(
          live.map((entry) => entry.spec),
          actor,
          policy,
        )
      ).map((spec) => spec.name),
    );
    const roleScoped = live.filter((entry) => allowedByRole.has(entry.spec.name));
    return filterToolsByCanUse(roleScoped, actor);
  }

  /**
   * Run a tool. Re-checks that the tool is enabled, that the role allows it and that the tool's own
   * `canUse` admits the actor (defense-in-depth — a call can reach here from a replayed durable step
   * or an approval granted before the flag moved, neither of which went through `definitionsFor`
   * again) and re-parses the input. With `options.allowedTools` (the turn's persona allow-list) a
   * tool off that list is refused last, the same way the offer narrowed it.
   */
  private async validated(
    name: string,
    input: unknown,
    ctx: AiToolCtx,
    policy: RolesPolicy,
    options: InvokeOptions = {},
  ): Promise<{ entry: Entry; value: unknown; ctx: AiToolCtx }> {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      throw new ToolNotFoundError(name);
    }
    if (!(await isToolEnabled(entry.spec, entry.handler))) {
      throw new ToolDisabledError(name);
    }
    if (!(await policy.can(ctx.actor, entry.spec))) {
      throw new ToolForbiddenError(name);
    }
    if (!(await canActorUseTool(ctx.actor, entry.handler))) {
      throw new ToolForbiddenError(name);
    }
    // Last, like the persona filter on the offer: the same layers in the same order, so a call the
    // model was never offered under this persona cannot run because the model named it anyway.
    if (options.allowedTools !== undefined && !options.allowedTools.includes(name)) {
      throw new ToolForbiddenError(name);
    }
    const validation = await entry.spec.inputSchema['~standard'].validate(input);
    if (validation.issues !== undefined) {
      throw new ToolInputInvalidError(name, validation.issues);
    }
    // `emitUi` is part of the context's contract; a caller without a conversation (a test, a script,
    // a JavaScript host) gets the no-op rather than a tool that crashes calling it.
    const withEmit: AiToolCtx =
      typeof ctx.emitUi === 'function' ? ctx : { ...ctx, emitUi: createNoopEmitUi(ctx.requestId) };
    return { entry, value: validation.value, ctx: withEmit };
  }

  async prepare(
    name: string,
    input: unknown,
    ctx: AiToolCtx,
    policy: RolesPolicy,
    options: InvokeOptions = {},
  ): Promise<ToolPreflightResult> {
    const validated = await this.validated(name, input, ctx, policy, options);
    return validated.entry.spec.kind === 'action' && validated.entry.handler.preflight !== undefined
      ? validated.entry.handler.preflight(validated.value, validated.ctx, { phase: 'prepare' })
      : { status: 'ready' };
  }

  async invoke(
    name: string,
    input: unknown,
    ctx: AiToolCtx,
    policy: RolesPolicy,
    options: InvokeOptions = {},
  ): Promise<unknown> {
    const validated = await this.validated(name, input, ctx, policy, options);
    if (validated.entry.spec.kind === 'action' && validated.entry.handler.preflight !== undefined) {
      const result = await validated.entry.handler.preflight(validated.value, validated.ctx, {
        phase: 'execute',
      });
      if (result.status === 'denied') throw new ToolPreflightDeniedError(name, result.reason);
      if (result.status === 'completed') return result.output;
    }
    return validated.entry.handler.execute(validated.value, validated.ctx);
  }
}

/** Per-call narrowing for {@link ToolRegistry.invoke}. */
export interface InvokeOptions {
  /**
   * Only these tool names may run — the turn's persona allow-list. Checked after `enabled`, the roles
   * policy and `canUse`. Undefined → no such check (every caller predating personas).
   */
  allowedTools?: readonly string[];
}

/**
 * Default gate: one of the actor's roles must be in `spec.roles` (else the default roles). An empty
 * list means no restriction — the default: a tool is callable by whoever the actor resolver resolved,
 * an anonymous visitor included. `action` tools still park on approval regardless.
 */
export class DefaultRolesPolicy implements RolesPolicy {
  private readonly emptyRoles: EmptyRoles;

  constructor(
    private readonly defaultRoles: string[] = [],
    options: RolesPolicyOptions = {},
  ) {
    this.emptyRoles = options.emptyRoles ?? 'allow';
  }

  can(actor: Actor, tool: ToolSpec): boolean {
    const allowed = tool.roles ?? this.defaultRoles;
    if (allowed.length === 0) return this.emptyRoles === 'allow';
    return (actor.roles ?? []).some((role) => allowed.includes(role));
  }
}

/**
 * What an empty roles list means to {@link DefaultRolesPolicy}: `'allow'` (the default) — no
 * restriction; `'deny'` — nobody.
 */
export type EmptyRoles = 'allow' | 'deny';

export interface RolesPolicyOptions {
  /** What an empty roles list means. Default `'allow'`. */
  emptyRoles?: EmptyRoles;
}

/**
 * The closed gate — {@link DefaultRolesPolicy} with `emptyRoles: 'deny'`: the actor needs a role the
 * tool declares (else one of the default roles). A tool with no `roles` and no default roles, or with
 * an explicitly empty list, reaches nobody. For apps where an empty list means "no one" — a computed
 * `roles` that can come out empty, a multi-tenant MCP surface.
 */
export class ClosedRolesPolicy extends DefaultRolesPolicy {
  constructor(defaultRoles: string[] = []) {
    super(defaultRoles, { emptyRoles: 'deny' });
  }
}
