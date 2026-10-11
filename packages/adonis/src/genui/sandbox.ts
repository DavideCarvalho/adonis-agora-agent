/**
 * Sandboxed generated UI: a catalog component whose props are HTML, CSS and JavaScript the model
 * writes for a one-off interactive answer (a calculator, a small simulation, a bespoke chart) when
 * no catalog component fits. Opt-in — add {@link Sandbox} (or {@link defineSandbox}`({ … })`) to a
 * catalog, or pass `sandbox: true` to `genui({ … })`.
 *
 * Everything here is framework-free and isomorphic: the server uses the definition (description,
 * schema, text fallback, streaming trim), the browser renderer uses the same policy to build the
 * iframe document and to check what the frame sends back.
 */
import { type ComponentDefinition, defineComponent } from './catalog.js';
import {
  kitDocsToModelText,
  kitHtmlInstructions,
  kitJsxInstructions,
  type SandboxKitDocs,
  sandboxJsxRuntime,
} from './sandbox-kit.js';
import { tailwindToModelText, vocabularyToModelText } from './sandbox-styles.js';
import { themeTokens, themeToModelText } from './sandbox-theme.js';
import type { JsonSchema } from './schema.js';

/** The component name the builtin {@link Sandbox} registers under. */
export const SANDBOX_COMPONENT = 'Sandbox';

/** The props a model writes, in the order it writes them (see {@link SANDBOX_FIELD_ORDER}). */
export interface SandboxProps {
  /** Height in CSS pixels to reserve while the code streams. The frame then sizes to its content. */
  initialHeight?: number;
  /** Short lines shown in the placeholder while the code streams ("Setting up the calculator…"). */
  placeholderMessages?: string[];
  /** A short title, for the frame's accessible name and for text-only clients. */
  title?: string;
  /** One or two sentences on what the view shows — what a client that cannot run it prints. */
  summary?: string;
  /** Styles, injected in a `<style>` before the HTML. */
  css?: string;
  /** The body markup. No `<script src>` (no network); inline `<script>` runs once the view is live. */
  html?: string;
  /** Function declarations, run once as one classic script after the HTML. */
  jsFunctions?: string;
  /** Statements run in order after `jsFunctions`, each as its own classic script (no top-level await). */
  jsExpressions?: string[];
  /**
   * The view as JSX using the app's kit (`sandbox({ kit })`): plain JavaScript + JSX defining
   * `function App()`, compiled and rendered in the frame. Drawn as it streams, once it parses.
   */
  jsx?: string;
}

/**
 * The order the fields stream in, and the order the renderer uses them: a placeholder of the right
 * height first, then the styles (so the markup never draws unstyled), the markup, and the behavior
 * last — the same sequence as CopilotKit's Open Generative UI.
 */
export const SANDBOX_FIELD_ORDER = [
  'initialHeight',
  'placeholderMessages',
  'title',
  'summary',
  'css',
  'html',
  'jsFunctions',
  'jsExpressions',
  'jsx',
] as const;

/**
 * Who the sandbox may reach and how much it may send back. The DEFAULT IS NO NETWORK AT ALL: no
 * fetch, no external script, style, font, image or media — only inline code and `data:`/`blob:`
 * URLs. List origins (`https://tile.openstreetmap.org`, or `https://*.tile.openstreetmap.org`) per
 * kind to open exactly those.
 */
export interface SandboxPolicy {
  allow?: {
    /** `img-src` (map tiles, photos). */
    images?: readonly string[];
    /** `connect-src` (`fetch`, `XMLHttpRequest`, `WebSocket`). */
    connect?: readonly string[];
    /** `script-src` (a charting library from a CDN). */
    scripts?: readonly string[];
    /** `style-src`. */
    styles?: readonly string[];
    /** `font-src`. */
    fonts?: readonly string[];
    /** `media-src`. */
    media?: readonly string[];
  };
  /** Largest `agent.send(…)` payload accepted, as JSON, in bytes. Default 8192. */
  maxPayloadBytes?: number;
  /** Least time between two accepted sends from one view, in ms. Default 1000. */
  minSendIntervalMs?: number;
  /** Most sends one view may make. Default 20. */
  maxSends?: number;
  /** Tallest the frame may grow, in CSS pixels. Default 1600. */
  maxHeight?: number;
}

