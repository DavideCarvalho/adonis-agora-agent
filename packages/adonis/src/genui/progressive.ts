import type { PartialToolInput } from '../spi/tool.js';
import type { Catalog, GenuiStreaming } from './catalog.js';
import { validatePropsSync } from './schema.js';
import type { TreeLimits } from './tree.js';

/**
 * One node of a tree the model is still writing — what a partial `genui:tree` frame carries.
 *
 * `id` is the node's position: `root`, then `<parent id>.<index>` (`root.1.0`). It never changes as
 * the tree grows (a model only ever appends), and the final tree's nodes are addressed by the same
 * rule, so a renderer keyed on it keeps every node mounted from the first preview to the final frame.
 */
export interface GenuiPartialElement {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children?: GenuiPartialElement[];
  /** The model has not finished writing this node: its props (or children) may still grow. */
  incomplete?: true;
  /**
   * The node's component streams `complete`: its props and children are held back until its whole
   * subtree has arrived (`props` is `{}`). Draw a placeholder, never the component.
   */
  held?: true;
}

/** The id of the child at `index` of the node `parentId` (the root is `root`). */
export function treeNodeId(parentId: string, index: number): string {
  return `${parentId}.${index}`;
}

export interface PartialTreeOptions {
  /** How a component without its own `streaming` appears. Default `'complete'`. */
  streaming?: GenuiStreaming;
  limits?: TreeLimits;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The part of a streaming `ui__render` input worth drawing: every node whose `type` has fully
 * arrived and names a component of `catalog` (the negotiated one: what this client draws), with its
 * props so far — unvalidated, and flagged `incomplete` while still open. A node whose component
 * streams `complete` is a `held` placeholder until it closes.
 *
 * `{ root: null }` while nothing is drawable yet. `null` when the input can no longer become a tree
 * this client draws (an unknown or undrawable component, children where none are taken, past the
 * size limits): the preview stops there, and the final push decides what is shown.
 */
export function partialTree(
  catalog: Catalog,
  input: PartialToolInput,
  options: PartialTreeOptions = {},
): { root: GenuiPartialElement | null } | null {
  const maxDepth = options.limits?.maxDepth ?? 12;
  const maxNodes = options.limits?.maxNodes ?? 200;
  const fallback = options.streaming ?? 'complete';
  let nodes = 0;
  let broken = false;

  const visit = (value: unknown, id: string, depth: number): GenuiPartialElement | undefined => {
    if (broken) return undefined;
    if (!isRecord(value)) {
      // An element that is not an object will never validate.
      if (value !== undefined) broken = true;
      return undefined;
    }
    const open = input.isOpen(value);
    const type = value.type;
    // `"type": "Car` may yet be `"CardGrid"`: wait for the closing quote.
    if (typeof type !== 'string' || (open && input.pendingMember(value) === 'type')) {
      if (!open) broken = true;
      return undefined;
    }
    const definition = catalog.get(type);
    nodes += 1;
    if (
      definition === undefined ||
      definition.internal === true ||
      nodes > maxNodes ||
      depth > maxDepth
    ) {
      broken = true;
      return undefined;
    }
    const mode = definition.streaming ?? fallback;
    if (mode === 'complete') {
      // Drawn only whole — and only once its props would pass (a display gate; the final tree is
      // validated on its own, as every tree is).
      const checked = open
        ? undefined
        : validatePropsSync(definition.props, value.props ?? {}, catalog.validator);
      if (checked === undefined || !checked.ok) {
        return { id, type, props: {}, incomplete: true, held: true };
      }
      const children = childrenOf(value, id, depth, definition.children === true);
      return {
        id,
        type,
        props: checked.value as Record<string, unknown>,
        ...(children !== undefined && children.length > 0 ? { children } : {}),
      };
    }
    const props = isRecord(value.props) ? value.props : {};
    const children = childrenOf(value, id, depth, definition.children === true);
    return {
      id,
      type,
      props,
      ...(children !== undefined && children.length > 0 ? { children } : {}),
      ...(open ? { incomplete: true as const } : {}),
    };
  };

  const childrenOf = (
    value: Record<string, unknown>,
    id: string,
    depth: number,
    takesChildren: boolean,
  ): GenuiPartialElement[] | undefined => {
    const raw = value.children;
    // A stringified `children` (a model quirk the final validation repairs) cannot be drawn yet.
    if (!Array.isArray(raw)) return undefined;
    if (raw.length > 0 && !takesChildren) {
      broken = true;
      return undefined;
    }
    const children: GenuiPartialElement[] = [];
    for (const [index, child] of raw.entries()) {
      const next = visit(child, treeNodeId(id, index), depth + 1);
      if (next !== undefined) children.push(next);
    }
    return children;
  };

  const root = visit(input.value, 'root', 1);
  if (broken) return null;
  return { root: root ?? null };
}
