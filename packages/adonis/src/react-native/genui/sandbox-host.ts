/**
 * The host side of a sandbox drawn in a `react-native-webview`, as plain functions: what the
 * WebView may load, what it may say, how the host talks back, the theme it gets. No React Native
 * import here — the renderer (`sandbox.tsx`) wires these to the WebView, the tests call them as is.
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  jsonByteLength,
  sandboxAction,
  type UiAction,
  validateUiActionContext,
} from '../../genui/actions.js';
import { SANDBOX_DEFAULTS, SANDBOX_MESSAGE, type SandboxPolicy } from '../../genui/sandbox.js';
import { hostThemeCss, tailwindThemeCss } from '../../genui/sandbox-theme.js';
import type { JsonSchema } from '../../genui/schema.js';
import type { SandboxRefusal } from '../../react/core/genui/sandbox.js';

/**
 * The only URLs the WebView may be at: the inline document (`source={{ html }}` loads as
 * `about:blank`; `about:srcdoc` for engines that name it so), and in-page `#fragment` jumps.
 */
const INLINE_DOCUMENT = /^about:(blank|srcdoc)(#.*)?$/i;

/** Whether a URL is the inline sandbox document itself — everything else is a navigation away. */
export function isInlineDocumentUrl(url: unknown): boolean {
  return typeof url === 'string' && INLINE_DOCUMENT.test(url);
}

/**
 * `onShouldStartLoadWithRequest`: the inline document loads, nothing else does — no link, no
 * `location = …`, no `window.open`, no `tel:` / `mailto:` / app scheme. (Used with an
 * `originWhitelist` that lets every URL through to it: `react-native-webview` hands a URL the
 * whitelist refuses to `Linking.openURL` — the system browser or another app — instead of dropping it.)
 */
export function shouldStartSandboxLoad(request: { url?: unknown }): boolean {
  return isInlineDocumentUrl(request.url);
}

/** Room for the envelope (`type`, `token`, keys) around a payload in one bridge message. */
export const NATIVE_SANDBOX_ENVELOPE_CHARS = 1024;

/** The frame → host message types a host acts on. */
const FRAME_TYPES: ReadonlySet<string> = new Set([
  SANDBOX_MESSAGE.ready,
  SANDBOX_MESSAGE.resize,
  SANDBOX_MESSAGE.send,
  SANDBOX_MESSAGE.error,
]);

export type FrameMessage =
  /** A message with this frame's token, parsed. */
  | { kind: 'message'; data: Record<string, unknown> & { type: string } }
  /** An `agent.send` with this frame's token, too long to even parse (`bytes`: at least). */
  | { kind: 'too-large'; bytes: number }
  /** Anything else — not a string, too long, not JSON, not an object, no or another token. */
  | { kind: 'drop' };

/**
 * Read one `onMessage` string from the WebView. Its length is capped BEFORE it is parsed (the cap
 * is the payload limit plus the envelope: a payload within the limit always fits, as its JSON has at
 * most as many UTF-16 units as UTF-8 bytes); only a JSON object carrying `token` and a frame message
 * type gets through. A send too long to parse is recognised by its envelope's exact prefix — which
 * the bridge writes first — so it is refused as `too-large` rather than dropped unseen.
 */
export function parseFrameMessage(
  raw: unknown,
  token: string,
  maxPayloadBytes: number,
): FrameMessage {
  if (typeof raw !== 'string') return { kind: 'drop' };
  if (raw.length > maxPayloadBytes + NATIVE_SANDBOX_ENVELOPE_CHARS) {
    const prefix = `{"type":${JSON.stringify(SANDBOX_MESSAGE.send)},"token":${JSON.stringify(token)},"payload":`;
    return raw.startsWith(prefix)
      ? { kind: 'too-large', bytes: raw.length - prefix.length - 1 }
      : { kind: 'drop' };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: 'drop' };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { kind: 'drop' };
  const record = data as Record<string, unknown>;
  if (typeof record.token !== 'string' || record.token !== token) return { kind: 'drop' };
  if (typeof record.type !== 'string' || !FRAME_TYPES.has(record.type)) return { kind: 'drop' };
  return { kind: 'message', data: record as Record<string, unknown> & { type: string } };
}

/**
 * The script `injectJavaScript` runs to hand the frame one host message: a `message` event whose
 * `source` is the frame's own window — its `parent` (a top-level document is its own parent), the
 * only source the bridge and the JSX runtime listen to. The message is JSON (as a JS literal; the
 * line separators JSON leaves raw are escaped), never code.
 */
export function hostMessageScript(message: Record<string, unknown>): string {
  const literal = JSON.stringify(message)
    .split(String.fromCharCode(0x2028))
    .join('\\u2028')
    .split(String.fromCharCode(0x2029))
    .join('\\u2029');
  return `(function(){try{window.dispatchEvent(new MessageEvent('message',{data:${literal},source:window}))}catch(e){}})();true;`;
}

/** The frame's height: what it measured, within 24 px and the policy's `maxHeight`. */
export function clampSandboxHeight(value: number, policy: SandboxPolicy): number {
  const max = policy.maxHeight ?? SANDBOX_DEFAULTS.maxHeight;
  return Math.max(24, Math.min(max, Math.ceil(value)));
}

/**
 * The app's design tokens for the frame — what a web host reads off its page's `:root`. `vars` are
 * CSS custom properties (`{ '--primary': '#2563eb' }` or `{ primary: '#2563eb' }`); `dark` sets the
 * frame's `dark` class and `data-theme`; `colorScheme` (`'dark'`, `'light dark'`) is mirrored as
 * `color-scheme` when given.
 */
export interface NativeSandboxTheme {
  vars: Record<string, string>;
  dark?: boolean;
  colorScheme?: string;
}

/** The theme as the frame takes it: `:root{…}`, light/dark, and Tailwind's `@theme` for it. */
export interface NativeThemeCss {
  css: string;
  dark: boolean;
  tailwind: string;
}

const VAR_NAME = /^--[A-Za-z0-9_-]+$/;

/** `vars` keyed `--name` (a bare `name` gets its dashes), invalid names and non-strings dropped. */
export function normalizeThemeVars(vars: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    const name = key.startsWith('--') ? key : `--${key}`;
    if (!VAR_NAME.test(name)) continue;
    if (typeof value === 'number') out[name] = String(value);
    else if (typeof value === 'string' && value.trim() !== '') out[name] = value.trim();
  }
  return out;
}

