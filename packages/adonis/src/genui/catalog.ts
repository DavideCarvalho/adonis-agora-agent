import {
  builtinJsonSchemaValidator,
  type GenuiValidation,
  type JsonSchema,
  type JsonSchemaValidator,
  type PropsSchema,
  toJsonSchema,
  validateProps,
  validatePropsSync,
} from './schema.js';

/**
 * One component a server may push into a conversation. Data only — how it LOOKS is each app's own
 * renderer, looked up by {@link name}. The same definition serves the model (description + props
 * schema), the server (validation), text-only channels ({@link fallbackText}) and the client
 * (validation before rendering).
 */
export interface ComponentDefinition<P = Record<string, unknown>> {
  /** Registry key, e.g. `DataTable`. What a `ui` frame's `component` names. */
  name: string;
  /** Human label: "Data table". */
  title: string;
  /** Shown to the model: what the component is for and when to use it. */
  description: string;
  /** The props schema: a Standard Schema (Zod, Valibot, ArkType) or a JSON Schema object. */
  props: PropsSchema;
  /** Portable normalized props schema. Required when input transformations are not idempotent. */
  outputProps?: PropsSchema;
  /**
   * The component takes nested elements (a layout: `Stack`, `Card`). Only meaningful in tree mode,
   * where a node's `children` are validated against the catalog too. Outside tree mode such a
   * component has nothing to hold, so it gets no `ui__show_*` tool and the generic show tool does
   * not offer it.
   */
  children?: boolean;
  /**
   * Plain text / Slack mrkdwn rendering of these props, for a channel that cannot draw the
   * component. Absent → {@link componentToText} prints the props as JSON. An empty string renders
   * nothing (a layout with nothing of its own to say); in a tree its children still render.
   */
  fallbackText?(props: P): string;
  /**
   * Pushed by the server (e.g. an approval card), never offered to the model. Excluded from
   * {@link catalogToModelText} and from the tool factories.
   */
  internal?: boolean;
  /**
   * Schema version of {@link props}. Stamped on every `ui` frame the component is pushed with, so a
   * client can keep rendering messages persisted under an older shape.
   */
  version?: number;
}

/** Component names: an identifier a registry key, a tool name and a snake_case slug can all be derived from. */
export const COMPONENT_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/** Declare a component. Validates the name and returns the definition unchanged (typed). */
export function defineComponent<P = Record<string, unknown>>(
  definition: ComponentDefinition<P>,
): ComponentDefinition<P> {
  if (!COMPONENT_NAME.test(definition.name)) {
    throw new Error(
      `genui: component name "${definition.name}" must be letters and digits, starting with a letter (e.g. DataTable)`,
    );
  }
  if (
    definition.version !== undefined &&
    (!Number.isSafeInteger(definition.version) || definition.version <= 0)
  )
    throw new RangeError('genui: component version must be a positive safe integer');
  if (definition.fallbackText !== undefined && typeof definition.fallbackText !== 'function')
    throw new TypeError('genui: fallbackText must be a function');
  return definition;
}

export interface CatalogOptions {
  /** How JSON Schema props are checked. Default: {@link builtinJsonSchemaValidator}; pass `ajvValidator(new Ajv())` for full JSON Schema. */
  jsonSchemaValidator?: JsonSchemaValidator;
}

/** An immutable set of component definitions, looked up by name. */
export interface Catalog {
  readonly components: readonly ComponentDefinition<unknown>[];
  readonly validator: JsonSchemaValidator;
  get(name: string): ComponentDefinition<unknown> | undefined;
  has(name: string): boolean;
  /** The components a model may be offered (every non-`internal` one). */
  modelComponents(): ComponentDefinition<unknown>[];
  /** Validate `props` for `component`. An unknown component is a validation failure, not a throw. */
  validate(component: string, props: unknown): Promise<GenuiValidation<Record<string, unknown>>>;
  /**
   * {@link validate} without waiting — `undefined` only when the component's Standard Schema
   * validates asynchronously. An unknown component is a failure, as in `validate`.
   */
  validateSync(
    component: string,
    props: unknown,
  ): GenuiValidation<Record<string, unknown>> | undefined;
  /** The component's props as JSON Schema, when it can be derived (see {@link toJsonSchema}). */
  jsonSchemaFor(component: string): JsonSchema | undefined;
  /** A new catalog with these components added (a later definition replaces an earlier one of the same name). */
  extend(components: readonly ComponentDefinition<unknown>[]): Catalog;
}

/**
 * Collect component definitions into a {@link Catalog}. Names must be unique; to override a
 * definition (e.g. a builtin), use {@link Catalog.extend}.
 */
export function defineCatalog(
  components: readonly ComponentDefinition<unknown>[],
  options: CatalogOptions = {},
): Catalog {
  const byName = new Map<string, ComponentDefinition<unknown>>();
  for (const component of components) {
    defineComponent(component);
    if (byName.has(component.name)) {
      throw new Error(`genui: component "${component.name}" is defined twice in one catalog`);
    }
    byName.set(component.name, component);
  }
  return buildCatalog(byName, options.jsonSchemaValidator ?? builtinJsonSchemaValidator);
}

function buildCatalog(
  byName: Map<string, ComponentDefinition<unknown>>,
  validator: JsonSchemaValidator,
): Catalog {
  const list = Object.freeze([...byName.values()]);
  return {
    components: list,
    validator,
    get: (name) => byName.get(name),
    has: (name) => byName.has(name),
    modelComponents: () => list.filter((component) => component.internal !== true),
    async validate(component, props) {
      const definition = byName.get(component);
      if (definition === undefined) {
        return {
          ok: false,
          issues: [{ path: [], message: `unknown component "${component}"` }],
        };
      }
      const result = await validateProps(
        definition.outputProps ?? definition.props,
        props,
        validator,
      );
      return result as GenuiValidation<Record<string, unknown>>;
    },
    validateSync(component, props) {
      const definition = byName.get(component);
      if (definition === undefined) {
        return {
          ok: false,
          issues: [{ path: [], message: `unknown component "${component}"` }],
        };
      }
      return validatePropsSync(definition.outputProps ?? definition.props, props, validator) as
        | GenuiValidation<Record<string, unknown>>
        | undefined;
    },
    jsonSchemaFor(component) {
      const definition = byName.get(component);
      return definition === undefined
        ? undefined
        : toJsonSchema(definition.outputProps ?? definition.props);
    },
    extend(more) {
      const next = new Map(byName);
      for (const component of more) {
        defineComponent(component);
        next.set(component.name, component);
      }
      return buildCatalog(next, validator);
    },
  };
}

/**
 * The model components that stand on their own: every one but a layout (`children: true`). Outside
 * tree mode nothing can be nested, so a layout could only be pushed empty — it gets no
 * `ui__show_*` tool and is not offered by the generic show tool.
 */
export function standaloneComponents(catalog: Catalog): ComponentDefinition<unknown>[] {
  return catalog.modelComponents().filter((component) => component.children !== true);
}

/** `DataTable` → `data_table`, `KPICards` → `kpi_cards`. */
export function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase();
}

/** The per-component tool name: `ui__show_data_table` with the default prefix. */
export function toolNameFor(component: string, prefix = 'ui__show_'): string {
  return `${prefix}${toSnakeCase(component)}`;
}
