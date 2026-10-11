import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  type ComponentType,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type StyleProp, Text, View, type ViewStyle } from 'react-native';
import {
  WebView,
  type WebViewMessageEvent,
  type WebViewNavigation,
  type WebViewProps,
} from 'react-native-webview';
import type { UiAction } from '../../genui/actions.js';
import {
  buildSandboxDocument,
  previewHtml,
  SANDBOX_DEFAULTS,
  SANDBOX_MESSAGE,
  type SandboxPolicy,
  type SandboxProps,
  sandboxDrawsJsx,
  sandboxPolicyOf,
} from '../../genui/sandbox.js';
import type { JsonSchema } from '../../genui/schema.js';
import {
  GenuiActionContext,
  useGenuiNode,
  useGenuiProvider,
} from '../../react/core/genui/generative-ui.js';
import type { SandboxRefusal } from '../../react/core/genui/sandbox.js';
import type { GenuiRenderer } from '../../react/core/genui/types.js';
import {
  type FetchLike,
  type NativeSandboxConfigSource,
  useNativeSandboxAsset,
  useNativeSandboxConfig,
} from './sandbox-assets.js';
import {
  checkSandboxSend,
  clampSandboxHeight,
  hostMessageScript,
  type NativeSandboxTheme,
  nativeThemeCss,
  parseFrameMessage,
  type SendState,
  sandboxToken,
  shouldStartSandboxLoad,
} from './sandbox-host.js';

/** What a drawn component calls to hand an action back to the agent (the next user turn). */
export type GenuiActionHandler = (action: UiAction) => void;

export interface NativeSandboxRendererOptions {
  /**
   * The policy the frame runs under. Default: the one the catalog's definition carries (through the
   * enclosing `GenuiProvider`'s catalog), else none — no network, the default limits.
   */
  policy?: SandboxPolicy;
  /** Checks the values of every `agent.send(…)` (a Zod object, any Standard Schema, or a JSON Schema). */
  schema?: StandardSchemaV1 | JsonSchema;
  /** Last word on an action before it is sent — e.g. an `Alert`. Falsy → dropped (`declined`). */
  confirm?: (action: UiAction) => boolean | Promise<boolean>;
  /** Where actions go. Default: the enclosing `GenuiActionProvider` / `GenuiProvider onAction`. */
  onAction?: GenuiActionHandler;
  /** Something the frame sent was refused — the same reasons as the web renderer's. */
  onRefused?: (refusal: SandboxRefusal) => void;
  /** An uncaught error in the generated code, or the view lost (it navigated, its process died). */
  onError?: (message: string) => void;
  /**
   * The app's design tokens, as CSS custom properties on the frame's `:root` (the web renderer reads
   * them off its page). An object, or a hook returning one — called while rendering, so it may use
   * hooks (`() => useAppTheme()`); a change reaches a drawn view without reloading it. `false`: off.
   */
  theme?: NativeSandboxTheme | false | (() => NativeSandboxTheme | null | undefined);
  /**
   * Tailwind and the kit: an object (assets inline or by url), a url answering `GET <agent>/config`,
   * a loader, or `false`. Default: `GET <baseUrl>/config` with a `baseUrl`, else theme only.
   */
  config?: NativeSandboxConfigSource;
  /**
   * The agent's absolute url (`https://api.example.com/agent`): where the config is fetched from by
   * default, and what the relative urls it names resolve against.
   */
  baseUrl?: string;
  /** The `fetch` for the config and assets. Default: the global one. */
  fetch?: FetchLike;
  /** What to draw while nothing is drawable yet. Default: a box of `initialHeight` with the placeholder lines. */
  placeholder?: (state: { height: number; messages: string[]; title?: string }) => ReactNode;
  /** Extra style for the WebView (its height is the content's). */
  style?: StyleProp<ViewStyle>;
}

/**
 * The WebView props every sandbox gets. JavaScript runs inside it; it stores nothing (no DOM
 * storage, incognito, no cache, no cookies), reads no file, opens no window, loads no mixed content,
 * shows no link preview, does not scroll (the host sizes it to its content) and goes nowhere: every
 * URL reaches `onShouldStartLoadWithRequest` (the whitelist lets them through — a URL it refuses
 * would be handed to `Linking.openURL`), which allows only the inline document.
 */
