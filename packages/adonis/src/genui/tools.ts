import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import type {
  AiToolCtx,
  ToolDescribeScope,
  ToolDescription,
  ToolHandler,
  ToolInputPreview,
  ToolInputPreviewScope,
} from '../spi/tool.js';
import type { ToolPresentation } from '../tool-presentation.js';
import type { Actor, ToolSpec } from '../types.js';
import { negotiateCatalog } from './capabilities.js';
import {
  type Catalog,
  type ComponentDefinition,
  type GenuiStreaming,
  standaloneComponents,
  toolNameFor,
} from './catalog.js';
import { partialTree } from './progressive.js';
import {
  formatIssues,
  type GenuiIssue,
  isStandardSchema,
  type JsonSchema,
  toJsonSchema,
  validateProps,
} from './schema.js';
import { catalogToModelText } from './text.js';
import {
  GENUI_TREE_COMPONENT,
  type GenuiElement,
  type TreeLimits,
  treeJsonSchema,
  validateTree,
} from './tree.js';

/** A lib tool: register it with `aiTool(tool)` (AdonisJS) or `registry.register(tool.spec, tool.handler)`. */
export interface GenuiTool {
  spec: ToolSpec & { terminal?: boolean };
  handler: ToolHandler;
}

/** What a genui tool returns to the model: what was pushed, and the `ui` frame's id. */
export interface GenuiToolOutput {
  shown: string;
  id: string;
}

/**
 * Who a catalog is being resolved for. `tenant` is `actor.tenantRef`. `threadId` is absent only
 * when a tool list is built outside a conversation (the MCP server's `tools/list`).
 */
export interface GenuiCatalogScope {
  actor: Actor;
  threadId?: string;
  tenant?: string;
  agentName?: string;
}

/** Answers which catalog applies to a request — a tenant's own, versioned components. */
export type ResolveGenuiCatalog = (scope: GenuiCatalogScope) => Catalog | Promise<Catalog>;

export interface GenuiToolsOptions {
  /**
   * `per-component` (default): one tool per model-facing component, `ui__show_<snake>`, whose input
   * IS the component's props. Layouts (`children: true`) get none: they can only be composed in a
   * tree. `tree`: a single tool whose input is a nested
   * `{ type, props, children }` tree composed from the catalog (json-render's nested shape).
   */
  mode?: 'per-component' | 'tree';
  /**
   * The model's turn ends once a genui call succeeds — no further model call to narrate what the UI
   * already shows. Stamped as `spec.terminal`.
   */
  terminal?: boolean;
  /** Tool-name prefix for `per-component`. Default `ui__show_`. */
  namePrefix?: string;
  /** Tool name for `tree`. Default `ui__render`. */
  treeToolName?: string;
  /** Extra text prepended to the tree tool's description (when to call it, house rules). */
  treeInstructions?: string;
  /** Size limits for `tree`. */
  treeLimits?: TreeLimits;
  /**
   * Tree mode: whether the layout is drawn WHILE the model writes it.
   *
   * - `'complete'` (default): nothing is drawn until the call has run; then the validated tree
   *   appears whole.
   * - `'partial'`: the server parses the streaming `ui__render` arguments and pushes the tree so far
   *   as `partial` `ui` frames under the id the final push replaces — throttled, unvalidated, never
   *   persisted, never sent to a text channel. Nodes still being written are flagged `incomplete`; a
   *   component declared `streaming: 'complete'` is a `held` placeholder until its subtree closes.
   *
   * A component's own {@link ComponentDefinition.streaming} overrides this per component.
   */
  streaming?: GenuiStreaming;
  /** Least time between two partial tree frames of one call, in ms. Default 100. */
  streamingThrottleMs?: number;
  /**
   * Also offer ONE generic tool taking `{ component, props }`, validated against the (resolved)
   * catalog — how a model reaches components that only exist per request (a tenant's own), which a
   * boot-time tool list cannot name. `true` names it `ui__show`; a string names it.
   */
  showTool?: boolean | string;
  /** Extra text prepended to the show tool's description. */
  showInstructions?: string;
  /** Roles allowed to call the tools (the `ToolSpec.roles` gate). Undefined → the roles policy default. */
  roles?: string[];
  /** Override the generated presentation per component (or for the tree / show tool, under its tool name). */
  presentation?: (component: string) => ToolPresentation | undefined;
  /**
   * The catalog for THIS request, consulted when a call is validated and when the turn's tool list
   * is described to the model. The `catalog` argument is then the boot-time one: it names the
   * per-component tools and is what a list built without a resolver would show. Omit → the
   * `catalog` argument serves every request.
   */
  resolveCatalog?: ResolveGenuiCatalog;
}

