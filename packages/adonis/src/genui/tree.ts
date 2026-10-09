import type { Catalog } from './catalog.js';
import {
  type GenuiIssue,
  type GenuiValidation,
  type JsonSchema,
  toJsonSchema,
  validateProps,
} from './schema.js';

/**
 * One node of a composed UI: a catalog component, its props, and — for components declared with
 * `children: true` — nested nodes. The shape json-render calls a "nested element", so a tree
 * converts to a json-render flat spec with {@link treeToFlatSpec}.
 */
export interface GenuiElement {
  type: string;
  props: Record<string, unknown>;
  children?: GenuiElement[];
}

/**
 * The `ui` frame component a tree-mode tool pushes: `{ component: GENUI_TREE_COMPONENT, props: {
 * root } }`. Not a valid component name, so it can never collide with a catalog entry.
 */
export const GENUI_TREE_COMPONENT = 'genui:tree';

/** Props of a {@link GENUI_TREE_COMPONENT} frame. */
export interface GenuiTreeProps {
  root: GenuiElement;
}

export interface TreeLimits {
  /** Deepest nesting accepted. Default 12. */
  maxDepth?: number;
  /** Most nodes accepted in one tree. Default 200. */
  maxNodes?: number;
}

/**
 * Validate a model-composed tree against the catalog: every node's `type` must be a model-facing
 * component, its props must pass that component's schema, and only components declared with
 * `children: true` may have children. Returns the tree with each node's props as its schema
 * produced them (defaults applied by a Standard Schema, for instance).
 *
 * Lenient about one thing models get wrong: a `children` array — or the whole tree — sent as a
 * JSON STRING (sometimes with a stray trailing `}`) is parsed back into what the model plainly meant.
 */
export async function validateTree(
  catalog: Catalog,
  tree: unknown,
  limits: TreeLimits = {},
  phase: 'input' | 'output' = 'output',
): Promise<GenuiValidation<GenuiElement>> {
  const maxDepth = limits.maxDepth ?? 12;
  const maxNodes = limits.maxNodes ?? 200;
  const issues: GenuiIssue[] = [];
  let nodes = 0;

  const visit = async (
    node: unknown,
    path: (string | number)[],
    depth: number,
  ): Promise<GenuiElement | undefined> => {
    nodes += 1;
    if (nodes > maxNodes) {
      if (nodes === maxNodes + 1) {
        issues.push({ path, message: `the tree has more than ${maxNodes} elements` });
      }
      return undefined;
    }
    if (depth > maxDepth) {
      issues.push({ path, message: `the tree is nested deeper than ${maxDepth} levels` });
      return undefined;
    }
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      issues.push({ path, message: 'must be an element object { type, props, children? }' });
      return undefined;
    }
    const element = node as Record<string, unknown>;
    if (typeof element.type !== 'string') {
      issues.push({ path: [...path, 'type'], message: 'must be a component name' });
      return undefined;
    }
    const definition = catalog.get(element.type);
    if (definition === undefined || definition.internal === true) {
      issues.push({
        path: [...path, 'type'],
        message: `unknown component "${element.type}" (allowed: ${catalog
          .modelComponents()
          .map((component) => component.name)
          .join(', ')})`,
      });
      return undefined;
    }
    const validated =
      phase === 'input'
        ? ((await validateProps(
            definition.props,
            element.props ?? {},
            catalog.validator,
          )) as GenuiValidation<Record<string, unknown>>)
        : await catalog.validate(element.type, element.props ?? {});
    let props: Record<string, unknown> = {};
    if (!validated.ok) {
      for (const issue of validated.issues) {
        issues.push({ path: [...path, 'props', ...issue.path], message: issue.message });
      }
    } else {
      props = validated.value;
    }
    const rawChildren = parseChildrenIfStringified(element.children);
    if (rawChildren === undefined || rawChildren === null) {
      return { type: element.type, props };
    }
    if (!Array.isArray(rawChildren)) {
      issues.push({
        path: [...path, 'children'],
        message: 'must be an array of elements (a literal array, not a string)',
      });
      return undefined;
    }
    if (rawChildren.length > 0 && definition.children !== true) {
      issues.push({
        path: [...path, 'children'],
        message: `${element.type} does not take children`,
      });
      return undefined;
    }
    const children: GenuiElement[] = [];
    for (const [index, child] of rawChildren.entries()) {
      const next = await visit(child, [...path, 'children', index], depth + 1);
      if (next !== undefined) {
        children.push(next);
      }
    }
    return children.length > 0
      ? { type: element.type, props, children }
      : { type: element.type, props };
  };

  const root = await visit(parseRootIfStringified(tree), [], 1);
  return issues.length > 0 || root === undefined
    ? { ok: false, issues: issues.length > 0 ? issues : [{ path: [], message: 'is invalid' }] }
    : { ok: true, value: root };
}

/**
 * How exactly a tree-mode tool's input is described to the model ({@link treeJsonSchema}):
 *
 * - `'strict'` (default): every node's `props` is its component's own props schema, and `children`
 *   is a discriminated union by `type` over the components — each variant with its exact props, and
 *   `children` only on components that take them (recursive, through `$defs` / `$ref`).
 * - `'loose'`: one `{ type, props: object, children }` node shape — for a provider that refuses
 *   `$ref` in tool parameters. The props are then only described in the tool's text.
 */
