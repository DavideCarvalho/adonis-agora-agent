import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  jsonByteLength,
  sandboxAction,
  type UiAction,
  validateUiActionContext,
} from '../../../genui/actions.js';
import {
  buildSandboxDocument,
  previewHtml,
  SANDBOX_DEFAULTS,
  SANDBOX_IFRAME_FLAGS,
  SANDBOX_MESSAGE,
  type SandboxPolicy,
  type SandboxProps,
  sandboxPolicyOf,
} from '../../../genui/sandbox.js';
import type { JsonSchema } from '../../../genui/schema.js';
import { GenuiActionContext, useGenuiNode, useGenuiProvider } from './generative-ui.js';
import type { GenuiRenderer } from './types.js';

/** What a drawn component calls to hand an action back to the agent (the next user turn). */
export type GenuiActionHandler = (action: UiAction) => void;

/**
 * Where UI actions go — a sandbox's `agent.send(…)`, an app component's button. Typically the chat's
 * `sendUiAction`, which sends the action as the next user message:
 *
 * ```tsx
 * const chat = useAgentChat()
 * <GenuiActionProvider onAction={chat.sendUiAction}>…</GenuiActionProvider>
 * ```
 */
export function GenuiActionProvider({
  onAction,
  children,
}: {
  onAction: GenuiActionHandler;
  children?: ReactNode;
}) {
  return <GenuiActionContext.Provider value={onAction}>{children}</GenuiActionContext.Provider>;
}

/** The enclosing {@link GenuiActionProvider}'s handler, or `null` outside one. */
export function useGenuiAction(): GenuiActionHandler | null {
  return useContext(GenuiActionContext);
}

/** Why the host refused something a sandbox sent. */
export type SandboxRefusal =
  | { reason: 'too-large'; bytes: number; limit: number }
  | { reason: 'too-soon'; waitMs: number }
  | { reason: 'too-many'; limit: number }
  | { reason: 'not-json' }
  | { reason: 'invalid'; issues: { path: (string | number)[]; message: string }[] }
  | { reason: 'declined' }
  | { reason: 'no-handler' };

export interface SandboxRendererOptions {
  /**
   * The policy the frame runs under. Default: the one the catalog's definition carries
   * (`defineSandbox({ policy })`, read through the enclosing `GenuiProvider`'s catalog), else none
   * — no network, the default limits.
   */
  policy?: SandboxPolicy;
  /** Checks the values of every `agent.send(…)` (a Zod object, any Standard Schema, or a JSON Schema). */
  schema?: StandardSchemaV1 | JsonSchema;
  /** Last word on an action before it is sent — e.g. a confirmation dialog. Falsy → dropped. */
  confirm?: (action: UiAction) => boolean | Promise<boolean>;
  /** Where actions go. Default: the enclosing {@link GenuiActionProvider}. */
  onAction?: GenuiActionHandler;
  /** Something the frame sent was refused (see {@link SandboxRefusal}). */
  onRefused?: (refusal: SandboxRefusal) => void;
  /** An uncaught error in the generated code. */
  onError?: (message: string) => void;
  /** What to draw while nothing is drawable yet. Default: a busy box of `initialHeight` with the placeholder lines. */
  placeholder?: (state: { height: number; messages: string[]; title?: string }) => ReactNode;
  className?: string;
  style?: CSSProperties;
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function DefaultPlaceholder({
  height,
  messages,
  title,
}: {
  height: number;
  messages: string[];
  title?: string;
}) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (messages.length < 2) return;
    const timer = setInterval(() => setIndex((value) => (value + 1) % messages.length), 1800);
    return () => clearInterval(timer);
  }, [messages.length]);
  const line = messages[index % Math.max(1, messages.length)] ?? 'Building the view…';
  return (
    <div
      role="status"
      aria-busy="true"
      data-genui-skeleton=""
      data-testid="sandbox-placeholder"
      data-sandbox-phase="placeholder"
      style={{
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px dashed rgba(127,127,127,.35)',
        borderRadius: 8,
        color: 'rgba(90,90,90,.9)',
        fontSize: 13,
      }}
    >
      {title !== undefined ? `${title} — ${line}` : line}
    </div>
  );
}