/** The default name of the generic show tool ({@link GenuiToolsOptions.showTool}). */
export const GENUI_SHOW_TOOL = 'ui__show';

/**
 * Tools that let a model push catalog components into the conversation as `ui` frames. Each call
 * validates its input against the catalog (a refused call reaches the model as a tool error it can
 * fix) and then pushes through `ctx.emitUi`, which streams the frame live and persists it on the
 * assistant message.
 */
export function genuiTools(catalog: Catalog, options: GenuiToolsOptions = {}): GenuiTool[] {
  const tools =
    options.mode === 'tree'
      ? [treeTool(catalog, options)]
      : standaloneComponents(catalog).map((component) =>
          componentTool(catalog, component, options),
        );
  if (options.showTool !== undefined && options.showTool !== false) {
    tools.push(showTool(catalog, options));
  }
  return tools;
}

function scopeOf(input: {
  actor: Actor;
  threadId?: string;
  agentName?: string;
}): GenuiCatalogScope {
  return {
    actor: input.actor,
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    ...(input.actor.tenantRef !== undefined ? { tenant: input.actor.tenantRef } : {}),
    ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
  };
}

function catalogFor(
  catalog: Catalog,
  options: GenuiToolsOptions,
  scope: GenuiCatalogScope,
): Catalog | Promise<Catalog> {
  return options.resolveCatalog === undefined ? catalog : options.resolveCatalog(scope);
}

function common(options: GenuiToolsOptions): Pick<ToolSpec, 'roles'> & { terminal?: boolean } {
  return {
    ...(options.roles !== undefined ? { roles: options.roles } : {}),
    ...(options.terminal === true ? { terminal: true } : {}),
  };
}

function componentTool(
  catalog: Catalog,
  component: ComponentDefinition<unknown>,
  options: GenuiToolsOptions,
): GenuiTool {
  const presentation = options.presentation?.(component.name) ?? {
    label: component.title,
    running: `Showing ${lowerFirst(component.title)}`,
    done: `Showed ${lowerFirst(component.title)}`,
    result: { kind: 'elsewhere' as const },
  };
  const describeFor = (definition: ComponentDefinition<unknown>) =>
    `Show the user a ${definition.title} (${definition.name}). ${definition.description}`;
  const dynamic = options.resolveCatalog !== undefined;
  // With a resolver the component's schema may differ per request (a tenant's version of it), so
  // the registry lets any object through and `execute` validates against the resolved definition.
  const inputSchema: StandardSchemaV1 = dynamic
    ? permissiveSchema(toJsonSchema(component.props) ?? { type: 'object' })
    : isStandardSchema(component.props)
      ? component.props
      : jsonStandardSchema(component.props, (value) =>
          catalog.validator.validate(component.props as JsonSchema, value),
        );
  const handler: ToolHandler = {
    async execute(input: unknown, ctx: AiToolCtx): Promise<GenuiToolOutput> {
      const resolved = await catalogFor(catalog, options, scopeOf(ctx));
      const definition = modelComponent(resolved, component.name);
      if (definition === undefined) {
        throw new Error(`component "${component.name}" is not available here`);
      }
      // Static handlers receive the registry's parsed output; dynamic handlers parse the
      // request-specific input here. Never run an input transformation on portable output.
      const validated = await validateProps(
        dynamic ? definition.props : (definition.outputProps ?? definition.props),
        input,
        resolved.validator,
      );
      if (!validated.ok) {
        throw new Error(`invalid ${component.name} props: ${formatIssues(validated.issues)}`);
      }
      return push(
        ctx,
        component.name,
        validated.value as Record<string, unknown>,
        definition.version,
      );
    },
  };
  handler.describe = async (scope: ToolDescribeScope): Promise<ToolDescription> => {
    const resolved = negotiateCatalog(
      await catalogFor(catalog, options, scopeOf(scope)),
      scope.uiCapabilities,
    );
    const definition = modelComponent(resolved, component.name);
    if (definition === undefined) {
      return {
        available: false,
        description: `Not available in this conversation — do not call this tool. (${component.name})`,
      };
    }
    return {
      description: describeFor(definition),
      inputSchema: permissiveSchema(toJsonSchema(definition.props) ?? { type: 'object' }),
    };
  };
  return {
    spec: {
      name: toolNameFor(component.name, options.namePrefix),
      kind: 'read',
      description: describeFor(component),
      inputSchema,
      presentation,
      ...common(options),
    },
    handler,
  };
}

