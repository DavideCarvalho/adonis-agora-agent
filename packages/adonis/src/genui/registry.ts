import type { StandardSchemaV1 } from '@standard-schema/spec';
import { Chart, DataTable } from './builtins.js';
import {
  type Catalog,
  type CatalogOptions,
  type ComponentDefinition,
  defineCatalog,
  defineComponent,
} from './catalog.js';
import { formatIssues, type JsonSchema, validateProps } from './schema.js';
import { componentToText } from './text.js';

/** Plain, durable data. Renderer functions and binary attachments never enter a UI frame. */
export interface ComponentPresentation<P = Record<string, unknown>> {
  component: string;
  props: P;
  version: number;
  fallbackText: string;
}

export interface ComponentFactory<Input, Output = Input> {
  (props: Input): Promise<ComponentPresentation<Output>>;
  readonly definition: ComponentDefinition<Output>;
}

/** Reject values JSON would silently discard/coerce, and detach from caller-owned objects. */
export function snapshotComponentPresentation<T>(value: T): T {
  const seen = new Set<object>();
  const check = (entry: unknown): void => {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return;
    if (typeof entry === 'number' && Number.isFinite(entry)) return;
    if (typeof entry !== 'object' || entry === null)
      throw new TypeError('genui: presentation must contain only JSON values');
    if (seen.has(entry))
      throw new TypeError('genui: presentation must contain acyclic JSON values');
    if (
      !Array.isArray(entry) &&
      Object.getPrototypeOf(entry) !== Object.prototype &&
      Object.getPrototypeOf(entry) !== null
    )
      throw new TypeError('genui: presentation must contain plain JSON objects');
    seen.add(entry);
    for (const item of Object.values(entry)) check(item);
    seen.delete(entry);
  };
  check(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createComponent<S extends StandardSchemaV1>(
  definition: Omit<ComponentDefinition<StandardSchemaV1.InferOutput<S>>, 'props'> & { props: S },
  options?: CatalogOptions,
): ComponentFactory<StandardSchemaV1.InferInput<S>, StandardSchemaV1.InferOutput<S>>;
export function createComponent<P = Record<string, unknown>>(
  definition: ComponentDefinition<P>,
  options?: CatalogOptions,
): ComponentFactory<P>;
export function createComponent<P>(
  definition: ComponentDefinition<P>,
  options: CatalogOptions = {},
): unknown {
  defineComponent(definition);
  const catalog = defineCatalog([definition], options);
  const factory = async (props: unknown): Promise<ComponentPresentation> => {
    const result = await validateProps(definition.props, props, catalog.validator);
    if (!result.ok)
      throw new Error(`genui: invalid ${definition.name} props: ${formatIssues(result.issues)}`);
    const normalized = snapshotComponentPresentation(result.value);
    if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized))
      throw new TypeError('genui: component props must be a JSON object');
    const portable = await catalog.validate(definition.name, normalized);
    if (
      !portable.ok ||
      canonicalJson(snapshotComponentPresentation(portable.value)) !== canonicalJson(normalized)
    ) {
      throw new Error(
        `genui: ${definition.name} requires outputProps accepting stable normalized JSON props`,
      );
    }
    return {
      component: definition.name,
      props: normalized as Record<string, unknown>,
      version: definition.version ?? 1,
      fallbackText: componentToText(
        catalog,
        definition.name,
        normalized as Record<string, unknown>,
      ),
    };
  };
  return Object.assign(factory, { definition });
}

export type ComponentRenderer<P = Record<string, unknown>, Context = unknown> = (
  props: P,
  context?: Context,
) => unknown | Promise<unknown>;

export interface ComponentManifest {
  name: string;
  title: string;
  description: string;
  version: number;
  props?: JsonSchema;
}

export interface ComponentRegistry<Context = unknown> {
  readonly catalog: Catalog;
  readonly manifest: readonly ComponentManifest[];
  register<P>(
    definition: ComponentDefinition<P>,
    renderers: Record<string, ComponentRenderer<P, Context>>,
  ): this;
  /** Revalidate against the app's authoritative definition and regenerate trusted fallback text. */
  prepare(presentation: ComponentPresentation): Promise<ComponentPresentation>;
  render(presentation: ComponentPresentation, channel: string, context?: Context): Promise<unknown>;
}

