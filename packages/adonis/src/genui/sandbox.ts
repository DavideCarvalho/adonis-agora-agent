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
}

/**
 * The bridge every sandbox document starts with: `window.agent.send(values)`, content-height
 * reports, uncaught errors, and — from the host only — `render` (preview redraws) and `run` (one more
 * script). It is the only way out of the frame; the host checks everything it says.
 */
function bridgeScript(token: string, hostOrigin: string): string {
  const t = JSON.stringify(token);
  const o = JSON.stringify(hostOrigin);
  const m = JSON.stringify(SANDBOX_MESSAGE);
  return `(function(){var T=${t},O=${o},M=${m},P=window.parent;
function post(type,data){var msg={type:type,token:T};for(var k in data)msg[k]=data[k];try{P.postMessage(msg,O)}catch(e){}}
window.agent=Object.freeze({send:function(payload){var clean;try{clean=JSON.parse(JSON.stringify(payload===undefined?{}:payload))}catch(e){throw new TypeError('agent.send: the payload must be JSON')}post(M.send,{payload:clean});return true}});
var last=-1;function size(){var b=document.body,d=document.documentElement;var h=Math.ceil(Math.max(b?b.scrollHeight:0,d?d.scrollHeight:0));if(h!==last){last=h;post(M.resize,{height:h})}}
window.addEventListener('error',function(e){post(M.error,{message:String(e&&e.message||'error')})});
window.addEventListener('unhandledrejection',function(e){post(M.error,{message:String(e&&e.reason&&e.reason.message||e&&e.reason||'unhandled rejection')})});
window.addEventListener('message',function(e){if(e.source!==P)return;var d=e.data;if(!d||d.token!==T)return;
if(d.type===M.render){var s=document.getElementById('agora-sandbox-css');if(s)s.textContent=String(d.css||'');document.body.innerHTML=String(d.html||'');size()}
else if(d.type===M.run){var el=document.createElement('script');el.textContent=String(d.code||'');document.body.appendChild(el);size()}});
function start(){size();if(typeof ResizeObserver==='function'){new ResizeObserver(size).observe(document.documentElement)}window.addEventListener('load',size);post(M.ready,{})}
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',start)}else{start()}})();`;
}

const BASE_CSS =
  'html,body{margin:0;padding:0;overflow:hidden;background:transparent}body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;line-height:1.4;color:#1f2328}*,*::before,*::after{box-sizing:border-box}';

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
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`,
    '<meta name="referrer" content="no-referrer">',
    `<script>${bridgeScript(options.token, options.hostOrigin)}</script>`,
    `<style>${BASE_CSS}</style>`,
    `<style id="agora-sandbox-css">${inlineStyle(props.css ?? '')}</style>`,
    '</head><body>',
    html,
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
    if (key === 'html') {
      if (typeof value === 'string') out.html = value;
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
}

/** A sandbox definition: a {@link ComponentDefinition} that carries its {@link SandboxPolicy}. */
export type SandboxDefinition = ComponentDefinition<SandboxProps> & {
  readonly sandbox: SandboxPolicy;
};

function describe(policy: SandboxPolicy, instructions: string | undefined): string {
  const allow = policy.allow ?? {};
  const opened = Object.entries(allow)
    .filter(([, origins]) => origins !== undefined && origins.length > 0)
    .map(([kind, origins]) => `${kind} from ${(origins ?? []).join(', ')}`);
  return [
    'An interactive mini-app you write yourself in HTML, CSS and JavaScript, drawn in an isolated sandbox.',
    'LAST RESORT: use it only when no other component of this catalog can present the answer — a calculator, a small simulation, a bespoke visualization. Tables, charts, KPIs and text go in the catalog components, never here.',
    'Write the fields in this order: initialHeight, placeholderMessages, title, summary, css, html, jsFunctions, jsExpressions.',
    opened.length > 0
      ? `Network: only ${opened.join('; ')}. Everything else (fetch, CDNs, remote fonts) is blocked.`
      : 'No network at all: no fetch, no external scripts, fonts or images — inline SVG and data: URLs only.',
    'No <form> submission (use buttons with click handlers). jsFunctions and each jsExpressions entry run as classic scripts after the HTML, so no top-level await. Validate numeric input (no NaN/Infinity on screen), label units, keep it keyboard-accessible.',
    'To hand values back to the assistant, call agent.send({ text: "<one short sentence the user is saying>", ...values }) from an explicit button click only — never on load, on a timer or on input. It starts a new turn with those values.',
    ...(instructions !== undefined ? [instructions] : []),
  ].join(' ');
}

/**
 * A sandbox component. `streaming: 'partial'`, so in tree mode it draws while the model writes it:
 * a placeholder of `initialHeight`, then the styled markup, then — once the code has closed — the
 * live view.
 *
 * ```ts
 * const catalog = defineCatalog([...myComponents, defineSandbox({ policy: { allow: { images: ['https://tile.openstreetmap.org'] } } })])
 * ```
 */
export function defineSandbox(options: DefineSandboxOptions = {}): SandboxDefinition {
  const policy = options.policy ?? {};
  assertSandboxPolicy(policy);
  const definition = defineComponent<SandboxProps>({
    name: options.name ?? SANDBOX_COMPONENT,
    title: 'Interactive view',
    description: options.description ?? describe(policy, options.instructions),
    props: sandboxSchema,
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
  return Object.freeze({ ...definition, sandbox: Object.freeze({ ...policy }) });
}

/** The builtin sandbox: no network, default limits. */
export const Sandbox: SandboxDefinition = defineSandbox();

/** The sandbox policy a definition carries (`{}` for a component that is not a sandbox). */
export function sandboxPolicyOf(definition: unknown): SandboxPolicy | undefined {
  if (typeof definition !== 'object' || definition === null) return undefined;
  const policy = (definition as { sandbox?: unknown }).sandbox;
  return typeof policy === 'object' && policy !== null ? (policy as SandboxPolicy) : undefined;
}