export type TreeSchemaMode = 'strict' | 'loose';

/**
 * The JSON Schema of a tree-mode tool's input. Whatever it says, {@link validateTree} remains the
 * check every call goes through: a provider is free to ignore the schema.
 *
 * Strict (the default), it is shaped for what the providers accept in tool parameters:
 *  - the root is a plain `type: 'object'` — OpenAI and Anthropic both refuse a union at the top
 *    level of a tool's parameters — whose `type` lists every component and whose `props` is any of
 *    their props schemas;
 *  - every `children` item is `{ $ref: '#/$defs/node' }`, an `anyOf` of one variant per component
 *    (`type` a one-value `enum`, `props` that component's schema, `children` only where taken,
 *    `additionalProperties: false`);
 *  - a component whose props schema is not self-contained (it carries its own `$ref`, `$defs` or
 *    `definitions`, as a recursive Zod schema does) is described as `{ type: 'object' }`, since its
 *    references would not resolve once embedded; `$schema` is dropped.
 */
export function treeJsonSchema(
  catalog: Catalog,
  options: { schema?: TreeSchemaMode } = {},
): JsonSchema {
  const components = catalog.modelComponents();
  const names = components.map((component) => component.name);
  if (options.schema === 'loose') {
    return {
      type: 'object',
      properties: {
        type: { type: 'string', enum: names, description: 'Component name from the catalog' },
        props: {
          type: 'object',
          description: "The component's props, as the catalog describes them",
        },
        children: {
          type: 'array',
          items: { $ref: '#' },
          description:
            'Nested elements, only for components that take children. A literal JSON array, never a JSON-stringified one.',
        },
      },
      required: ['type', 'props'],
    };
  }
  const defs: Record<string, JsonSchema> = {};
  const childrenSchema: JsonSchema = {
    type: 'array',
    items: { $ref: '#/$defs/node' },
    description: 'Nested elements. A literal JSON array, never a JSON-stringified one.',
  };
  for (const component of components) {
    defs[`props_${component.name}`] = embeddableProps(toJsonSchema(component.props));
    defs[`node_${component.name}`] = {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [component.name] },
        props: { $ref: `#/$defs/props_${component.name}` },
        ...(component.children === true ? { children: childrenSchema } : {}),
      },
      required: ['type', 'props'],
      additionalProperties: false,
    };
  }
  defs.node = {
    anyOf: components.map((component) => ({ $ref: `#/$defs/node_${component.name}` })),
  };
  return {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: names,
        description:
          'Component name from the catalog. A single component (no children) is a valid tree.',
      },
      props: {
        description: "The component's props: the schema of the component named by `type`",
        anyOf: components.map((component) => ({ $ref: `#/$defs/props_${component.name}` })),
      },
      children: {
        ...childrenSchema,
        description:
          'Nested elements, only for components that take children. A literal JSON array, never a JSON-stringified one.',
      },
    },
    required: ['type', 'props'],
    additionalProperties: false,
    $defs: defs,
  };
}

/** A props schema that stands on its own once embedded in the tree's `$defs`, else a plain object. */
function embeddableProps(schema: JsonSchema | undefined): JsonSchema {
  if (schema === undefined || typeof schema !== 'object' || schema === null) {
    return { type: 'object' };
  }
  const references = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(references);
    if (typeof value !== 'object' || value === null) return false;
    return Object.entries(value).some(
      ([key, nested]) =>
        key === '$ref' || key === '$defs' || key === 'definitions' || references(nested),
    );
  };
  if (references(schema)) return { type: 'object' };
  const { $schema: _schema, ...rest } = schema as Record<string, unknown>;
  return rest as JsonSchema;
}

/** A json-render flat spec: `{ root, elements: { [id]: { type, props, children: id[] } } }`. */
export interface FlatSpec {
  root: string;
  elements: Record<string, { type: string; props: Record<string, unknown>; children: string[] }>;
}

/** Convert a tree to a json-render flat spec (ids are `el-0`, `el-1`, … in depth-first order). */
export function treeToFlatSpec(root: GenuiElement): FlatSpec {
  const elements: FlatSpec['elements'] = {};
  let next = 0;
  const visit = (node: GenuiElement): string => {
    const id = `el-${next++}`;
    const entry = { type: node.type, props: node.props, children: [] as string[] };
    elements[id] = entry;
    for (const child of node.children ?? []) {
      entry.children.push(visit(child));
    }
    return id;
  };
  return { root: visit(root), elements };
}

function parseChildrenIfStringified(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return value;
  return leadingJsonArray(trimmed) ?? value;
}

/** A whole tree sent as a JSON string (`"{\"type\": …}"`): the element it spells. */
function parseRootIfStringified(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return value;
  const parsed = leadingJson(trimmed);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : value;
}

/**
 * The array `text` opens with, ignoring what follows: a model that stringifies `children` tends to
 * carry the enclosing object's `}` along, which `JSON.parse` refuses whole.
 */
function leadingJsonArray(text: string): unknown[] | undefined {
  const parsed = leadingJson(text);
  return Array.isArray(parsed) ? parsed : undefined;
}

/** The JSON value (an array or object) `text` opens with, ignoring what follows. */
function leadingJson(text: string): unknown {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(0, index + 1)) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