export function nativeThemeCss(theme: NativeSandboxTheme): NativeThemeCss {
  const vars = normalizeThemeVars(theme.vars ?? {});
  return {
    css: hostThemeCss(
      vars,
      theme.colorScheme !== undefined ? { colorScheme: theme.colorScheme } : {},
    ),
    dark: theme.dark === true,
    tailwind: tailwindThemeCss(vars),
  };
}

/**
 * A url the config names, made absolute against `baseUrl` (React Native has no page origin to
 * resolve it against). Only `http:` / `https:` come out; anything else, or a relative url without
 * an absolute `baseUrl`, is `undefined`.
 */
export function resolveSandboxUrl(url: string, baseUrl: string | undefined): string | undefined {
  const absolute = /^https?:\/\/[^/?#]+/i;
  if (absolute.test(url)) return url;
  if (baseUrl === undefined) return undefined;
  const base = absolute.exec(baseUrl);
  if (base === null) return undefined;
  const origin = base[0];
  if (url.startsWith('//')) {
    const out = `${origin.slice(0, origin.indexOf(':'))}:${url}`;
    return absolute.test(out) ? out : undefined;
  }
  if (url.startsWith('/')) return `${origin}${url}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return undefined;
  const path = baseUrl.slice(origin.length).replace(/[?#].*$/, '');
  const directory = path.endsWith('/') ? path : path.replace(/[^/]*$/, '') || '/';
  return `${origin}${directory.startsWith('/') ? '' : '/'}${directory}${url}`;
}

/** The count and time of the accepted sends of one frame. */
export interface SendState {
  count: number;
  last: number;
}

export interface SendCheck {
  payload: unknown;
  state: SendState;
  policy: SandboxPolicy;
  /** The view is still being written: what it sends is not the user's yet. */
  incomplete: boolean;
  schema?: StandardSchemaV1 | JsonSchema;
  confirm?: (action: UiAction) => boolean | Promise<boolean>;
  hasHandler: boolean;
  componentId?: string;
  title?: string;
  now?: number;
}

/**
 * Everything the web host checks an `agent.send` for, in its order: a preview's send declined, the
 * count, the interval, JSON, the size, `schema`, `confirm`, a handler. The interval clock starts at
 * a send that passed the size check; the count grows only for a delivered action.
 */
export async function checkSandboxSend(
  check: SendCheck,
): Promise<{ ok: true; action: UiAction } | { ok: false; refusal: SandboxRefusal }> {
  const { state, policy } = check;
  if (check.incomplete) return { ok: false, refusal: { reason: 'declined' } };
  const maxSends = policy.maxSends ?? SANDBOX_DEFAULTS.maxSends;
  if (state.count >= maxSends)
    return { ok: false, refusal: { reason: 'too-many', limit: maxSends } };
  const now = check.now ?? Date.now();
  const interval = policy.minSendIntervalMs ?? SANDBOX_DEFAULTS.minSendIntervalMs;
  if (state.last > 0 && now - state.last < interval) {
    return { ok: false, refusal: { reason: 'too-soon', waitMs: interval - (now - state.last) } };
  }
  const bytes = jsonByteLength(check.payload);
  if (bytes === undefined) return { ok: false, refusal: { reason: 'not-json' } };
  const limit = policy.maxPayloadBytes ?? SANDBOX_DEFAULTS.maxPayloadBytes;
  if (bytes > limit) return { ok: false, refusal: { reason: 'too-large', bytes, limit } };
  state.last = now;
  let action = sandboxAction(check.payload, {
    ...(check.componentId !== undefined ? { componentId: check.componentId } : {}),
    ...(check.title !== undefined ? { title: check.title } : {}),
  });
  if (check.schema !== undefined) {
    const checked = await validateUiActionContext(action, check.schema);
    if (!checked.ok) return { ok: false, refusal: { reason: 'invalid', issues: checked.issues } };
    action = { ...action, context: checked.context };
  }
  if (check.confirm !== undefined && !(await check.confirm(action))) {
    return { ok: false, refusal: { reason: 'declined' } };
  }
  if (!check.hasHandler) return { ok: false, refusal: { reason: 'no-handler' } };
  state.count += 1;
  return { ok: true, action };
}

/** A per-frame token. Not a secret from the frame's own code — it tells this frame's messages apart. */
export function sandboxToken(): string {
  const bytes = new Uint8Array(16);
  const crypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => void } })
    .crypto;
  if (typeof crypto?.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else
    for (let index = 0; index < bytes.length; index++)
      bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
