import type { StandardSchemaV1 } from '@standard-schema/spec';
import { filterToolsByRole, personaFilterTools } from './personas.js';
import type { RolesPolicy } from './spi/roles-policy.js';
import type { AiToolCtx, ToolHandler } from './spi/tool.js';
import type { Actor, ToolDefinition, ToolSpec } from './types.js';

/** Thrown when an actor invokes a tool their role is not allowed. */
export class ToolForbiddenError extends Error {
  constructor(public readonly toolName: string) {
    super(`Tool "${toolName}" is not allowed for this role`);
    this.name = 'ToolForbiddenError';
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

  /** The tools to offer the model for this actor+persona, after the two filter layers. */
  async definitionsFor(
    actor: Actor,
    policy: RolesPolicy,
    allowedTools?: string[],
  ): Promise<ToolDefinition[]> {
    const roleScoped = await filterToolsByRole(this.allSpecs(), actor, policy);
    const personaScoped = personaFilterTools(roleScoped, allowedTools);
    return personaScoped.map((spec) => ({
      name: spec.name,
      kind: spec.kind,
      description: spec.description,
      inputSchema: spec.inputSchema,
    }));
  }

  /** Run a tool. Re-checks the role (defense-in-depth) and re-parses the input via Zod. */
  async invoke(
    name: string,
    input: unknown,
    ctx: AiToolCtx,
    policy: RolesPolicy,
  ): Promise<unknown> {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      throw new ToolNotFoundError(name);
    }
    if (!(await policy.can(ctx.actor, entry.spec))) {
      throw new ToolForbiddenError(name);
    }
    const validation = await entry.spec.inputSchema['~standard'].validate(input);
    if (validation.issues !== undefined) {
      throw new ToolInputInvalidError(name, validation.issues);
    }
    return entry.handler.execute(validation.value, ctx);
  }
}

/** Default gate: one of the actor's roles must be in spec.roles (defaulting to ADMIN-only). */
export class DefaultRolesPolicy implements RolesPolicy {
  constructor(private readonly defaultRoles: string[] = ['ADMIN']) {}

  can(actor: Actor, tool: ToolSpec): boolean {
    const allowed = tool.roles ?? this.defaultRoles;
    return (actor.roles ?? []).some((role) => allowed.includes(role));
  }
}
