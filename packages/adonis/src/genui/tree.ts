import type { Catalog } from './catalog.js';
import { type GenuiIssue, type GenuiValidation, type JsonSchema, validateProps } from './schema.js';

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
 * Lenient about one thing models get wrong: a `children` array sent as a JSON STRING (sometimes
 * with a stray trailing `}`) is parsed back into the array the model plainly meant.
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

  const root = await visit(tree, [], 1);
  return issues.length > 0 || root === undefined
    ? { ok: false, issues: issues.length > 0 ? issues : [{ path: [], message: 'is invalid' }] }
    : { ok: true, value: root };
}

/**
 * The JSON Schema of a tree-mode tool's input: a recursive `{ type, props, children? }` node whose
 * `type` is one of the catalog's model-facing component names. Per-component props are described
 * to the model in the tool description (see `catalogToModelText`) and checked by
 * {@link validateTree}, which keeps this schema small enough for every provider.
 */
export function treeJsonSchema(catalog: Catalog): JsonSchema {
  return {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: catalog.modelComponents().map((component) => component.name),
        description: 'Component name from the catalog',
      },
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

/**
 * The array `text` opens with, ignoring what follows: a model that stringifies `children` tends to
 * carry the enclosing object's `}` along, which `JSON.parse` refuses whole.
 */
function leadingJsonArray(text: string): unknown[] | undefined {
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
          const parsed: unknown = JSON.parse(text.slice(0, index + 1));
          return Array.isArray(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