function treeTool(catalog: Catalog, options: GenuiToolsOptions): GenuiTool {
  const name = options.treeToolName ?? 'ui__render';
  const presentation = options.presentation?.(name) ?? {
    label: 'Answer',
    running: 'Laying out the answer',
    done: 'Laid out the answer',
    result: { kind: 'elsewhere' as const },
  };
  const describeFor = (resolved: Catalog) =>
    [
      options.treeInstructions ?? 'Render a rich UI to present the answer to the user.',
      catalogToModelText(resolved, { mode: 'tree' }),
    ].join('\n');
  const dynamic = options.resolveCatalog !== undefined;
  const handler: ToolHandler = {
    async execute(input: unknown, ctx: AiToolCtx): Promise<GenuiToolOutput> {
      const resolved = await catalogFor(catalog, options, scopeOf(ctx));
      const result = await validateTree(
        resolved,
        input,
        options.treeLimits,
        dynamic ? 'input' : 'output',
      );
      if (!result.ok) {
        throw new Error(`invalid UI tree: ${formatIssues(result.issues)}`);
      }
      const root: GenuiElement = result.value;
      return push(ctx, GENUI_TREE_COMPONENT, { root });
    },
  };
  handler.describe = async (scope: ToolDescribeScope): Promise<ToolDescription> => {
    const resolved = negotiateCatalog(
      await catalogFor(catalog, options, scopeOf(scope)),
      scope.uiCapabilities,
    );
    return {
      available: resolved.modelComponents().length > 0,
      description: describeFor(resolved),
      inputSchema: permissiveSchema(treeJsonSchema(resolved)),
    };
  };
  handler.previewInput = async (
    scope: ToolInputPreviewScope,
  ): Promise<ToolInputPreview | undefined> => {
    // What THIS client draws: a node it cannot would make the final push degrade to text, so the
    // preview stops there instead of showing a layout the message will not have.
    const resolved = negotiateCatalog(
      await catalogFor(catalog, options, scopeOf(scope)),
      scope.uiCapabilities,
    );
    const streaming = options.streaming ?? 'complete';
    // Nothing streams partial: the tree appears when the call has run, as it always did.
    if (!resolved.modelComponents().some((each) => (each.streaming ?? streaming) === 'partial')) {
      return undefined;
    }
    return {
      ...(options.streamingThrottleMs !== undefined
        ? { throttleMs: options.streamingThrottleMs }
        : {}),
      render(input) {
        const tree = partialTree(resolved, input, {
          streaming,
          ...(options.treeLimits !== undefined ? { limits: options.treeLimits } : {}),
        });
        if (tree === null) return null;
        if (tree.root === null) return undefined;
        return { component: GENUI_TREE_COMPONENT, props: { root: tree.root }, version: 1 };
      },
    };
  };
  return {
    spec: {
      name,
      kind: 'read',
      description: describeFor(catalog),
      inputSchema: dynamic
        ? permissiveSchema(treeJsonSchema(catalog))
        : asyncJsonStandardSchema(treeJsonSchema(catalog), async (value) => {
            const result = await validateTree(catalog, value, options.treeLimits, 'input');
            return result.ok ? { value: result.value } : { issues: result.issues };
          }),
      presentation,
      ...common(options),
    },
    handler,
  };
}

/** The show tool's input: a component name (one of the catalog's) and its props. */
export function showToolJsonSchema(catalog: Catalog): JsonSchema {
  return {
    type: 'object',
    properties: {
      component: {
        type: 'string',
        enum: standaloneComponents(catalog).map((component) => component.name),
        description: 'Component name from the catalog',
      },
      props: {
        type: 'object',
        description: "The component's props, as the catalog describes them",
      },
    },
    required: ['component', 'props'],
  };
}

async function validateShow(
  catalog: Catalog,
  input: unknown,
  phase: 'input' | 'output' = 'input',
): Promise<
  | { ok: true; definition: ComponentDefinition<unknown>; props: Record<string, unknown> }
  | { ok: false; issues: GenuiIssue[] }
> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, issues: [{ path: [], message: 'must be { component, props }' }] };
  }
  const { component, props } = input as { component?: unknown; props?: unknown };
  if (typeof component !== 'string') {
    return { ok: false, issues: [{ path: ['component'], message: 'must be a component name' }] };
  }
  const definition = modelComponent(catalog, component);
  if (definition === undefined || definition.children === true) {
    const allowed = standaloneComponents(catalog)
      .map((each) => each.name)
      .join(', ');
    return {
      ok: false,
      issues: [
        { path: ['component'], message: `unknown component "${component}" (allowed: ${allowed})` },
      ],
    };
  }
  const validated = await validateProps(
    phase === 'input' ? definition.props : (definition.outputProps ?? definition.props),
    props ?? {},
    catalog.validator,
  );
  if (!validated.ok) {
    return {
      ok: false,
      issues: validated.issues.map((issue) => ({ ...issue, path: ['props', ...issue.path] })),
    };
  }
  return { ok: true, definition, props: validated.value as Record<string, unknown> };
}