/**
 * A renderer for the sandbox component (`Sandbox`): the model's HTML, CSS and JS in an isolated
 * iframe — `srcdoc`, `sandbox="allow-scripts"` (never `allow-same-origin`, so its origin is opaque
 * and it reaches no cookie, storage or DOM of the page), a strict CSP, sized to its content.
 *
 * While the model writes it (a tree node flagged `incomplete`): a placeholder of `initialHeight`,
 * then a preview of the styled markup (no code runs), then — once the markup is done — the live
 * view, whose `jsFunctions` and `jsExpressions` run as each one closes (only for a node the server
 * trimmed; anything else runs its code once complete).
 *
 * The frame's only way out is `agent.send(values)`. The host accepts it only from this frame's
 * window, with this frame's token, from the opaque origin, within the size, rate and count limits,
 * past `schema` and `confirm` — and hands it on as a {@link UiAction}.
 */
export function createSandboxRenderer(
  options: SandboxRendererOptions = {},
): GenuiRenderer<SandboxProps> {
  function SandboxView(props: SandboxProps) {
    const node = useGenuiNode();
    const provided = useGenuiProvider();
    const contextAction = useGenuiAction();
    const definition = provided?.catalog?.get?.(node?.type ?? 'Sandbox');
    const policy = useMemo(() => options.policy ?? sandboxPolicyOf(definition) ?? {}, [definition]);
    const incomplete = node?.incomplete === true;
    // The server drops half-written code from what it previews (`sandboxPartialProps`); props
    // from anywhere else may hold it, so their code waits for the whole view.
    const trimmed = incomplete && node?.streamSafe === true;
    const token = useMemo(randomToken, []);
    const frame = useRef<HTMLIFrameElement | null>(null);
    const ready = useRef(false);
    const ran = useRef({ functions: false, expressions: 0 });
    const sends = useRef({ count: 0, last: 0 });
    const initial = clampHeight(props.initialHeight ?? SANDBOX_DEFAULTS.initialHeight, policy);
    // The content's own height once the frame has reported it; the declared one until then.
    const [measured, setMeasured] = useState<number | null>(null);
    const height = measured ?? initial;
    // Mounted while the model was still writing: code arrives by message, never inlined.
    const streamedIn = useRef(incomplete);

    const hasMarkup = typeof props.html === 'string' && props.html.length > 0;
    const markupDone =
      !incomplete || props.jsFunctions !== undefined || props.jsExpressions !== undefined;
    const phase: 'placeholder' | 'preview' | 'live' = !incomplete
      ? 'live'
      : markupDone && hasMarkup && trimmed
        ? 'live'
        : props.css !== undefined || hasMarkup
          ? 'preview'
          : 'placeholder';
    const hostOrigin = typeof window === 'undefined' ? '' : window.location.origin;
    const inlineJs = !streamedIn.current;
    const css = props.css;
    const html = props.html;
    // The live document is built once per markup: code that arrives later is posted in, so the
    // frame (and what the user did in it) stays.
    // biome-ignore lint/correctness/useExhaustiveDependencies: rebuilt on the markup only, see above
    const srcDoc = useMemo(() => {
      if (phase === 'placeholder' || hostOrigin === '') return '';
      return phase === 'preview'
        ? buildSandboxDocument({}, { token, hostOrigin, policy, mode: 'preview' })
        : buildSandboxDocument(props, { token, hostOrigin, policy, mode: 'live', inlineJs });
    }, [phase, token, hostOrigin, css, html, inlineJs, policy]);

    const post = useCallback(
      (message: Record<string, unknown>) => {
        frame.current?.contentWindow?.postMessage({ ...message, token }, '*');
      },
      [token],
    );

    const runPending = useCallback(() => {
      if (!ready.current || inlineJs || phase !== 'live') return;
      if (!trimmed && incomplete) return;
      const done = ran.current;
      if (!done.functions && typeof props.jsFunctions === 'string') {
        post({ type: SANDBOX_MESSAGE.run, code: props.jsFunctions });
        done.functions = true;
      }
      // Expressions call the functions: while the model writes, wait for them — unless it has
      // already moved on to the expressions (it wrote no functions).
      if (!done.functions && incomplete && props.jsExpressions === undefined) return;
      const expressions = props.jsExpressions ?? [];
      while (done.expressions < expressions.length) {
        const code = expressions[done.expressions];
        done.expressions += 1;
        if (typeof code === 'string') post({ type: SANDBOX_MESSAGE.run, code });
      }
    }, [inlineJs, phase, trimmed, incomplete, props.jsFunctions, props.jsExpressions, post]);

    const preview = useCallback(() => {
      if (!ready.current || phase !== 'preview') return;
      post({ type: SANDBOX_MESSAGE.render, css: css ?? '', html: previewHtml(html ?? '') });
    }, [phase, css, html, post]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: a new document starts from nothing
    useEffect(() => {
      ready.current = false;
      ran.current = { functions: false, expressions: 0 };
    }, [srcDoc]);

    useEffect(() => {
      preview();
      runPending();
    }, [preview, runPending]);

    const onAction = options.onAction ?? contextAction;
    const title = props.title;
    const nodeId = node?.id;
    const send = useCallback(
      async (payload: unknown) => {
        const limits = sends.current;
        const maxSends = policy.maxSends ?? SANDBOX_DEFAULTS.maxSends;
        if (limits.count >= maxSends)
          return options.onRefused?.({ reason: 'too-many', limit: maxSends });
        const now = Date.now();
        const interval = policy.minSendIntervalMs ?? SANDBOX_DEFAULTS.minSendIntervalMs;
        if (limits.last > 0 && now - limits.last < interval) {
          return options.onRefused?.({
            reason: 'too-soon',
            waitMs: interval - (now - limits.last),
          });
        }
        const bytes = jsonByteLength(payload);
        if (bytes === undefined) return options.onRefused?.({ reason: 'not-json' });
        const limit = policy.maxPayloadBytes ?? SANDBOX_DEFAULTS.maxPayloadBytes;
        if (bytes > limit) return options.onRefused?.({ reason: 'too-large', bytes, limit });
        limits.last = now;
        let action = sandboxAction(payload, {
          ...(nodeId !== undefined ? { componentId: nodeId } : {}),
          ...(title !== undefined ? { title } : {}),
        });
        if (options.schema !== undefined) {
          const checked = await validateUiActionContext(action, options.schema);
          if (!checked.ok)
            return options.onRefused?.({ reason: 'invalid', issues: checked.issues });
          action = { ...action, context: checked.context };
        }
        if (options.confirm !== undefined && !(await options.confirm(action))) {
          return options.onRefused?.({ reason: 'declined' });
        }
        if (onAction === null || onAction === undefined)
          return options.onRefused?.({ reason: 'no-handler' });
        limits.count += 1;
        onAction(action);
      },
      [policy, nodeId, title, onAction],
    );

    useEffect(() => {
      if (phase === 'placeholder') return;
      const listener = (event: MessageEvent) => {
        // Only this frame's window, from its opaque origin, with its token.
        if (frame.current === null || event.source !== frame.current.contentWindow) return;
        if (event.origin !== 'null') return;
        const data = event.data as Record<string, unknown> | null;
        if (data === null || typeof data !== 'object' || data.token !== token) return;
        switch (data.type) {
          case SANDBOX_MESSAGE.ready:
            ready.current = true;
            preview();
            runPending();
            return;
          case SANDBOX_MESSAGE.resize:
            if (typeof data.height === 'number' && Number.isFinite(data.height)) {
              setMeasured(clampHeight(data.height, policy));
            }
            return;
          case SANDBOX_MESSAGE.send:
            void send(data.payload);
            return;
          case SANDBOX_MESSAGE.error:
            options.onError?.(
              typeof data.message === 'string' ? data.message.slice(0, 500) : 'error',
            );
            return;
        }
      };
      window.addEventListener('message', listener);
      return () => window.removeEventListener('message', listener);
    }, [phase, token, policy, preview, runPending, send]);

    const messages = (props.placeholderMessages ?? []).filter(
      (line): line is string => typeof line === 'string',
    );
    if (phase === 'placeholder' || hostOrigin === '') {
      const state = { height: initial, messages, ...(title !== undefined ? { title } : {}) };
      return (
        <>{options.placeholder ? options.placeholder(state) : <DefaultPlaceholder {...state} />}</>
      );
    }
    return (
      <iframe
        ref={frame}
        key={phase}
        title={title ?? 'Interactive view'}
        srcDoc={srcDoc}
        sandbox={SANDBOX_IFRAME_FLAGS}
        referrerPolicy="no-referrer"
        allow=""
        data-testid="sandbox-frame"
        data-sandbox-phase={phase}
        aria-busy={incomplete || undefined}
        className={options.className}
        style={{
          display: 'block',
          width: '100%',
          border: 0,
          height,
          transition: 'height 120ms ease-out',
          ...options.style,
        }}
      />
    );
  }
  return SandboxView;
}

function clampHeight(value: number, policy: SandboxPolicy): number {
  const max = policy.maxHeight ?? SANDBOX_DEFAULTS.maxHeight;
  return Math.max(24, Math.min(max, Math.ceil(value)));
}

/** The sandbox renderer with its defaults — register it as `Sandbox` in a genui registry. */
export const SandboxView: GenuiRenderer<SandboxProps> = createSandboxRenderer();