export const SANDBOX_DEFAULTS = {
  initialHeight: 240,
  maxPayloadBytes: 8192,
  minSendIntervalMs: 1000,
  maxSends: 20,
  maxHeight: 1600,
} as const;

const ORIGIN = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/i;

/** Throws unless every listed origin is a bare `https://host[:port]` (or `https://*.host`). */
export function assertSandboxPolicy(policy: SandboxPolicy): void {
  for (const [kind, origins] of Object.entries(policy.allow ?? {})) {
    for (const origin of origins ?? []) {
      if (typeof origin !== 'string' || !ORIGIN.test(origin)) {
        throw new TypeError(
          `genui sandbox: allow.${kind} entry "${String(origin)}" is not an https origin (https://host[:port] or https://*.host)`,
        );
      }
    }
  }
  for (const key of ['maxPayloadBytes', 'minSendIntervalMs', 'maxSends', 'maxHeight'] as const) {
    const value = policy[key];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new RangeError(`genui sandbox: ${key} must be a non-negative number`);
    }
  }
}

/**
 * The Content-Security-Policy every sandbox document carries (as a `<meta>`, first thing in its
 * head). Inline scripts and styles run — they ARE the generated UI — but nothing else loads, no
 * form posts and no navigation of the frame's base, unless the policy lists an origin.
 */