function showTool(catalog: Catalog, options: GenuiToolsOptions): GenuiTool {
  const name = typeof options.showTool === 'string' ? options.showTool : GENUI_SHOW_TOOL;
  const presentation = options.presentation?.(name) ?? {
    label: 'Show',
    running: 'Preparing a view',
    done: 'Showed a view',
    result: { kind: 'elsewhere' as const },
  };
  const describeFor = (resolved: Catalog) =>
    [
      options.showInstructions ?? 'Show the user one component from the catalog.',
      catalogToModelText(resolved, { mode: 'show' }),
    ].join('\n');
  const dynamic = options.resolveCatalog !== undefined;
  const handler: ToolHandler = {
    async execute(input: unknown, ctx: AiToolCtx): Promise<GenuiToolOutput> {
      const resolved = await catalogFor(catalog, options, scopeOf(ctx));
      const result = await validateShow(resolved, input, dynamic ? 'input' : 'output');
      if (!result.ok) {
        throw new Error(`invalid ${name} call: ${formatIssues(result.issues)}`);
      }
      return push(ctx, result.definition.name, result.props, result.definition.version);
    },
  };
  handler.describe = async (scope: ToolDescribeScope): Promise<ToolDescription> => {
    const resolved = negotiateCatalog(
      await catalogFor(catalog, options, scopeOf(scope)),
      scope.uiCapabilities,
    );
    return {
      available: standaloneComponents(resolved).length > 0,
      description: describeFor(resolved),
      inputSchema: permissiveSchema(showToolJsonSchema(resolved)),
    };
  };
  return {
    spec: {
      name,
      kind: 'read',
      description: describeFor(catalog),
      inputSchema: dynamic
        ? permissiveSchema(showToolJsonSchema(catalog))
        : asyncJsonStandardSchema(showToolJsonSchema(catalog), async (value) => {
            const result = await validateShow(catalog, value);
            return result.ok
              ? { value: { component: result.definition.name, props: result.props } }
              : { issues: result.issues };
          }),
      presentation,
      ...common(options),
    },
    handler,
  };
}

function modelComponent(catalog: Catalog, name: string): ComponentDefinition<unknown> | undefined {
  const definition = catalog.get(name);
  return definition === undefined || definition.internal === true ? undefined : definition;
}

async function push(
  ctx: AiToolCtx,
  component: string,
  props: Record<string, unknown>,
  version?: number,
): Promise<GenuiToolOutput> {
  const { id } = await ctx.emitUi(component, props, version !== undefined ? { version } : {});
  return { shown: component, id };
}

function lowerFirst(text: string): string {
  return text.length > 0 ? `${text[0]?.toLowerCase()}${text.slice(1)}` : text;
}

type JsonStandardSchema = StandardSchemaV1 & StandardJSONSchemaV1;

/**
 * A JSON Schema presented as a Standard Schema WITH the Standard JSON Schema extension, so the lib
 * validates tool input through `~standard.validate` and the AI SDK adapter hands the model the
 * schema itself (it reads `~standard.jsonSchema.input`).
 */
export function jsonStandardSchema(
  schema: JsonSchema,
  validate: (value: unknown) => GenuiIssue[],
): JsonStandardSchema {
  return asyncJsonStandardSchema(schema, (value) => {
    const issues = validate(value);
    return issues.length > 0 ? { issues } : { value };
  });
}

/** Shows the model `schema`, accepts any value: validation happens in `execute`, per request. */
function permissiveSchema(schema: JsonSchema): JsonStandardSchema {
  return asyncJsonStandardSchema(schema, (value) => ({ value }));
}

function asyncJsonStandardSchema(
  schema: JsonSchema,
  validate: (
    value: unknown,
  ) =>
    | { value: unknown; issues?: undefined }
    | { issues: GenuiIssue[] }
    | Promise<{ value: unknown; issues?: undefined } | { issues: GenuiIssue[] }>,
): JsonStandardSchema {
  const toResult = (
    outcome: { value: unknown; issues?: undefined } | { issues: GenuiIssue[] },
  ): StandardSchemaV1.Result<unknown> =>
    outcome.issues !== undefined
      ? {
          issues: outcome.issues.map((issue) => ({ message: issue.message, path: issue.path })),
        }
      : { value: (outcome as { value: unknown }).value };
  return {
    '~standard': {
      version: 1,
      vendor: 'adonis-agora-agent-genui',
      validate(value) {
        const outcome = validate(value);
        return outcome instanceof Promise ? outcome.then(toResult) : toResult(outcome);
      },
      jsonSchema: {
        input: () => schema,
        output: () => schema,
      },
    },
  } as JsonStandardSchema;
}
