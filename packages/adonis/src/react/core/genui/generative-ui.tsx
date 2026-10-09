import {
  Component,
  type Context,
  createContext,
  type ErrorInfo,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
} from 'react';
import type { UiAction } from '../../../genui/actions.js';
import { AmbientRenderUiContext, sharedContext } from '../components/ambient-ui.js';
import type { TranscriptUiBlock } from '../transcript/model.js';
import { shareStructure } from './share-structure.js';
import type {
  GenerativeUIElement,
  GenerativeUIItem,
  GenerativeUIOptions,
  GenerativeUIProblem,
  GenerativeUIState,
  GenuiNodeState,
  GenuiPlaceholder,
  GenuiRegistry,
  GenuiRenderer,
} from './types.js';
import {
  useGenerativeUIState,
  useResolvedComponent,
  useValidatedProps,
} from './use-generative-ui.js';

/** What to draw instead of a component that did not render. Default: nothing. */
export type GenerativeUIFallback = ReactNode | ((problem: GenerativeUIProblem) => ReactNode);

/** How a tree draws what is not a node: read when a node renders, never a reason to re-render one. */
interface TreeLook {
  fallback: GenerativeUIFallback | undefined;
  loading: ReactNode;
  placeholder: GenuiPlaceholder | undefined;
  onError: ((error: unknown, item: GenerativeUIItem) => void) | undefined;
}

interface TreeScope {
  fallbackText?: string;
  componentVersions?: Record<string, number>;
  options: GenerativeUIOptions;
  /** A fallback was given: a failing node draws it rather than failing the whole tree. */
  hasFallback: boolean;
  /**
   * The latest fallback, loading, placeholder and onError. Behind a ref so an inline element or
   * callback from a host that re-renders on every token does not re-render every node with it.
   */
  look: { readonly current: TreeLook };
}

const TreeScopeContext = createContext<TreeScope | null>(null);

/** Where UI actions go — `GenuiActionProvider` (sandbox.tsx) and `GenuiProvider`'s `onAction`. */
export const GenuiActionContext: Context<((action: UiAction) => void) | null> = sharedContext<
  (action: UiAction) => void
>('@adonis-agora/agent/react:genui-action');

// Shared by key, like the provider's: a renderer imports the hook from `/genui` while the tree may
// be drawn by the `/genui/json-render` bundle's copy of this module.
const GenuiNodeContext: Context<GenuiNodeState | null> = sharedContext<GenuiNodeState>(
  '@adonis-agora/agent/react:genui-node',
);

/**
 * The tree node being rendered — read it in a renderer to draw a skeleton while the model is still
 * writing the node (`incomplete`), e.g. a chart's axes before its data. `null` outside a tree.
 *
 * ```tsx
 * function Chart(props: ChartProps) {
 *   const node = useGenuiNode();
 *   if (node?.incomplete && !props.data?.length) return <ChartSkeleton title={props.title} />;
 *   return <BarChart {...props} />;
 * }
 * ```
 */
export function useGenuiNode(): GenuiNodeState | null {
  return useContext(GenuiNodeContext);
}

/**
 * Set the node a renderer sees through {@link useGenuiNode} — for glue that draws components outside
 * a `genui:tree` frame (a framework's own tool-call renderer) and knows the call is still streaming:
 * `<GenuiNodeScope node={{ id: 'root', type: 'Sandbox', incomplete: true, held: false }}>`.
 */
export function GenuiNodeScope({
  node,
  children,
}: {
  node: GenuiNodeState | null;
  children?: ReactNode;
}) {
  return <GenuiNodeContext.Provider value={node}>{children}</GenuiNodeContext.Provider>;
}

function renderPlaceholder(look: TreeLook, node: GenuiNodeState): ReactNode {
  const { placeholder } = look;
  if (typeof placeholder === 'function') return placeholder(node);
  return placeholder !== undefined ? placeholder : look.loading;
}

