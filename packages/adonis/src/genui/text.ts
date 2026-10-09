import { type Catalog, standaloneComponents, toolNameFor } from './catalog.js';
import { type JsonSchema, toJsonSchema } from './schema.js';
import { GENUI_TREE_COMPONENT, type GenuiElement } from './tree.js';

/**
 * Plain text (Slack mrkdwn compatible) for a pushed component: its definition's `fallbackText`, or
 * the props as a JSON block when the catalog has no text for it. A `fallbackText` that returns an
 * empty (or blank) string means "nothing to say" — a bare layout like `Stack` — and renders nothing.
 * A tree frame ({@link GENUI_TREE_COMPONENT}) renders node by node, so a layout's children still
 * render. Never throws — a fallback that fails prints the JSON instead.
 */
export function componentToText(
  catalog: Catalog,
  component: string,
  props: Record<string, unknown>,
): string {
  if (component === GENUI_TREE_COMPONENT) {
    const root = props.root as GenuiElement | undefined;
    return root === undefined ? '' : treeToText(catalog, root);
  }
  return nodeText(catalog, component, props) ?? '';
}

/**
 * One component's own text (children aside): its `fallbackText` (`''` when blank — nothing to say),
 * the props as JSON when it has none or it throws, or `undefined` for a layout node without text.
 */
function nodeText(
  catalog: Catalog,
  component: string,
  props: Record<string, unknown>,
): string | undefined {
  const definition = catalog.get(component);
  if (definition?.fallbackText !== undefined) {
    try {
      const text = definition.fallbackText(props);
      if (typeof text === 'string') return text.trim().length > 0 ? text : '';
    } catch {
      /* fall through to the generic rendering */
    }
    return jsonBlock(props);
  }
  return definition?.children === true ? undefined : jsonBlock(props);
}