/** A registry is owned by one app/tenant; registering never mutates a shared singleton. */
export function createComponentRegistry<Context = unknown>(
  options: CatalogOptions = {},
): ComponentRegistry<Context> {
  let catalog = defineCatalog([], options);
  const channels = new Map<string, Record<string, ComponentRenderer<never, Context>>>();
  const registry: ComponentRegistry<Context> = {
    get catalog() {
      return catalog;
    },
    get manifest() {
      return catalog.components.map((definition) => {
        const props = catalog.jsonSchemaFor(definition.name);
        return {
          name: definition.name,
          title: definition.title,
          description: definition.description,
          version: definition.version ?? 1,
          ...(props === undefined ? {} : { props: snapshotComponentPresentation(props) }),
        };
      });
    },
    register(definition, renderers) {
      if (catalog.has(definition.name))
        throw new Error(`genui: component "${definition.name}" is already registered`);
      catalog = catalog.extend([definition]);
      channels.set(definition.name, { ...renderers } as Record<
        string,
        ComponentRenderer<never, Context>
      >);
      return this;
    },
    async prepare(presentation) {
      const definition = catalog.get(presentation.component);
      if (definition === undefined)
        throw new Error(`genui: unknown component "${presentation.component}"`);
      if (presentation.version !== (definition.version ?? 1))
        throw new Error(`genui: component "${presentation.component}" version mismatch`);
      const validated = await catalog.validate(presentation.component, presentation.props);
      if (!validated.ok)
        throw new Error(
          `genui: invalid ${presentation.component} props: ${formatIssues(validated.issues)}`,
        );
      const props = snapshotComponentPresentation(validated.value);
      if (typeof props !== 'object' || props === null || Array.isArray(props))
        throw new TypeError('genui: component props must be a JSON object');
      return {
        component: definition.name,
        props,
        version: definition.version ?? 1,
        fallbackText: componentToText(catalog, definition.name, props),
      };
    },
    async render(presentation, channel, context) {
      const prepared = await this.prepare(presentation);
      const mapping = channels.get(prepared.component);
      const renderer =
        mapping === undefined
          ? undefined
          : Object.hasOwn(mapping, channel)
            ? mapping[channel]
            : Object.hasOwn(mapping, 'text')
              ? mapping.text
              : undefined;
      return renderer === undefined
        ? prepared.fallbackText
        : renderer(prepared.props as never, context);
    },
  };
  return registry;
}

export type TableCell = string | number | boolean | null;
export interface TableProps {
  title?: string;
  columns: {
    key: string;
    label: string;
    align?: 'left' | 'right' | 'center';
    format?: 'text' | 'number' | 'currency' | 'percent' | 'date' | 'link';
  }[];
  rows: Record<string, TableCell>[];
}
export interface ChartProps {
  type: 'bar' | 'line';
  title?: string;
  xKey: string;
  series: { key: string; label?: string }[];
  data: Record<string, TableCell>[];
  unit?: string;
}

export const table = createComponent<TableProps>(DataTable);
export const chart = createComponent<ChartProps>(Chart);

/** Prepare all JSON emissions before any sink receives a partial batch. Factories validate schemas. */
export function validatePresentationBatch(
  presentations: ComponentPresentation<object> | readonly ComponentPresentation<object>[],
): ComponentPresentation[] {
  const batch = Array.isArray(presentations) ? presentations : [presentations];
  return batch.map((item: ComponentPresentation<object>) => {
    const presentation = snapshotComponentPresentation(item);
    if (
      typeof presentation !== 'object' ||
      presentation === null ||
      typeof presentation.component !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(presentation.component) ||
      !Number.isSafeInteger(presentation.version) ||
      presentation.version <= 0 ||
      typeof presentation.fallbackText !== 'string' ||
      typeof presentation.props !== 'object' ||
      presentation.props === null ||
      Array.isArray(presentation.props)
    ) {
      throw new TypeError('genui: invalid component presentation');
    }
    return presentation as ComponentPresentation;
  });
}

/** Object order is immaterial; array order remains part of the portable contract. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