function renderFallback(fallback: GenerativeUIFallback | undefined, problem: GenerativeUIProblem) {
  if (typeof fallback === 'function') return fallback(problem);
  if (fallback !== undefined) return fallback;
  return problem.item.fallbackText !== undefined ? (
    <span style={{ whiteSpace: 'pre-wrap' }}>{problem.item.fallbackText}</span>
  ) : null;
}

interface BoundaryProps {
  item: GenerativeUIItem;
  fallback: GenerativeUIFallback | undefined;
  onError: ((error: unknown, item: GenerativeUIItem) => void) | undefined;
  children: ReactNode;
}

/** One failing renderer takes down its own item, never the message around it. */
class ItemBoundary extends Component<BoundaryProps, { error: unknown; failed: boolean }> {
  override state = { error: undefined as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo) {
    this.props.onError?.(error, this.props.item);
  }

  override componentDidUpdate(previous: BoundaryProps) {
    // New props for the same item (a streamed update) get a fresh chance to render.
    if (this.state.failed && previous.item !== this.props.item) {
      this.setState({ error: undefined, failed: false });
    }
  }

  override render() {
    if (this.state.failed) {
      return renderFallback(this.props.fallback, {
        reason: 'error',
        item: this.props.item,
        error: this.state.error,
      });
    }
    return this.props.children;
  }
}

function nodeItem(node: GenerativeUIElement, id: string): GenerativeUIItem {
  return { id, component: node.type, props: node.props ?? {}, version: null, toolCallId: null };
}

/** A failing node takes the whole tree to the item's fallback text — no fallback of its own given. */
function failsWhole(scope: TreeScope): boolean {
  return !scope.hasFallback && scope.fallbackText !== undefined;
}

interface TreeNodeProps {
  node: GenerativeUIElement;
  id: string;
  /** Wrap the node in its own error boundary (every node but the root, which its item's has). */
  bounded: boolean;
}

/**
 * One tree node, re-rendered only when its node is a different object (or the scope changed).
 * {@link GenuiTree} keeps an unchanged node the same object from frame to frame, so as a preview
 * streams in only the nodes that grew — and their ancestors — render again; a node turning from
 * `incomplete`/`held` to final is a changed node and renders.
 */
const TreeNode = memo(
  function TreeNode({ node, id, bounded }: TreeNodeProps) {
    const scope = useContext(TreeScopeContext);
    const item = useMemo(() => nodeItem(node, id), [node, id]);
    if (scope === null) return null;
    if (!bounded || failsWhole(scope)) return <TreeNodeBody node={node} id={id} item={item} />;
    return (
      <ItemBoundary
        item={item}
        fallback={scope.look.current.fallback}
        onError={scope.look.current.onError}
      >
        <TreeNodeBody node={node} id={id} item={item} />
      </ItemBoundary>
    );
  },
  (previous, next) =>
    previous.node === next.node && previous.id === next.id && previous.bounded === next.bounded,
);

