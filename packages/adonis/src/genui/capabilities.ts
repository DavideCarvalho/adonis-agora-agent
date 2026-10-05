import { type Catalog, COMPONENT_NAME, defineCatalog } from './catalog.js';
import { formatIssues } from './schema.js';
import { componentToText, treeToText } from './text.js';
import { GENUI_TREE_COMPONENT, type GenuiElement, validateTree } from './tree.js';

/** Renderer support only. Component definitions and authorization remain server-owned. */
export interface UiCapabilities {
  components: Array<{ name: string; version: number }>;
}

export function validateUiCapabilities(value: unknown): UiCapabilities {
  if (
    !record(value) ||
    Object.keys(value).some((key) => key !== 'components') ||
    !Array.isArray(value.components)
  )
    throw new TypeError('Invalid UI capabilities');
  const seen = new Set<string>();
  const components = value.components.map((component: unknown) => {
    if (
      !record(component) ||
      Object.keys(component).some((key) => key !== 'name' && key !== 'version') ||
      typeof component.name !== 'string' ||
      !COMPONENT_NAME.test(component.name) ||
      !Number.isSafeInteger(component.version) ||
      Number(component.version) <= 0 ||
      seen.has(component.name)
    )
      throw new TypeError('Invalid UI component capability');
    seen.add(component.name);
    return { name: component.name, version: Number(component.version) };
  });
  return { components };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function negotiateCatalog(catalog: Catalog, capabilities?: UiCapabilities): Catalog {
  if (capabilities === undefined) return catalog;
  const supported = validateUiCapabilities(capabilities).components;
  return defineCatalog(
    catalog.components.filter((component) =>
      supported.some(
        (entry) => entry.name === component.name && entry.version === (component.version ?? 1),
      ),
    ),
    { jsonSchemaValidator: catalog.validator },
  );
}

export type PreparedUiEmission =
  | {
      kind: 'ui';
      component: string;
      props: Record<string, unknown>;
      version: number;
      fallbackText: string;
      componentVersions?: Record<string, number>;
    }
  | { kind: 'text'; text: string };

/** Validate against current trusted definitions before drawing or generating complete text. */
export async function prepareUiEmission(
  catalog: Catalog,
  capabilities: UiCapabilities | undefined,
  component: string,
  props: Record<string, unknown>,
  version?: number,
): Promise<PreparedUiEmission> {
  const drawable = negotiateCatalog(catalog, capabilities);
  if (component === GENUI_TREE_COMPONENT) {
    if (version !== undefined && version !== 1) throw new Error('Invalid UI tree version');
    const validated = await validateTree(catalog, props.root);
    if (!validated.ok) throw new Error(`Invalid UI tree: ${formatIssues(validated.issues)}`);
    const supported = (node: GenuiElement): boolean =>
      drawable.has(node.type) && (node.children ?? []).every(supported);
    const versions = new Map<string, number>();
    const collectVersions = (node: GenuiElement): void => {
      versions.set(node.type, catalog.get(node.type)?.version ?? 1);
      for (const child of node.children ?? []) collectVersions(child);
    };
    collectVersions(validated.value);
    return supported(validated.value)
      ? {
          kind: 'ui',
          component,
          props: { root: validated.value },
          version: 1,
          fallbackText: treeToText(catalog, validated.value),
          componentVersions: Object.fromEntries(versions),
        }
      : { kind: 'text', text: treeToText(catalog, validated.value) };
  }
  const definition = catalog.get(component);
  if (definition === undefined) throw new Error(`Unknown UI component "${component}"`);
  const currentVersion = definition.version ?? 1;
  if (version !== undefined && version !== currentVersion)
    throw new Error(`Invalid UI component version for "${component}"`);
  const validated = await catalog.validate(component, props);
  if (!validated.ok) throw new Error(`Invalid UI props: ${formatIssues(validated.issues)}`);
  return drawable.has(component)
    ? {
        kind: 'ui',
        component,
        props: validated.value,
        version: currentVersion,
        fallbackText: componentToText(catalog, component, validated.value),
      }
    : { kind: 'text', text: componentToText(catalog, component, validated.value) };
}
