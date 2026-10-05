import { type ComponentType, createElement, type ReactNode } from 'react';
import {
  type CatalogOptions,
  type ComponentDefinition,
  type ComponentPresentation,
  createComponentRegistry,
} from '../../../genui/index.js';
import type { GenuiRegistry } from './types.js';

export interface ReactComponentRenderers<P extends object> {
  react?: ComponentType<P>;
  text?: (props: P) => string | Promise<string>;
  /** Return each page's complete props. Each page is validated again before SSR. */
  paginate?: (props: P, rowsPerPage: number) => readonly P[] | Promise<readonly P[]>;
}

/** App-scoped registry shared by GenuiProvider and static server rendering. */
export function createReactComponentRegistry(options?: CatalogOptions) {
  const registry = createComponentRegistry(options);
  const components: GenuiRegistry = Object.create(null);
  const texts = new Map<string, (props: Record<string, unknown>) => string | Promise<string>>();
  const paginators = new Map<
    string,
    (props: Record<string, unknown>, size: number) => Promise<readonly Record<string, unknown>[]>
  >();
  const adapter = {
    get catalog() {
      return registry.catalog;
    },
    get manifest() {
      return registry.manifest;
    },
    get components(): GenuiRegistry {
      return { ...components };
    },
    prepare: (presentation: ComponentPresentation<object>) =>
      registry.prepare({ ...presentation, props: presentation.props as Record<string, unknown> }),
    render: (presentation: ComponentPresentation<object>, channel: string) =>
      registry.render(
        { ...presentation, props: presentation.props as Record<string, unknown> },
        channel,
      ),
    register<P extends object>(
      definition: ComponentDefinition<P>,
      renderers: ReactComponentRenderers<P>,
    ) {
      const ReactComponent = renderers.react;
      registry.register(definition, {
        ...(ReactComponent ? { react: (props: P) => createElement(ReactComponent, props) } : {}),
        ...(renderers.text ? { text: renderers.text } : {}),
      });
      if (renderers.react) components[definition.name] = renderers.react;
      if (renderers.text) {
        const text = renderers.text;
        texts.set(definition.name, (props) => text(props as P));
      }
      if (renderers.paginate) {
        const paginate = renderers.paginate;
        paginators.set(
          definition.name,
          async (props, size) =>
            (await paginate(props as P, size)) as readonly Record<string, unknown>[],
        );
      }
      return adapter;
    },
    async renderPages(
      presentation: ComponentPresentation<object>,
      size: number,
    ): Promise<ReactNode[]> {
      const pages = await adapter.paginate(presentation, size);
      return Promise.all(
        pages.map(async (page) => {
          const ReactComponent = components[page.component];
          if (ReactComponent) return createElement(ReactComponent, page.props);
          return texts.get(page.component)?.(page.props) ?? page.fallbackText;
        }),
      );
    },
    async paginate(
      presentation: ComponentPresentation<object>,
      size: number,
    ): Promise<ComponentPresentation[]> {
      if (!Number.isInteger(size) || size < 1 || size > 500)
        throw new RangeError('genui: rowsPerPage must be 1–500');
      const prepared = await registry.prepare({
        ...presentation,
        props: presentation.props as Record<string, unknown>,
      });
      const custom = paginators.get(prepared.component);
      const rows = prepared.props.rows;
      const pages = custom
        ? await custom(prepared.props, size)
        : prepared.component === 'DataTable' && Array.isArray(rows) && rows.length > size
          ? Array.from({ length: Math.ceil(rows.length / size) }, (_, index) => ({
              ...prepared.props,
              rows: rows.slice(index * size, (index + 1) * size),
            }))
          : [prepared.props];
      if (!pages.length || pages.length > 100)
        throw new RangeError('genui: capture requires 1–100 pages');
      return Promise.all(pages.map((props) => registry.prepare({ ...prepared, props })));
    },
  };
  return adapter;
}
export type ReactComponentRegistry = ReturnType<typeof createReactComponentRegistry>;