/** A tree node resolved and validated like a top-level item, children rendered as its `children`. */
function TreeNodeBody({
  node,
  id,
  item,
}: {
  node: GenerativeUIElement;
  id: string;
  item: GenerativeUIItem;
}) {
  const scope = useContext(TreeScopeContext);
  // A node of a preview the model is still writing: its props are half there, so they are not
  // validated (the final frame is) — the renderer is told instead, through `useGenuiNode`.
  const incomplete = node.incomplete === true;
  const held = node.held === true;
  const state = useMemo<GenuiNodeState>(
    () => ({ id, type: node.type, incomplete, held, ...(incomplete ? { streamSafe: true } : {}) }),
    [id, node.type, incomplete, held],
  );
  const storedVersion = scope?.componentVersions?.[node.type];
  const definition = scope?.options.catalog?.get?.(node.type);
  const incompatible =
    storedVersion !== undefined &&
    definition !== undefined &&
    storedVersion !== (definition.version ?? 1);
  const resolution = useResolvedComponent(
    node.type,
    storedVersion ?? null,
    incompatible ? {} : (scope?.options.registry ?? {}),
    scope?.options.resolveComponent,
  );
  const validation = useValidatedProps(
    incompatible || incomplete ? undefined : scope?.options.catalog,
    node.type,
    item.props,
  );
  if (scope === null) return null;
  const look = scope.look.current;
  if (held) {
    return (
      <GenuiNodeContext.Provider value={state}>
        {renderPlaceholder(look, state)}
      </GenuiNodeContext.Provider>
    );
  }
  if (resolution.status === 'loading' || validation.status === 'pending') return look.loading;
  if (resolution.status === 'unknown') {
    if (failsWhole(scope)) throw new Error('Unknown tree component');
    return renderFallback(look.fallback, { reason: 'unknown', item });
  }
  if (resolution.status === 'error') {
    if (failsWhole(scope)) throw resolution.error;
    return renderFallback(look.fallback, { reason: 'error', item, error: resolution.error });
  }
  if (validation.status === 'invalid') {
    if (failsWhole(scope)) throw new Error('Invalid tree component');
    return renderFallback(look.fallback, { reason: 'invalid', item, issues: validation.issues });
  }
  const Renderer = resolution.Component;
  const children = Array.isArray(node.children) ? node.children : [];
  return (
    <GenuiNodeContext.Provider value={state}>
      <Renderer {...validation.props}>
        {children.length > 0
          ? children.map((child, index) => {
              const childId = `${id}.${index}`;
              return <TreeNode key={childId} node={child} id={childId} bounded />;
            })
          : undefined}
      </Renderer>
    </GenuiNodeContext.Provider>
  );
}

/**
 * Renders a `genui:tree` frame's `{ root }` node by node through the same registry, catalog and
 * resolver as top-level components. Used automatically for tree frames unless a `treeRenderer`
 * (e.g. the json-render one) or a registry entry for `genui:tree` takes over.
 *
 * Each frame's tree is structurally shared with the previous one: a node equal to the one before
 * keeps that object, and its renderer does not run again.
 */
export function GenuiTree({ root }: { root?: GenerativeUIElement }) {
  const previous = useRef<GenerativeUIElement | undefined>(undefined);
  const valid = root !== undefined && root !== null && typeof root.type === 'string';
  const shared = valid ? shareStructure(previous.current, root) : undefined;
  previous.current = shared;
  if (shared === undefined) return null;
  return <TreeNode node={shared} id="root" bounded={false} />;
}

export interface GenerativeUIScopeProps extends GenerativeUIOptions {
  fallbackText?: string;
  componentVersions?: Record<string, number>;
  fallback?: GenerativeUIFallback;
  loading?: ReactNode;
  /** Drawn for a tree node held back while the model writes it. Default: `loading`. */
  placeholder?: GenuiPlaceholder;
  onError?: (error: unknown, item: GenerativeUIItem) => void;
  children?: ReactNode;
}

/**
 * The registry, catalog and fallbacks tree nodes render with. `<GenerativeUI>` provides it; wrap
 * your own chrome in it when you draw `useGenerativeUI`'s `Component` yourself and it may be a tree.
 */
export function GenerativeUIScope({
  registry,
  catalog,
  resolveComponent,
  fallback,
  fallbackText,
  componentVersions,
  loading = null,
  placeholder,
  onError,
  children,
}: GenerativeUIScopeProps) {
  // Read afresh from every frame of the item that carries them: kept the same object while equal.
  const versionsRef = useRef<Record<string, number> | undefined>(undefined);
  const versions = shareStructure(versionsRef.current, componentVersions);
  versionsRef.current = versions;
  const look = useRef<TreeLook>({ fallback, loading, placeholder, onError });
  look.current = { fallback, loading, placeholder, onError };
  const hasFallback = fallback !== undefined;
  const scope = useMemo<TreeScope>(
    () => ({
      options: {
        registry,
        ...(catalog !== undefined ? { catalog } : {}),
        ...(resolveComponent !== undefined ? { resolveComponent } : {}),
      },
      hasFallback,
      ...(versions !== undefined ? { componentVersions: versions } : {}),
      ...(fallbackText !== undefined ? { fallbackText } : {}),
      look,
    }),
    [registry, catalog, resolveComponent, hasFallback, fallbackText, versions],
  );
  return <TreeScopeContext.Provider value={scope}>{children}</TreeScopeContext.Provider>;
}

