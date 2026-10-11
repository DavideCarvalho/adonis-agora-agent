/**
 * The theme / Tailwind / kit settings and assets of a React Native sandbox. A web host reads them
 * from its own origin (`GET /agent/config`, then the asset urls it names); an app has no origin, so
 * it passes them in, or names the agent by an absolute `baseUrl` — relative urls resolve against it.
 */
import { useEffect, useState } from 'react';
import { resolveSandboxUrl } from './sandbox-host.js';

/**
 * The sandbox's look, as a React Native app gives it. Like the server's `genui.sandbox` config
 * (`GET <agent>/config`), but each asset may come inline (`runtime`, `source`) instead of by url.
 */
export interface NativeSandboxConfig {
  /** Pass the app's theme in. Default true. */
  theme?: boolean;
  /**
   * Tailwind (v4 `@tailwindcss/browser`): its source inline (`runtime`), or a `url` to fetch it from
   * (the agent's public asset — relative urls resolve against `baseUrl`); `css` is extra Tailwind
   * directives (`@theme`, `@custom-variant`) the app's stylesheet declares.
   */
  tailwind?: { runtime?: string; url?: string; css?: string };
  /** The kit bundle (JSX views): its source inline, or a `url` to fetch it from. */
  kit?: { source?: string; url?: string };
  /** The app's compiled styles (`genuiSandboxKit({ styles })`): inline, or a `url` to fetch them from. */
  css?: { source?: string; url?: string };
}

/**
 * Where the config comes from: an object; a url answering `GET <agent>/config` (or the sandbox
 * config itself); a loader (your own authenticated client); `false` — theme only. Default: `GET
 * <baseUrl>/config` when there is a `baseUrl`, else theme only.
 */
export type NativeSandboxConfigSource =
  | NativeSandboxConfig
  | string
  | false
  | (() => NativeSandboxConfig | undefined | Promise<NativeSandboxConfig | undefined>);

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; credentials?: 'omit' | 'same-origin' | 'include' },
) => Promise<{ ok: boolean; text(): Promise<string> }>;

/** Largest config or asset text accepted (the kit bundle is the big one). */
const MAX_ASSET_CHARS = 8 * 1024 * 1024;

function defaultFetch(): FetchLike | undefined {
  const f = (globalThis as { fetch?: unknown }).fetch;
  return typeof f === 'function' ? (f as FetchLike) : undefined;
}

function toConfig(body: unknown): NativeSandboxConfig | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as { genui?: { sandbox?: unknown }; theme?: unknown };
  const sandbox =
    typeof record.genui?.sandbox === 'object' && record.genui.sandbox !== null
      ? (record.genui.sandbox as Record<string, unknown>)
      : typeof record.theme === 'boolean'
        ? (record as Record<string, unknown>)
        : undefined;
  if (sandbox === undefined) return undefined;
  const config: NativeSandboxConfig = { theme: sandbox.theme !== false };
  const tailwind = sandbox.tailwind as { url?: unknown; css?: unknown } | null | undefined;
  if (typeof tailwind === 'object' && tailwind !== null && typeof tailwind.url === 'string') {
    config.tailwind = {
      url: tailwind.url,
      ...(typeof tailwind.css === 'string' ? { css: tailwind.css } : {}),
    };
  }
  const kit = sandbox.kit as { url?: unknown } | null | undefined;
  if (typeof kit === 'object' && kit !== null && typeof kit.url === 'string') {
    config.kit = { url: kit.url };
  }
  const css = sandbox.css as { url?: unknown } | null | undefined;
  if (typeof css === 'object' && css !== null && typeof css.url === 'string') {
    config.css = { url: css.url };
  }
  return config;
}

const THEME_ONLY: NativeSandboxConfig = Object.freeze({ theme: true });

const texts = new Map<string, Promise<string | null>>();