export const NATIVE_SANDBOX_WEBVIEW_PROPS: Readonly<WebViewProps> = Object.freeze({
  // Frozen with the rest: one shared array must not be widened by anyone.
  originWhitelist: Object.freeze(['*']) as unknown as string[],
  onShouldStartLoadWithRequest: shouldStartSandboxLoad,
  javaScriptEnabled: true,
  javaScriptCanOpenWindowsAutomatically: false,
  setSupportMultipleWindows: false,
  domStorageEnabled: false,
  allowFileAccess: false,
  allowFileAccessFromFileURLs: false,
  allowUniversalAccessFromFileURLs: false,
  allowsLinkPreview: false,
  incognito: true,
  cacheEnabled: false,
  cacheMode: 'LOAD_NO_CACHE',
  mixedContentMode: 'never',
  sharedCookiesEnabled: false,
  thirdPartyCookiesEnabled: false,
  geolocationEnabled: false,
  mediaCapturePermissionGrantType: 'deny',
  mediaPlaybackRequiresUserAction: true,
  allowsFullscreenVideo: false,
  allowsAirPlayForMediaPlayback: false,
  allowsProtectedMedia: false,
  allowsBackForwardNavigationGestures: false,
  pullToRefreshEnabled: false,
  dataDetectorTypes: 'none',
  saveFormDataDisabled: true,
  setBuiltInZoomControls: false,
  setDisplayZoomControls: false,
  textZoom: 100,
  paymentRequestEnabled: false,
  enableApplePay: false,
  webviewDebuggingEnabled: false,
  scrollEnabled: false,
  bounces: false,
  overScrollMode: 'never',
  nestedScrollEnabled: false,
  showsVerticalScrollIndicator: false,
  showsHorizontalScrollIndicator: false,
  automaticallyAdjustContentInsets: false,
  contentInsetAdjustmentBehavior: 'never',
  startInLoadingState: false,
} satisfies WebViewProps);

/** What the renderer calls on the WebView. */
interface WebViewHandle {
  injectJavaScript(script: string): void;
}

// The package's class declaration (`Component<WebViewProps & P>`, `P = undefined`) types its props
// as `never` under strict null checks; this is the component as it is.
const SandboxWebView = WebView as unknown as ComponentType<
  WebViewProps & { ref?: Ref<WebViewHandle> }
>;

/** A URL that is neither the inline document nor a `data:` one — the WebView left the sandbox. */
function isForeignUrl(url: unknown): boolean {
  return typeof url === 'string' && url !== '' && !/^(about|data):/i.test(url);
}

/** How many times a view whose WebView process died is drawn afresh before it gives up. */
const MAX_RESTARTS = 2;

const placeholderBox: ViewStyle = {
  alignItems: 'center',
  justifyContent: 'center',
  borderWidth: 1,
  borderStyle: 'dashed',
  borderColor: 'rgba(127,127,127,0.35)',
  borderRadius: 8,
  padding: 12,
};

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
    <View
      testID="sandbox-placeholder"
      accessibilityRole="progressbar"
      accessibilityState={{ busy: true }}
      style={[placeholderBox, { height }]}
    >
      <Text style={{ color: 'rgba(90,90,90,0.9)', fontSize: 13 }}>
        {title !== undefined ? `${title} — ${line}` : line}
      </Text>
    </View>
  );
}

function Note({ testID, title, text }: { testID: string; title?: string; text: string }) {
  return (
    <View testID={testID} style={[placeholderBox, { alignItems: 'flex-start' }]}>
      {title !== undefined ? <Text style={{ fontWeight: '600' }}>{title}</Text> : null}
      <Text>{text}</Text>
    </View>
  );
}

/**
 * A React Native renderer for the sandbox component (`Sandbox`): the model's HTML, CSS and JS in a
 * hardened `react-native-webview` ({@link NATIVE_SANDBOX_WEBVIEW_PROPS}) — the same document as the
 * web renderer's iframe (`buildSandboxDocument`, the same CSP: no network unless the policy lists an
 * origin), sized to its content.
 *
 * It streams like the web one: a placeholder of `initialHeight`, a preview of the styled markup (no
 * code runs), then the live view, whose code is posted in as it closes. The only bridge is the one
 * the document carries: `ReactNativeWebView.postMessage` out (ready, resize, error, `agent.send`),
 * `injectJavaScript` dispatching a `message` event in (render, run, theme, jsx). Everything the
 * WebView says is checked as the web host checks it — length capped before parsing, the frame's
 * token, size, interval and count limits, JSON only, `schema`, `confirm` — and an accepted
 * `agent.send` is handed on as a `UiAction`.
 *
 * ```tsx
 * <GenuiProvider registry={{ Sandbox: createNativeSandboxRenderer({ theme: () => useSandboxTheme() }) }} onAction={chat.sendUiAction}>
 * ```
 */