/** What `<GenuiProvider>` hands every `<GenerativeUI>` / `useGenerativeUI` below it. */
export interface GenuiProviderValue extends Partial<GenerativeUIOptions> {
  fallback?: GenerativeUIFallback;
  loading?: ReactNode;
  /** Drawn for a tree node held back while the model writes it (`streaming: 'complete'`). */
  placeholder?: GenuiPlaceholder;
  onError?: (error: unknown, item: GenerativeUIItem) => void;
  /**
   * Where UI actions go (a sandbox's `agent.send`, an A2UI button): typically the chat's
   * `sendUiAction`. Same as wrapping the tree in a `GenuiActionProvider`.
   */
  onAction?: (action: UiAction) => void;
}

// Shared by key: `/genui` and `/genui/json-render` are separate bundles, and a provider from one
// must reach a `<GenerativeUI>` from the other.
const GenuiContext: Context<GenuiProviderValue | null> = sharedContext<GenuiProviderValue>(
  '@adonis-agora/agent/react:genui-provider',
);

/** The enclosing `<GenuiProvider>`'s settings, or `null` outside one. */
export function useGenuiProvider(): GenuiProviderValue | null {
  return useContext(GenuiContext);
}

export interface GenuiProviderProps extends GenuiProviderValue {
  children?: ReactNode;
}

/**
 * Set generative UI up once, at the app root: the registry of your renderers, the catalog to
 * validate against, a resolver for components the registry lacks, and what to draw when one does
 * not render. Every `<GenerativeUI>` below reads it (its own props still win), and `MessageItem` /
 * `MessageList` draw pushed components with it — no `renderUi` per message.
 *
 * ```tsx
 * <GenuiProvider registry={registry} catalog={catalog} fallback={({ item }) => <Unknown name={item.component} />}>
 *   <App />
 * </GenuiProvider>
 * ```
 */
export function GenuiProvider({
  registry,
  catalog,
  resolveComponent,
  treeRenderer,
  fallback,
  loading,
  placeholder,
  onError,
  onAction,
  children,
}: GenuiProviderProps) {
  const value = useMemo<GenuiProviderValue>(
    () => ({
      ...(registry !== undefined ? { registry } : {}),
      ...(catalog !== undefined ? { catalog } : {}),
      ...(resolveComponent !== undefined ? { resolveComponent } : {}),
      ...(treeRenderer !== undefined ? { treeRenderer } : {}),
      ...(fallback !== undefined ? { fallback } : {}),
      ...(loading !== undefined ? { loading } : {}),
      ...(placeholder !== undefined ? { placeholder } : {}),
      ...(onError !== undefined ? { onError } : {}),
    }),
    [registry, catalog, resolveComponent, treeRenderer, fallback, loading, placeholder, onError],
  );
  const renderUi = useCallback((block: TranscriptUiBlock) => <GenerativeUI part={block} />, []);
  const inner = (
    <AmbientRenderUiContext.Provider value={renderUi}>{children}</AmbientRenderUiContext.Provider>
  );
  return (
    <GenuiContext.Provider value={value}>
      {onAction !== undefined ? (
        <GenuiActionContext.Provider value={onAction}>{inner}</GenuiActionContext.Provider>
      ) : (
        inner
      )}
    </GenuiContext.Provider>
  );
}

const NO_REGISTRY: GenuiRegistry = {};

/** Provider settings overlaid with explicit ones (explicit wins), memoized on their parts. */
function useMergedOptions(own: Partial<GenerativeUIOptions>): GenerativeUIOptions {
  const provided = useContext(GenuiContext);
  const registry = own.registry ?? provided?.registry ?? NO_REGISTRY;
  const catalog = own.catalog ?? provided?.catalog;
  const resolveComponent = own.resolveComponent ?? provided?.resolveComponent;
  const treeRenderer = own.treeRenderer ?? provided?.treeRenderer;
  return useMemo(
    () => ({
      registry,
      ...(catalog !== undefined ? { catalog } : {}),
      ...(resolveComponent !== undefined ? { resolveComponent } : {}),
      ...(treeRenderer !== undefined ? { treeRenderer } : {}),
    }),
    [registry, catalog, resolveComponent, treeRenderer],
  );
}