/** Fetch a text once per url, shared by every sandbox in the app; a failure is forgotten. */
export function loadNativeSandboxText(
  url: string,
  fetchImpl: FetchLike | undefined = defaultFetch(),
  init: Parameters<FetchLike>[1] = { credentials: 'omit' },
): Promise<string | null> {
  if (fetchImpl === undefined) return Promise.resolve(null);
  let pending = texts.get(url);
  if (pending === undefined) {
    pending = Promise.resolve()
      .then(() => fetchImpl(url, init))
      .then((response) => (response.ok ? response.text() : null))
      .then((text) => (typeof text === 'string' && text.length <= MAX_ASSET_CHARS ? text : null))
      .catch(() => null)
      .then((text) => {
        if (text === null) texts.delete(url);
        return text;
      });
    texts.set(url, pending);
  }
  return pending;
}

async function loadConfig(
  source: NativeSandboxConfigSource | undefined,
  baseUrl: string | undefined,
  fetchImpl: FetchLike | undefined,
): Promise<NativeSandboxConfig | undefined> {
  if (typeof source === 'function') {
    try {
      const loaded = await source();
      return typeof loaded === 'object' && loaded !== null ? loaded : undefined;
    } catch {
      return undefined;
    }
  }
  const url =
    typeof source === 'string'
      ? resolveSandboxUrl(source, baseUrl)
      : baseUrl !== undefined
        ? resolveSandboxUrl(`${baseUrl.replace(/\/+$/, '')}/config`, undefined)
        : undefined;
  if (url === undefined) return undefined;
  const text = await loadNativeSandboxText(url, fetchImpl, {
    headers: { accept: 'application/json' },
  });
  if (text === null) return undefined;
  try {
    return toConfig(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** The sandbox's config: `undefined` (and `loading`) until it is known. */
export function useNativeSandboxConfig(
  source: NativeSandboxConfigSource | undefined,
  baseUrl: string | undefined,
  fetchImpl: FetchLike | undefined,
): { config: NativeSandboxConfig | undefined; loading: boolean } {
  const immediate =
    source === false || (source === undefined && baseUrl === undefined)
      ? THEME_ONLY
      : typeof source === 'object'
        ? source
        : undefined;
  const [state, setState] = useState<{ config: NativeSandboxConfig | undefined; done: boolean }>({
    config: undefined,
    done: false,
  });
  useEffect(() => {
    if (immediate !== undefined) return;
    let cancelled = false;
    setState({ config: undefined, done: false });
    void loadConfig(source, baseUrl, fetchImpl).then((config) => {
      if (!cancelled) setState({ config: config ?? THEME_ONLY, done: true });
    });
    return () => {
      cancelled = true;
    };
  }, [immediate, source, baseUrl, fetchImpl]);
  if (immediate !== undefined) return { config: immediate, loading: false };
  return { config: state.config, loading: !state.done };
}

/**
 * An asset's text: inline if given, else fetched from its url (resolved against `baseUrl`).
 * `undefined` while it loads, `null` when it could not be had (or there is none).
 */
export function useNativeSandboxAsset(
  asset: { inline?: string | undefined; url?: string | undefined } | undefined,
  baseUrl: string | undefined,
  fetchImpl: FetchLike | undefined,
): string | null | undefined {
  const inline = asset?.inline;
  const url =
    inline === undefined && asset?.url !== undefined
      ? resolveSandboxUrl(asset.url, baseUrl)
      : undefined;
  const [state, setState] = useState<{ url: string | undefined; text: string | null }>({
    url: undefined,
    text: null,
  });
  useEffect(() => {
    if (url === undefined) return;
    let cancelled = false;
    void loadNativeSandboxText(url, fetchImpl).then((text) => {
      if (!cancelled) setState({ url, text });
    });
    return () => {
      cancelled = true;
    };
  }, [url, fetchImpl]);
  if (typeof inline === 'string') return inline;
  if (url === undefined) return null;
  return state.url === url ? state.text : undefined;
}
