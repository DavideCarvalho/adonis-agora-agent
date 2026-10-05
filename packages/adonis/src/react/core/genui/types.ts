import type { ComponentType, ReactNode } from 'react';

/** The `ui` frame component a composed tree is pushed under (`GENUI_TREE_COMPONENT` of `@adonis-agora/agent/genui`). */
export const GENUI_TREE_COMPONENT = 'genui:tree';

/** One pushed component, normalized from whatever carried it (a transcript block, a `data-ui` part, a stored entry). */
export interface GenerativeUIItem {
  fallbackText?: string;
  componentVersions?: Record<string, number>;
  id: string;
  component: string;
  props: Record<string, unknown>;
  version: number | null;
  toolCallId: string | null;
}

/** A node of a composed tree (`genui:tree` frames): `{ type, props, children? }`. */
export interface GenerativeUIElement {
  type: string;
  props: Record<string, unknown>;
  children?: GenerativeUIElement[];
}

/**
 * An app's renderer for one component: it receives the component's props spread, plus `children`
 * when it is a layout node in a tree. Any React component — the library never styles anything.
 */
// biome-ignore lint/suspicious/noExplicitAny: Heterogeneous app components erase props in the shared mapping; explicit P retains each component type and the catalog validates runtime props.
export type GenuiRenderer<P = any> = ComponentType<P & { children?: ReactNode }>;

/** Component name → the app's renderer. */
export type GenuiRegistry = Record<string, GenuiRenderer>;

/**
 * Resolve a component the registry does not have — typically a tenant's own component, fetched for
 * the exact `version` a message was rendered with. Return `null`/`undefined` for "no such
 * component". May be async; results are cached per resolver, name and version.
 */
export type ResolveComponent = (
  name: string,
  version: number | null,
) => GenuiRenderer | null | undefined | Promise<GenuiRenderer | null | undefined>;

export interface GenuiIssueLike {
  path: (string | number)[];
  message: string;
}

type ValidationLike =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issues: GenuiIssueLike[] };

/**
 * What the renderer needs from a catalog to validate props before drawing them. A `Catalog` from
 * `@adonis-agora/agent/genui` satisfies it; declared structurally so any catalog-shaped
 * object does too.
 */
export interface GenuiCatalogLike {
  get?(name: string): { version?: number } | undefined;
  has(name: string): boolean;
  validate(name: string, props: unknown): Promise<ValidationLike>;
  validateSync?(name: string, props: unknown): ValidationLike | undefined;
}

export interface GenerativeUIOptions {
  registry: GenuiRegistry;
  /** Validate props against it before rendering. Components the catalog does not know render unvalidated. */
  catalog?: GenuiCatalogLike;
  resolveComponent?: ResolveComponent;
  /**
   * Draws a composed tree frame (`genui:tree`) whole — e.g. through json-render (see the
   * `/genui/json-render` subpath's `GenuiProvider`). Omitted → trees render node by node through
   * `registry`.
   */
  treeRenderer?: GenuiRenderer<{ root?: GenerativeUIElement }>;
}

/** Why an item did not render. */
export type GenerativeUIProblem =
  | { reason: 'unknown'; item: GenerativeUIItem }
  | { reason: 'invalid'; item: GenerativeUIItem; issues: GenuiIssueLike[] }
  | { reason: 'error'; item: GenerativeUIItem; error: unknown };

export type GenerativeUIState =
  | {
      status: 'ready';
      item: GenerativeUIItem;
      Component: GenuiRenderer;
      props: Record<string, unknown>;
    }
  | { status: 'loading'; item: GenerativeUIItem }
  | ({ status: 'problem' } & GenerativeUIProblem);