/**
 * The headless half of {@link GenerativeUI}: what to draw for one pushed component, or `null` when
 * `part` is not one. Options default to the enclosing `<GenuiProvider>`'s.
 */
export function useGenerativeUI(
  part: unknown,
  options: Partial<GenerativeUIOptions> = {},
): GenerativeUIState | null {
  const merged = useMergedOptions(options);
  return useGenerativeUIState(part, merged, merged.treeRenderer ?? (GenuiTree as GenuiRenderer));
}

export interface GenerativeUIProps extends Partial<GenerativeUIOptions> {
  /** A transcript `ui` block, a `data-ui` message part, or a stored `{ id, component, props, version? }`. */
  part: TranscriptUiBlock | GenerativeUIItem | unknown;
  /** Drawn for an unknown component, invalid props, or a renderer that threw. Default: the provider's, then the item's persisted text. */
  fallback?: GenerativeUIFallback;
  /** Drawn while a resolver or an async validation is pending. Default: the provider's, else nothing. */
  loading?: ReactNode;
  /**
   * Drawn for a tree node held back while the model writes it (its component streams `complete`).
   * Default: the provider's, else `loading`.
   */
  placeholder?: GenuiPlaceholder;
  /** A renderer threw (the item shows `fallback`). */
  onError?: (error: unknown, item: GenerativeUIItem) => void;
}

/**
 * Draws one server-pushed component with the app's own renderer. Headless: it adds no element and
 * no style of its own — only what the registry's component renders (and whatever `fallback` /
 * `loading` you pass). Everything but `part` defaults to the enclosing `<GenuiProvider>`.
 *
 * ```tsx
 * <GenerativeUI part={block} />
 * ```
 */
export function GenerativeUI({
  part,
  registry,
  catalog,
  resolveComponent,
  treeRenderer,
  fallback: ownFallback,
  loading: ownLoading,
  placeholder: ownPlaceholder,
  onError: ownOnError,
}: GenerativeUIProps) {
  const provided = useContext(GenuiContext);
  const fallback = ownFallback !== undefined ? ownFallback : provided?.fallback;
  const loading = ownLoading ?? provided?.loading ?? null;
  const placeholder = ownPlaceholder !== undefined ? ownPlaceholder : provided?.placeholder;
  const onError = ownOnError ?? provided?.onError;
  const options = useMergedOptions({
    ...(registry !== undefined ? { registry } : {}),
    ...(catalog !== undefined ? { catalog } : {}),
    ...(resolveComponent !== undefined ? { resolveComponent } : {}),
    ...(treeRenderer !== undefined ? { treeRenderer } : {}),
  });
  const state = useGenerativeUIState(
    part,
    options,
    options.treeRenderer ?? (GenuiTree as GenuiRenderer),
  );
  if (state === null) return null;
  if (state.status === 'loading') return loading;
  if (state.status === 'problem') {
    const { status: _status, ...problem } = state;
    return renderFallback(fallback, problem);
  }
  const Renderer = state.Component;
  return (
    <GenerativeUIScope
      {...options}
      {...(state.item.componentVersions !== undefined
        ? { componentVersions: state.item.componentVersions }
        : {})}
      {...(state.item.fallbackText !== undefined ? { fallbackText: state.item.fallbackText } : {})}
      fallback={fallback}
      loading={loading}
      {...(placeholder !== undefined ? { placeholder } : {})}
      {...(onError !== undefined ? { onError } : {})}
    >
      <ItemBoundary item={state.item} fallback={fallback} onError={onError}>
        <Renderer {...state.props} />
      </ItemBoundary>
    </GenerativeUIScope>
  );
}