export function sandboxCsp(policy: SandboxPolicy = {}): string {
  assertSandboxPolicy(policy);
  const allow = policy.allow ?? {};
  const list = (origins: readonly string[] | undefined) =>
    origins !== undefined && origins.length > 0 ? ` ${origins.join(' ')}` : '';
  const connect = allow.connect !== undefined && allow.connect.length > 0;
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline'${list(allow.scripts)}`,
    `style-src 'unsafe-inline'${list(allow.styles)}`,
    `img-src data: blob:${list(allow.images)}`,
    `font-src data:${list(allow.fonts)}`,
    `media-src data: blob:${list(allow.media)}`,
    connect ? `connect-src${list(allow.connect)}` : "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** The `sandbox` attribute of the frame: scripts, and nothing else — above all no `allow-same-origin`. */
export const SANDBOX_IFRAME_FLAGS = 'allow-scripts';

/** The type tags of the messages a sandbox frame and its host exchange. */
export const SANDBOX_MESSAGE = {
  /** frame → host: the bridge is up. */
  ready: 'agora:sandbox:ready',
  /** frame → host: `{ height }` — the content's height. */
  resize: 'agora:sandbox:resize',
  /** frame → host: `{ payload }` — `agent.send(payload)`. */
  send: 'agora:sandbox:send',
  /** frame → host: `{ message }` — an uncaught error in the generated code. */
  error: 'agora:sandbox:error',
  /** host → frame: `{ css, html }` — redraw the preview (no scripts run). */
  render: 'agora:sandbox:render',
  /** host → frame: `{ code }` — run one more classic script. */
  run: 'agora:sandbox:run',
  /** host → frame: `{ css, dark }` — the host's theme changed (light/dark, a new stylesheet). */
  theme: 'agora:sandbox:theme',
  /** host → frame: `{ code, final }` — the JSX so far (`final` once the model is done). */
  jsx: 'agora:sandbox:jsx',
} as const;

/** `</script` inside generated code would close the element it is inlined in. */
function inlineScript(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

function inlineStyle(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export interface SandboxDocumentOptions {
  /** A per-frame value every bridge message carries, so the host can tell this frame's messages apart. */
  token: string;
  /**
   * Where the bridge posts its messages (the host page's origin). The frame's own origin is opaque
   * (`null`): it can address its parent, never be addressed by name.
   */
  hostOrigin: string;
  policy?: SandboxPolicy;
  /**
   * `'preview'`: CSS + markup only, scripts stripped; the host redraws it with `render` messages
   * while the model writes. `'live'`: the whole view, its inline scripts and `jsFunctions` /
   * `jsExpressions` included.
   */
  mode: 'preview' | 'live';
  /** Run the JavaScript fields inline (`live` only). Default true; false when the host streams them in with `run`. */
  inlineJs?: boolean;
  /**
   * The host's theme (`hostThemeCss(collectHostThemeVars(document), dark)`): put on the frame's
   * `:root`, and kept current with `theme` messages. `dark` mirrors the host's `dark` class;
   * `attributes`, its light/dark attributes (`data-theme`, `data-bs-theme`…).
   */
  theme?: { css: string; dark: boolean; attributes?: Record<string, string> };
  /** The app's compiled styles (`genuiSandboxKit({ styles })`), before the theme and the model's CSS. */
  styles?: string;
  /** Tailwind: the `@tailwindcss/browser` runtime source, and the `@theme` mapping the host's variables. */
  tailwind?: { runtime: string; theme?: string };
  /**
   * The kit bundle's source (an IIFE setting `window.Kit`, `React`, `ReactDOM`): inlined, and the JSX
   * runtime with it — the frame then draws `jsx` (posted with `jsx` messages, or `initialJsx`).
   */
  kit?: string;
  /** JSX to draw as soon as the document loads (a whole view: `final: true`). */
  initialJsx?: { code: string; final: boolean };
  /**
   * How the bridge reaches its host. `'parent'` (default): `parent.postMessage` to `hostOrigin`, an
   * iframe in a page. `'react-native'`: `window.ReactNativeWebView.postMessage(JSON)`, the document
   * as a `react-native-webview` source (`hostOrigin` unused), with a device-width viewport. The host
   * talks back the same way either way — `message` events whose `source` is the frame's parent.
   */
  transport?: 'parent' | 'react-native';
}

/**
 * The bridge every sandbox document starts with: `window.agent.send(values)`, content-height
 * reports, uncaught errors, and — from the host only — `render` (preview redraws) and `run` (one more
 * script). It is the only way out of the frame; the host checks everything it says.
 *
 * The height it reports is the CONTENT's — the bottom of what the body holds, margins included —
 * never `scrollHeight`, which does not drop below the frame's own height: a frame mounted at the
 * model's `initialHeight` would otherwise keep that height (an empty gap under a short view) and
 * could only ever grow. It re-measures on every resize of the page or of a top-level element, on
 * every DOM or style change (the Tailwind runtime injecting its CSS, the kit drawing JSX), once
 * fonts and images load, and twice more shortly after start; the first measure rides `ready`.
 */
function bridgeScript(
  token: string,
  hostOrigin: string,
  transport: 'parent' | 'react-native' = 'parent',
): string {
  const t = JSON.stringify(token);
  const o = JSON.stringify(hostOrigin);
  const m = JSON.stringify(SANDBOX_MESSAGE);
  const native = transport === 'react-native';
  const deliver = native
    ? '(R||window.ReactNativeWebView).postMessage(JSON.stringify(msg))'
    : 'P.postMessage(msg,O)';
  return `(function(){var T=${t},O=${o},M=${m},P=window.parent${native ? ',R=window.ReactNativeWebView' : ''};
function post(type,data){var msg={type:type,token:T};for(var k in data)msg[k]=data[k];try{${deliver}}catch(e){}}
window.agent=Object.freeze({send:function(payload){var clean;try{clean=JSON.parse(JSON.stringify(payload===undefined?{}:payload))}catch(e){throw new TypeError('agent.send: the payload must be JSON')}post(M.send,{payload:clean});return true}});
var last=-1,queued=false;
function measure(){var b=document.body;if(!b)return 0;var bottom=0;try{var r=document.createRange();r.selectNodeContents(b);bottom=r.getBoundingClientRect().bottom}catch(e){}
var kids=b.children;for(var i=0;i<kids.length;i++){var k=kids[i];if(k.tagName==='SCRIPT'||k.tagName==='STYLE')continue;var cs=getComputedStyle(k);if(cs.display==='none'||cs.position==='fixed')continue;var kb=k.getBoundingClientRect().bottom+(parseFloat(cs.marginBottom)||0);if(kb>bottom)bottom=kb}
var bs=getComputedStyle(b);bottom+=(parseFloat(bs.paddingBottom)||0)+(parseFloat(bs.borderBottomWidth)||0);return Math.max(0,Math.ceil(bottom+(window.scrollY||0)))}
function size(){queued=false;var h=measure();if(h!==last){last=h;post(M.resize,{height:h})}}
function later(){if(queued)return;queued=true;if(typeof requestAnimationFrame==='function'){requestAnimationFrame(size)}else{setTimeout(size,16)}}
window.addEventListener('error',function(e){if(window.__agoraQuiet)return;post(M.error,{message:String(e&&e.message||'error')})});
window.addEventListener('unhandledrejection',function(e){post(M.error,{message:String(e&&e.reason&&e.reason.message||e&&e.reason||'unhandled rejection')})});
window.addEventListener('message',function(e){if(e.source!==P)return;var d=e.data;if(!d||d.token!==T)return;
if(d.type===M.render){var s=document.getElementById('agora-sandbox-css');if(s)s.textContent=String(d.css||'');document.body.innerHTML=String(d.html||'');size()}
else if(d.type===M.run){var el=document.createElement('script');el.textContent=String(d.code||'');document.body.appendChild(el);size()}
else if(d.type===M.theme){var th=document.getElementById('agora-sandbox-theme');if(th)th.textContent=String(d.css||'');var de=document.documentElement;de.classList.toggle('dark',d.dark===true);var at=d.attributes&&typeof d.attributes==='object'?d.attributes:{};
for(var i=de.attributes.length-1;i>=0;i--){var an=de.attributes[i].name;if(/^data-([\\w-]*-)?(theme|mode|scheme)$/.test(an)&&!(an in at))de.removeAttribute(an)}
for(var k in at){if(/^data-([\\w-]*-)?(theme|mode|scheme)$/.test(k))de.setAttribute(k,String(at[k]))}if(!('data-theme' in at))de.setAttribute('data-theme',d.dark===true?'dark':'light');size()}});
function start(){size();var d=document.documentElement,b=document.body;
var ro=null;if(typeof ResizeObserver==='function'){ro=new ResizeObserver(later);ro.observe(d);if(b){ro.observe(b);for(var i=0;i<b.children.length;i++)ro.observe(b.children[i])}}
if(typeof MutationObserver==='function'){new MutationObserver(function(list){if(ro){for(var i=0;i<list.length;i++){var added=list[i].addedNodes;for(var j=0;j<added.length;j++){if(added[j].nodeType===1&&added[j].parentNode===document.body)ro.observe(added[j])}}}later()}).observe(d,{childList:true,subtree:true,attributes:true,characterData:true})}
window.addEventListener('load',later);document.addEventListener('load',later,true);
if(document.fonts){if(document.fonts.ready)document.fonts.ready.then(later,function(){});if(document.fonts.addEventListener)document.fonts.addEventListener('loadingdone',later)}
setTimeout(later,250);setTimeout(later,1000);post(M.ready,{height:last})}
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',start)}else{start()}})();`;
}

const BASE_CSS =
  'html,body{margin:0;padding:0;overflow:hidden;background:transparent}body{font-family:var(--font-sans,system-ui,-apple-system,"Segoe UI",sans-serif);font-size:14px;line-height:1.4;color:var(--foreground,#1f2328)}*,*::before,*::after{box-sizing:border-box}';

/** The frame root's attributes: the host's mode (`class="dark"`, `data-theme`, `data-bs-theme`…). */
function rootAttributes(theme: SandboxDocumentOptions['theme']): string {
  if (theme === undefined) return '';
  const attributes: Record<string, string> = { 'data-theme': theme.dark ? 'dark' : 'light' };
  for (const [name, value] of Object.entries(theme.attributes ?? {})) {
    if (/^data-([\w-]*-)?(theme|mode|scheme)$/.test(name)) attributes[name] = value;
  }
  return `${theme.dark ? ' class="dark"' : ''}${Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join('')}`;
}

/**
 * The `srcdoc` of a sandbox frame. The CSP `<meta>` comes first, then the bridge, the base styles and
 * the model's CSS, then its markup — and, live, its `jsFunctions` and each `jsExpressions` entry as
 * classic scripts, in that order.
 */
export function buildSandboxDocument(props: SandboxProps, options: SandboxDocumentOptions): string {
  const csp = sandboxCsp(options.policy);
  const live = options.mode === 'live';
  const html = live ? (props.html ?? '') : previewHtml(props.html ?? '');
  const scripts: string[] = [];
  if (live && options.inlineJs !== false) {
    if (props.jsFunctions !== undefined && props.jsFunctions.trim().length > 0) {
      scripts.push(props.jsFunctions);
    }
    for (const expression of props.jsExpressions ?? []) {
      if (typeof expression === 'string' && expression.trim().length > 0) scripts.push(expression);
    }
  }
  const kit = options.kit !== undefined;
  return [
    `<!doctype html><html${rootAttributes(options.theme)}><head><meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`,
    '<meta name="referrer" content="no-referrer">',
    ...(options.transport === 'react-native'
      ? ['<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">']
      : []),
    `<script>${bridgeScript(options.token, options.hostOrigin, options.transport)}</script>`,
    `<style>${BASE_CSS}</style>`,
    ...(options.styles !== undefined && options.styles !== ''
      ? [`<style id="agora-sandbox-kit-css">${inlineStyle(options.styles)}</style>`]
      : []),
    `<style id="agora-sandbox-theme">${inlineStyle(options.theme?.css ?? '')}</style>`,
    ...(options.tailwind !== undefined
      ? [
          `<style type="text/tailwindcss" id="agora-sandbox-tw">${inlineStyle(options.tailwind.theme ?? '')}</style>`,
          `<script>${inlineScript(options.tailwind.runtime)}</script>`,
        ]
      : []),
    `<style id="agora-sandbox-css">${inlineStyle(props.css ?? '')}</style>`,
    '</head><body>',
    html,
    ...(kit
      ? [
          '<div id="agora-sandbox-root"></div>',
          `<script>${inlineScript(options.kit as string)}</script>`,
          `<script>${inlineScript(
            sandboxJsxRuntime({
              token: options.token,
              jsxMessage: SANDBOX_MESSAGE.jsx,
              ...(options.initialJsx !== undefined ? { initial: options.initialJsx } : {}),
            }),
          )}</script>`,
        ]
      : []),
    ...scripts.map((code) => `<script>${inlineScript(code)}</script>`),
    '</body></html>',
  ].join('');
}

/**
 * Markup the model is still writing, made safe to draw as a preview: the half-written tag at the end
 * dropped, `<script>`/`<style>`/`<head>` blocks (whole or cut off) removed, a cut-off entity dropped,
 * and only what is inside `<body>` kept.
 */
export function previewHtml(html: string): string {
  let result = html;
  result = result.replace(/<[^>]*$/, '');
  result = result.replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  result = result.replace(/<(style|script|head)\b[^>]*>[\s\S]*$/gi, '');
  result = result.replace(/&[a-zA-Z0-9#]*$/, '');
  const body = result.match(/<body[^>]*>([\s\S]*)/i);
  if (body !== null) result = (body[1] ?? '').replace(/<\/body>[\s\S]*/i, '');
  return result;
}

/**
 * Sandbox props as they are while the model writes them: only what may be shown or run. CSS and
 * `jsFunctions` are held until their string closes, a `jsExpressions` entry until it closes (code is
 * never run half written), a half-written placeholder line is dropped; the markup streams as it is.
 */
export function sandboxPartialProps(
  props: Record<string, unknown>,
  input: { isOpen(container: object): boolean; pendingMember(container: object): unknown },
): Record<string, unknown> {
  const pending = input.pendingMember(props);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === 'css' || key === 'jsFunctions' || key === 'title' || key === 'summary') {
      if (pending !== key && typeof value === 'string') out[key] = value;
      continue;
    }
    if (key === 'html' || key === 'jsx') {
      if (typeof value === 'string') out[key] = value;
      continue;
    }
    if (key === 'initialHeight') {
      if (pending !== key && typeof value === 'number') out.initialHeight = value;
      continue;
    }
    if (key === 'placeholderMessages' || key === 'jsExpressions') {
      if (!Array.isArray(value)) continue;
      const open = input.isOpen(value);
      const cut = open ? input.pendingMember(value) : undefined;
      out[key] = value.filter(
        (item, index) => typeof item === 'string' && !(open && cut === index),
      );
    }
  }
  return out;
}

const sandboxSchema: JsonSchema = {
  type: 'object',
  properties: {
    initialHeight: {
      type: 'integer',
      minimum: 40,
      maximum: 2000,
      description: 'Height in px to reserve while the code streams. Write it FIRST.',
    },
    placeholderMessages: {
      type: 'array',
      items: { type: 'string', maxLength: 120 },
      maxItems: 5,
      description: 'One to three short loading lines shown while the code streams.',
    },
    title: { type: 'string', maxLength: 120, description: 'Short title of the view.' },
    summary: {
      type: 'string',
      maxLength: 600,
      description: 'One or two sentences describing the view, for clients that cannot run it.',
    },
    css: { type: 'string', maxLength: 60000, description: 'Styles (no @import of remote URLs).' },
    html: {
      type: 'string',
      maxLength: 120000,
      description: 'Body markup. Inline SVG for graphics. No <form> submission, no <script src>.',
    },
    jsFunctions: {
      type: 'string',
      maxLength: 120000,
      description: 'Function declarations, run once after the HTML as a classic script.',
    },
    jsExpressions: {
      type: 'array',
      items: { type: 'string', maxLength: 20000 },
      maxItems: 50,
      description: 'Statements run in order after jsFunctions (wire up listeners, first render).',
    },
  },
  required: ['html'],
  additionalProperties: false,
};

/**
 * Where the kit's docs come from: the docs themselves, or a function read each time the model is
 * told about the sandbox (dev: the Vite plugin rewrites them as the components change).
 */
export type SandboxKitSource = SandboxKitDocs | (() => SandboxKitDocs | undefined);

/** Where the theme's variable names (for the prompt) come from — the same shapes as the kit. */
export type SandboxThemeSource =
  | Record<string, string>
  | readonly string[]
  | (() => Record<string, string> | readonly string[] | undefined);

export interface DefineSandboxOptions {
  /** Component name. Default `Sandbox`. */
  name?: string;
  /** Replaces the model-facing description (keep the "last resort" rule in it). */
  description?: string;
  /** Extra rules appended to the description (house style, what the app wants from it). */
  instructions?: string;
  /** Network allowances and send limits; also what the renderer enforces by default. */
  policy?: SandboxPolicy;
  version?: number;
  /**
   * The app's theme in the frame: the renderer reads the host page's CSS custom properties from
   * `:root` and puts them on the frame's (and follows light/dark changes). Default `'inherit'` (on);
   * `false` turns it off. `vars` names them for the model (the Vite plugin finds them on its own).
   */
  theme?: boolean | 'inherit' | { vars?: SandboxThemeSource };
  /**
   * The app's design system in the frame — whatever `genuiSandboxKit()` built: its compiled styles
   * (fonts and images inlined), the Tailwind runtime with the app's theme when the styles use
   * Tailwind, its components and wrapper (the model then writes `jsx`). What the model is told is
   * read from the docs: components and props, Tailwind tokens or the CSS class vocabulary, the
   * theme's variables, `stylesDocs`. `true`: the server's `sandbox({ kit: true })` finds them
   * through Vite; or pass the docs (or a function returning them) yourself.
   */
  kit?: boolean | SandboxKitSource;
}

/** How a sandbox draws: theme and kit on or off. */
export interface SandboxView {
  theme: boolean;
  kit: boolean;
}

/** A sandbox definition: a {@link ComponentDefinition} that carries its {@link SandboxPolicy}. */
export type SandboxDefinition = ComponentDefinition<SandboxProps> & {
  readonly sandbox: SandboxPolicy;
  /** Theme and kit, as the definition was given them. */
  readonly sandboxView?: SandboxView;
  /** The options it was defined with — what a server resolves the kit for. */
  readonly sandboxOptions?: Readonly<DefineSandboxOptions>;
};

function resolveSource<T>(source: T | (() => T | undefined) | undefined): T | undefined {
  return typeof source === 'function' ? (source as () => T | undefined)() : source;
}

function describe(policy: SandboxPolicy, options: DefineSandboxOptions): string {
  const allow = policy.allow ?? {};
  const opened = Object.entries(allow)
    .filter(([, origins]) => origins !== undefined && origins.length > 0)
    .map(([kind, origins]) => `${kind} from ${(origins ?? []).join(', ')}`);
  const kitOn = options.kit !== undefined && options.kit !== false;
  const docs =
    kitOn && options.kit !== true ? resolveSource(options.kit as SandboxKitSource) : undefined;
  // JSX only when a kit bundle exists (docs say so) — never on the promise of one.
  const jsx = docs?.jsx === true;
  const components = docs?.components ?? [];
  const themeOn = options.theme !== false;
  const themeVars =
    typeof options.theme === 'object'
      ? resolveSource(options.theme.vars)
      : (docs?.theme?.vars ?? undefined);
  return [
    jsx
      ? `An interactive mini-app you write yourself — JSX${components.length > 0 ? " with the app's own components" : ''}, or HTML, CSS and JavaScript — drawn in an isolated sandbox${docs?.tailwind !== undefined || docs?.vocabulary !== undefined ? " in the app's own styles" : ''}.`
      : `An interactive mini-app you write yourself in HTML, CSS and JavaScript, drawn in an isolated sandbox${docs?.tailwind !== undefined || docs?.vocabulary !== undefined ? " in the app's own styles" : ''}.`,
    'LAST RESORT: use it only when no other component of this catalog can present the answer — a calculator, a small simulation, a bespoke visualization. Tables, charts, KPIs and text go in the catalog components, never here.',
    jsx
      ? 'Write the fields in this order: initialHeight, placeholderMessages, title, summary, css (optional), jsx — or html, jsFunctions, jsExpressions instead of jsx.'
      : 'Write the fields in this order: initialHeight, placeholderMessages, title, summary, css, html, jsFunctions, jsExpressions.',
    opened.length > 0
      ? `Network: only ${opened.join('; ')}. Everything else (fetch, CDNs, remote fonts) is blocked.`
      : 'No network at all: no fetch, no external scripts, fonts or images — inline SVG and data: URLs only.',
    'No <form> submission (use buttons with click handlers). jsFunctions and each jsExpressions entry run as classic scripts after the HTML, so no top-level await. Validate numeric input (no NaN/Infinity on screen), label units, keep it keyboard-accessible.',
    'To hand values back to the assistant, call agent.send({ text: "<one short sentence the user is saying>", ...values }) from an explicit button click only — never on load, on a timer or on input. It starts a new turn with those values.',
    ...(themeOn ? [themeToModelText(themeVars)] : []),
    ...(docs?.tailwind !== undefined
      ? [
          tailwindToModelText(docs.tailwind.tokens, {
            version: docs.tailwind.version,
            ...(themeOn ? { colors: themeTokens(themeVars ?? []).colors } : {}),
          }),
        ]
      : []),
    ...(docs?.tailwind === undefined &&
    docs?.vocabulary !== undefined &&
    docs.vocabulary.groups.length > 0
      ? [`\n${vocabularyToModelText(docs.vocabulary, { jsx })}\n`]
      : []),
    ...(jsx
      ? [kitJsxInstructions({ components: components.length > 0, wrapper: docs?.wrapper === true })]
      : []),
    ...(kitOn && docs !== undefined && !jsx ? [kitHtmlInstructions()] : []),
    ...(jsx && components.length > 0 ? [`\n${kitDocsToModelText(docs as SandboxKitDocs)}`] : []),
    ...(docs?.guide !== undefined && docs.guide.trim() !== ''
      ? [`\nThe app's notes on its styles:\n${docs.guide.trim()}`]
      : []),
    ...(options.instructions !== undefined ? [options.instructions] : []),
  ].join(' ');
}

const jsxSchema: JsonSchema = {
  type: 'string',
  maxLength: 120000,
  description:
    'The view as JSX: plain JavaScript + JSX defining function App() (no imports, no TypeScript). Kit components and React hooks are in scope. Write it LAST.',
};

/**
 * A sandbox component. `streaming: 'partial'`, so in tree mode it draws while the model writes it:
 * a placeholder of `initialHeight`, then the styled markup, then — once the code has closed — the
 * live view. With a kit, JSX draws as it streams, each time what has arrived parses.
 *
 * ```ts
 * const catalog = defineCatalog([...myComponents, defineSandbox({ policy: { allow: { images: ['https://tile.openstreetmap.org'] } } })])
 * ```
 */
export function defineSandbox(options: DefineSandboxOptions = {}): SandboxDefinition {
  if ((options as { tailwind?: unknown }).tailwind !== undefined) {
    throw new TypeError(
      'defineSandbox: `tailwind` was removed in 0.75. `kit: true` turns on whatever genuiSandboxKit() produced — Tailwind included, detected from its `styles`. Replace `{ tailwind: true, kit: true }` with `{ kit: true }` (and pass your Tailwind stylesheet as genuiSandboxKit({ styles })).',
    );
  }
  const policy = options.policy ?? {};
  assertSandboxPolicy(policy);
  const kitOn = options.kit !== undefined && options.kit !== false;
  const withJsx: JsonSchema = {
    ...sandboxSchema,
    properties: { ...(sandboxSchema.properties as Record<string, unknown>), jsx: jsxSchema },
    required: [],
  };
  const props: JsonSchema = kitOn ? withJsx : sandboxSchema;
  // With the kit's docs (a server resolving `kit: true`, or docs given), the schema offers `jsx` only
  // when the kit has a bundle to draw it with: a stylesheet-only kit is written as html.
  const docsSource = kitOn && options.kit !== true ? (options.kit as SandboxKitSource) : undefined;
  const definition = defineComponent<SandboxProps>({
    name: options.name ?? SANDBOX_COMPONENT,
    title: 'Interactive view',
    description: '',
    props,
    streaming: 'partial',
    partialProps: sandboxPartialProps,
    ...(options.version !== undefined ? { version: options.version } : {}),
    fallbackText: (props) => {
      const title = typeof props.title === 'string' && props.title.length > 0 ? props.title : '';
      const summary =
        typeof props.summary === 'string' && props.summary.length > 0
          ? props.summary
          : 'An interactive view';
      return `${title ? `*${title}*\n` : ''}${summary} (interactive — open the app to use it)`;
    },
  });
  const sandboxView: SandboxView = {
    theme: options.theme !== false,
    kit: kitOn,
  };
  const result = {
    ...definition,
    sandbox: Object.freeze({ ...policy }),
    sandboxView,
    sandboxOptions: Object.freeze({ ...options }),
  };
  // Read each time: the kit's docs (and the theme's names) may change while the app runs (dev).
  Object.defineProperty(result, 'description', {
    enumerable: true,
    get: () => options.description ?? describe(policy, options),
  });
  if (docsSource !== undefined) {
    Object.defineProperty(result, 'props', {
      enumerable: true,
      get: () => (resolveSource(docsSource)?.jsx === true ? withJsx : sandboxSchema),
    });
  }
  return Object.freeze(result) as SandboxDefinition;
}

/**
 * Whether a sandbox's props draw as JSX (the kit) or as HTML. A model under strict tool calling
 * (OpenAI's) fills every property, so it may write a whole view in one field and a stub in the
 * other (`function App() { return null }` next to the real `html`): the field that holds the view —
 * the longer one — wins. JSX only when it has something in it.
 */
export function sandboxDrawsJsx(props: Pick<SandboxProps, 'jsx' | 'html'>): boolean {
  const jsx = typeof props.jsx === 'string' ? props.jsx.trim() : '';
  if (jsx === '') return false;
  const html = typeof props.html === 'string' ? props.html.trim() : '';
  return jsx.length >= html.length;
}

/** The builtin sandbox: no network, default limits. */
export const Sandbox: SandboxDefinition = defineSandbox();

/** The sandbox policy a definition carries (`{}` for a component that is not a sandbox). */
export function sandboxPolicyOf(definition: unknown): SandboxPolicy | undefined {
  if (typeof definition !== 'object' || definition === null) return undefined;
  const policy = (definition as { sandbox?: unknown }).sandbox;
  return typeof policy === 'object' && policy !== null ? (policy as SandboxPolicy) : undefined;
}