/** Plain text for a composed tree: each node's text, depth-first, blank-line free. */
export function treeToText(catalog: Catalog, root: GenuiElement): string {
  const out: string[] = [];
  const visit = (node: GenuiElement, depth: number) => {
    if (depth > 32) return;
    const text = nodeText(catalog, node.type, node.props);
    if (text !== undefined) out.push(text);
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(root, 0);
  return out.filter((line) => line.trim().length > 0).join('\n');
}

function jsonBlock(props: Record<string, unknown>): string {
  const title =
    typeof props.title === 'string' && props.title.length > 0 ? `*${props.title}*\n` : '';
  return `${title}\`\`\`\n${JSON.stringify(props, null, 2)}\n\`\`\``;
}

export interface CatalogTextOptions {
  /**
   * `per-component`: each component is its own tool (`ui__show_<snake>`), named in the text.
   * `tree`: one tool takes a nested `{ type, props, children }` tree; the text explains the format.
   * `show`: one tool takes `{ component, props }` (the generic show tool). Default `tree`.
   */
  mode?: 'per-component' | 'tree' | 'show';
  /** Tool-name prefix for `per-component`. Default `ui__show_`. */
  namePrefix?: string;
}

/**
 * The catalog described for a model: one entry per model-facing component with its description and
 * a compact TypeScript-like signature of its props. What a tree-mode (or show) tool puts in its
 * description, and what a host can add to a system prompt.
 */
export function catalogToModelText(catalog: Catalog, options: CatalogTextOptions = {}): string {
  const mode = options.mode ?? 'tree';
  const lines: string[] = [];
  if (mode === 'tree') {
    lines.push(
      'Compose the UI as ONE tree of elements: { "type": <component>, "props": { … }, "children"?: [ … ] }.',
      'Only components marked "takes children" accept children; `children` is a literal JSON array, never a string.',
      'Every element starts with "type", then "props" — a single component is { "type": …, "props": { … } } too, never its props alone. A component\'s own field order (if its description gives one) is the order of the keys INSIDE its "props".',
      ...treeExamples(catalog),
      'Components:',
    );
  } else if (mode === 'show') {
    lines.push('Pass { "component": <name>, "props": { … } } with one of these components:');
  } else {
    lines.push('Components you can show (one tool each):');
  }
  // Outside a tree nothing nests, so a layout (`children: true`) is not offered on its own.
  const components = mode === 'tree' ? catalog.modelComponents() : standaloneComponents(catalog);
  for (const component of components) {
    const schema = toJsonSchema(component.props);
    const head =
      mode === 'per-component'
        ? `- ${component.name} (tool \`${toolNameFor(component.name, options.namePrefix)}\`)`
        : `- ${component.name}`;
    lines.push(`${head}: ${component.description}`);
    if (schema !== undefined) {
      lines.push(`  props: ${summarizeSchema(schema, schema, 0)}`);
    }
    if (mode === 'tree' && component.children === true) {
      lines.push('  takes children');
    }
  }
  return lines.join('\n');
}

/**
 * One or two literal calls built from the catalog's own components — the envelope shown rather
 * than described: a one-component tree, and a layout holding it when the catalog has one.
 */
function treeExamples(catalog: Catalog): string[] {
  const components = catalog.modelComponents();
  const leaves = components.filter(
    (component) => component.children !== true && requiredKeys(component).length > 0,
  );
  // A component drawn while it is written (the sandbox) is the one a model most often sends as
  // bare props — long, written field by field — so it is the one worth showing wrapped.
  const leaf = leaves.find((component) => component.partialProps !== undefined) ?? leaves[0];
  if (leaf === undefined) return [];
  const props = `{ ${requiredKeys(leaf)
    .map((key) => `"${key}": …`)
    .join(', ')} }`;
  const element = `{ "type": "${leaf.name}", "props": ${props} }`;
  const layout = components.find((component) => component.children === true);
  return [
    `Example, one component: ${element}`,
    ...(layout !== undefined
      ? [
          `Example, nested: { "type": "${layout.name}", "props": { … }, "children": [ ${element} ] }`,
        ]
      : []),
  ];
}

function requiredKeys(component: { props: unknown }): string[] {
  const schema = toJsonSchema(component.props as never) as { required?: unknown } | undefined;
  return Array.isArray(schema?.required)
    ? (schema.required as unknown[]).filter((key): key is string => typeof key === 'string')
    : [];
}

/** A JSON Schema as a one-line TypeScript-like type, e.g. `{ title?: string, rows: object[] }`. */
export function summarizeSchema(schema: unknown, root: JsonSchema, depth: number): string {
  if (typeof schema !== 'object' || schema === null) return 'unknown';
  const s = schema as Record<string, unknown>;
  if (depth > 5) return '…';
  if (typeof s.$ref === 'string') {
    return s.$ref === '#' ? 'Self' : (s.$ref.split('/').pop() ?? 'unknown');
  }
  if (Array.isArray(s.enum)) {
    return s.enum.map((option) => JSON.stringify(option)).join(' | ');
  }
  if ('const' in s) return JSON.stringify(s.const);
  const variants = (s.anyOf ?? s.oneOf) as unknown[] | undefined;
  if (Array.isArray(variants)) {
    return variants.map((variant) => summarizeSchema(variant, root, depth + 1)).join(' | ');
  }
  const types = Array.isArray(s.type) ? (s.type as string[]) : s.type !== undefined ? [s.type] : [];
  if (types.length > 1) {
    return types.map((type) => summarizeSchema({ ...s, type }, root, depth + 1)).join(' | ');
  }
  const type = types[0] as string | undefined;
  if (type === 'array') {
    const item = s.items === undefined ? 'unknown' : summarizeSchema(s.items, root, depth + 1);
    return /[|\s]/.test(item) && !item.startsWith('{') ? `(${item})[]` : `${item}[]`;
  }
  if (type === 'object' || (type === undefined && s.properties !== undefined)) {
    const properties = (s.properties ?? {}) as Record<string, unknown>;
    const keys = Object.keys(properties);
    if (keys.length === 0) return 'object';
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    const fields = keys.map((key) => {
      const field = properties[key] as Record<string, unknown> | undefined;
      const note =
        typeof field?.description === 'string' && depth === 0 ? ` /* ${field.description} */` : '';
      return `${key}${required.has(key) ? '' : '?'}: ${summarizeSchema(field, root, depth + 1)}${note}`;
    });
    return `{ ${fields.join(', ')} }`;
  }
  if (type === 'integer') return 'number';
  return type ?? 'unknown';
}

/** Replace `{{path}}` placeholders with prop values (objects as JSON). */
export function fillTemplate(template: string, props: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_match, path: string) => {
    const value = getPath(props, path);
    if (value === null || value === undefined) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

/** Read `a.b[0].c` from a value; `undefined` when any step is missing. */
export function getPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