export function createNativeSandboxRenderer(
  options: NativeSandboxRendererOptions = {},
): GenuiRenderer<SandboxProps> {
  const themeOption = options.theme;
  // Fixed per renderer, so the hook below is always (or never) called.
  const useThemeOption: () => NativeSandboxTheme | null | undefined =
    typeof themeOption === 'function'
      ? themeOption
      : () => (themeOption === false ? null : themeOption);

  function NativeSandboxView(props: SandboxProps) {
    const node = useGenuiNode();
    const provided = useGenuiProvider();
    const contextAction = useContext(GenuiActionContext);
    const definition = provided?.catalog?.get?.(node?.type ?? 'Sandbox');
    const policy = useMemo(() => options.policy ?? sandboxPolicyOf(definition) ?? {}, [definition]);
    const incomplete = node?.incomplete === true;
    const client = useNativeSandboxConfig(options.config, options.baseUrl, options.fetch);
    const view = (definition as { sandboxView?: { theme?: boolean } } | undefined)?.sandboxView;
    const themeOn =
      themeOption !== false && (client.config?.theme ?? view?.theme ?? true) !== false;
    const themeInput = useThemeOption();
    const themeKey = themeOn && themeInput ? JSON.stringify(themeInput) : '';
    // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the theme's content
    const theme = useMemo(
      () => (themeOn && themeInput ? nativeThemeCss(themeInput) : null),
      [themeKey],
    );
    const jsxMode = sandboxDrawsJsx(props);
    const tailwindConfig = client.config?.tailwind;
    const tailwindText = useNativeSandboxAsset(
      tailwindConfig !== undefined
        ? { inline: tailwindConfig.runtime, url: tailwindConfig.url }
        : undefined,
      options.baseUrl,
      options.fetch,
    );
    const cssConfig = client.config?.css;
    const cssText = useNativeSandboxAsset(
      cssConfig !== undefined ? { inline: cssConfig.source, url: cssConfig.url } : undefined,
      options.baseUrl,
      options.fetch,
    );
    const kitConfig = client.config?.kit;
    const kitText = useNativeSandboxAsset(
      jsxMode && kitConfig !== undefined
        ? { inline: kitConfig.source, url: kitConfig.url }
        : undefined,
      options.baseUrl,
      options.fetch,
    );
    const assetsPending =
      (tailwindConfig !== undefined && tailwindText === undefined) ||
      (cssConfig !== undefined && cssText === undefined) ||
      (jsxMode && (client.loading || kitText === undefined));
    const themeRef = useRef(theme);
    themeRef.current = theme;
    // The server drops half-written code from what it previews (`sandboxPartialProps`); props
    // from anywhere else may hold it, so their code waits for the whole view.
    const trimmed = incomplete && node?.streamSafe === true;
    const token = useMemo(sandboxToken, []);
    const web = useRef<WebViewHandle | null>(null);
    const ready = useRef(false);
    const ran = useRef({ functions: false, expressions: 0 });
    const sends = useRef<SendState>({ count: 0, last: 0 });
    const initial = clampSandboxHeight(
      props.initialHeight ?? SANDBOX_DEFAULTS.initialHeight,
      policy,
    );
    const [measured, setMeasured] = useState<number | null>(null);
    const height = measured ?? initial;
    const streamedIn = useRef(incomplete);
    // The WebView left the inline document (it never should), or its process died too often.
    const [lost, setLost] = useState<string | null>(null);
    const [generation, setGeneration] = useState(0);

    const hasMarkup = typeof props.html === 'string' && props.html.length > 0;
    const markupDone =
      !incomplete || props.jsFunctions !== undefined || props.jsExpressions !== undefined;
    const hasJsx = jsxMode && (props.jsx as string).trim().length > 0;
    const phase: 'placeholder' | 'preview' | 'live' = assetsPending
      ? 'placeholder'
      : jsxMode
        ? !hasJsx
          ? 'placeholder'
          : incomplete
            ? 'preview'
            : 'live'
        : !incomplete
          ? 'live'
          : markupDone && hasMarkup && trimmed
            ? 'live'
            : props.css !== undefined || hasMarkup
              ? 'preview'
              : 'placeholder';
    const inlineJs = !streamedIn.current;
    const css = props.css;
    const html = props.html;
    const kit = jsxMode && typeof kitText === 'string' ? kitText : undefined;
    const documentPhase = jsxMode && phase !== 'placeholder' ? 'jsx' : phase;
    // Built once per markup, like the web renderer's: code that arrives later is posted in.
    // biome-ignore lint/correctness/useExhaustiveDependencies: rebuilt on the markup only
    const documentHtml = useMemo(() => {
      if (phase === 'placeholder') return '';
      const current = themeRef.current;
      const look = {
        ...(current !== null
          ? { theme: { css: current.css, dark: current.dark, attributes: current.attributes } }
          : {}),
        ...(typeof cssText === 'string' ? { styles: cssText } : {}),
        ...(typeof tailwindText === 'string'
          ? {
              tailwind: {
                runtime: tailwindText,
                theme: [current?.tailwind ?? '', tailwindConfig?.css ?? '']
                  .filter((part) => part !== '')
                  .join('\n'),
              },
            }
          : {}),
      };
      const base = { token, hostOrigin: '', policy, transport: 'react-native' as const, ...look };
      if (jsxMode) {
        return buildSandboxDocument(
          { css: css ?? '' },
          { ...base, mode: 'live', inlineJs: false, ...(kit !== undefined ? { kit } : {}) },
        );
      }
      return phase === 'preview'
        ? buildSandboxDocument({}, { ...base, mode: 'preview' })
        : buildSandboxDocument(props, { ...base, mode: 'live', inlineJs });
    }, [
      documentPhase,
      token,
      jsxMode ? '' : css,
      html,
      inlineJs,
      policy,
      tailwindText,
      cssText,
      kit,
    ]);
    const source = useMemo(() => ({ html: documentHtml, baseUrl: 'about:blank' }), [documentHtml]);

    const post = useCallback(
      (message: Record<string, unknown>) => {
        web.current?.injectJavaScript(hostMessageScript({ ...message, token }));
      },
      [token],
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: jsxMode only gates it off
    const runPending = useCallback(() => {
      if (!ready.current || inlineJs || phase !== 'live' || jsxMode) return;
      if (!trimmed && incomplete) return;
      const done = ran.current;
      if (!done.functions && typeof props.jsFunctions === 'string') {
        post({ type: SANDBOX_MESSAGE.run, code: props.jsFunctions });
        done.functions = true;
      }
      if (!done.functions && incomplete && props.jsExpressions === undefined) return;
      const expressions = props.jsExpressions ?? [];
      while (done.expressions < expressions.length) {
        const code = expressions[done.expressions];
        done.expressions += 1;
        if (typeof code === 'string') post({ type: SANDBOX_MESSAGE.run, code });
      }
    }, [inlineJs, phase, trimmed, incomplete, props.jsFunctions, props.jsExpressions, post]);

    const preview = useCallback(() => {
      if (!ready.current) return;
      if (jsxMode) {
        if (phase !== 'placeholder')
          post({ type: SANDBOX_MESSAGE.jsx, code: props.jsx ?? '', final: phase === 'live' });
        return;
      }
      if (phase !== 'preview') return;
      post({ type: SANDBOX_MESSAGE.render, css: css ?? '', html: previewHtml(html ?? '') });
    }, [jsxMode, phase, props.jsx, css, html, post]);

    // The app's theme changed: the view follows, without reloading.
    useEffect(() => {
      if (theme === null || !ready.current) return;
      post({
        type: SANDBOX_MESSAGE.theme,
        css: theme.css,
        dark: theme.dark,
        attributes: theme.attributes,
      });
    }, [theme, post]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: a new document starts from nothing
    useEffect(() => {
      ready.current = false;
      ran.current = { functions: false, expressions: 0 };
    }, [documentHtml, generation]);

    useEffect(() => {
      preview();
      runPending();
    }, [preview, runPending]);

    const onAction = options.onAction ?? contextAction;
    const title = props.title;
    const nodeId = node?.id;
    const send = useCallback(
      async (payload: unknown) => {
        const result = await checkSandboxSend({
          payload,
          state: sends.current,
          policy,
          incomplete,
          ...(options.schema !== undefined ? { schema: options.schema } : {}),
          ...(options.confirm !== undefined ? { confirm: options.confirm } : {}),
          hasHandler: onAction !== null && onAction !== undefined,
          ...(nodeId !== undefined ? { componentId: nodeId } : {}),
          ...(title !== undefined ? { title } : {}),
        });
        if (!result.ok) return options.onRefused?.(result.refusal);
        onAction?.(result.action);
      },
      [policy, nodeId, title, onAction, incomplete],
    );

    const limit = policy.maxPayloadBytes ?? SANDBOX_DEFAULTS.maxPayloadBytes;
    const onMessage = useCallback(
      (event: WebViewMessageEvent) => {
        const native = event.nativeEvent;
        // Only the inline document speaks for the sandbox (it cannot navigate; this is the backstop).
        if (isForeignUrl(native.url)) return;
        const message = parseFrameMessage(native.data, token, limit);
        if (message.kind === 'too-large') {
          options.onRefused?.({ reason: 'too-large', bytes: message.bytes, limit });
          return;
        }
        if (message.kind === 'drop') return;
        const data = message.data;
        switch (data.type) {
          case SANDBOX_MESSAGE.ready:
            ready.current = true;
            if (typeof data.height === 'number' && Number.isFinite(data.height) && data.height > 0)
              setMeasured(clampSandboxHeight(data.height, policy));
            if (themeRef.current !== null)
              post({
                type: SANDBOX_MESSAGE.theme,
                css: themeRef.current.css,
                dark: themeRef.current.dark,
                attributes: themeRef.current.attributes,
              });
            preview();
            runPending();
            return;
          case SANDBOX_MESSAGE.resize:
            if (typeof data.height === 'number' && Number.isFinite(data.height))
              setMeasured(clampSandboxHeight(data.height, policy));
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
      },
      [token, limit, policy, post, preview, runPending, send],
    );

    const onNavigation = useCallback((navigation: WebViewNavigation) => {
      if (!isForeignUrl(navigation.url)) return;
      setLost('navigated');
      options.onError?.('The view tried to leave the sandbox.');
    }, []);

    // Handled (Android crashes the app on a render process gone that nobody handles): draw afresh.
    const restarts = useRef(0);
    const onProcessGone = useCallback(() => {
      if (restarts.current >= MAX_RESTARTS) {
        setLost('crashed');
        options.onError?.('The view stopped working.');
        return;
      }
      restarts.current += 1;
      setGeneration((value) => value + 1);
    }, []);

    const messages = (props.placeholderMessages ?? []).filter(
      (line): line is string => typeof line === 'string',
    );
    if (lost !== null) {
      return (
        <Note
          testID="sandbox-lost"
          {...(title !== undefined ? { title } : {})}
          text={props.summary ?? 'This interactive view is unavailable.'}
        />
      );
    }
    if (jsxMode && kitText === null && !assetsPending) {
      return (
        <Note
          testID="sandbox-no-kit"
          {...(title !== undefined ? { title } : {})}
          text={props.summary ?? "An interactive view that needs the app's components."}
        />
      );
    }
    if (phase === 'placeholder') {
      const state = { height: initial, messages, ...(title !== undefined ? { title } : {}) };
      return (
        <>{options.placeholder ? options.placeholder(state) : <DefaultPlaceholder {...state} />}</>
      );
    }
    return (
      <SandboxWebView
        {...NATIVE_SANDBOX_WEBVIEW_PROPS}
        ref={web}
        key={`${documentPhase}:${generation}`}
        testID="sandbox-frame"
        accessibilityLabel={title ?? 'Interactive view'}
        source={source}
        onMessage={onMessage}
        onNavigationStateChange={onNavigation}
        onRenderProcessGone={onProcessGone}
        onContentProcessDidTerminate={onProcessGone}
        style={[{ width: '100%', height, backgroundColor: 'transparent' }, options.style]}
      />
    );
  }
  return NativeSandboxView;
}

/** The native sandbox renderer with its defaults (theme from nothing, no Tailwind, no kit). */
export const NativeSandboxView: GenuiRenderer<SandboxProps> = createNativeSandboxRenderer();
