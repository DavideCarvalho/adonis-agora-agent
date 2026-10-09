import { useEffect, useMemo, useRef, useState } from 'react';
import type { SandboxClientConfig } from '../../../genui/sandbox-kit.js';
import {
  collectHostThemeVars,
  hostThemeCss,
  isHostDark,
  tailwindThemeCss,
  watchHostTheme,
} from '../../../genui/sandbox-theme.js';
import { useAgentConfig } from '../config/use-agent-config.js';

/** The event the Vite plugin's HMR bridge dispatches on `window` when the kit was rebuilt (dev). */
export const SANDBOX_KIT_UPDATE_EVENT = 'genui-sandbox-kit:update';

/**
 * Where a sandbox renderer learns about the theme, Tailwind and the kit: an object, a url answering
 * `GET <agent>/config` (or the sandbox config itself), or — by default — the agent's own `/config`
 * through the enclosing `AgentProvider` (same origin `/agent` without one). `false`: none (theme on).
 */
export type SandboxConfigSource = SandboxClientConfig | string | false;

const fetched = new Map<string, Promise<SandboxClientConfig | undefined>>();

function fromUrl(url: string): Promise<SandboxClientConfig | undefined> {
  let pending = fetched.get(url);
  if (pending === undefined) {
    pending = fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body: unknown) => {
        const record = body as { genui?: { sandbox?: SandboxClientConfig } } | undefined;
        if (record?.genui?.sandbox !== undefined) return record.genui.sandbox;
        return typeof (body as SandboxClientConfig | undefined)?.theme === 'boolean'
          ? (body as SandboxClientConfig)
          : undefined;
      })
      .catch(() => {
        fetched.delete(url);
        return undefined;
      });
    fetched.set(url, pending);
  }
  return pending;
}

/** The sandbox's client config — `undefined` while it loads. */
export function useSandboxClientConfig(source: SandboxConfigSource | undefined): {
  config: SandboxClientConfig | undefined;
  loading: boolean;
} {
  const agent = useAgentConfig({ enabled: source === undefined });
  const [fromSource, setFromSource] = useState<SandboxClientConfig | undefined>(undefined);
  const [loadingUrl, setLoadingUrl] = useState(typeof source === 'string');
  useEffect(() => {
    if (typeof source !== 'string') return;
    let cancelled = false;
    setLoadingUrl(true);
    void fromUrl(source).then((config) => {
      if (cancelled) return;
      setFromSource(config);
      setLoadingUrl(false);
    });
    return () => {
      cancelled = true;
    };
  }, [source]);
  if (source === false) return { config: { theme: true }, loading: false };
  if (typeof source === 'object') return { config: source, loading: false };
  if (typeof source === 'string') return { config: fromSource, loading: loadingUrl };
  return {
    config: agent.config?.genui?.sandbox ?? (agent.isLoading ? undefined : { theme: true }),
    loading: agent.isLoading,
  };
}

const assets = new Map<string, Promise<string | null>>();
/** The kit url the last HMR update named (dev): newer than what `/config` said. */
let kitUrlOverride: string | undefined;
let kitVersion = 0;
const kitListeners = new Set<() => void>();

if (typeof window !== 'undefined') {
  window.addEventListener(SANDBOX_KIT_UPDATE_EVENT, (event) => {
    const detail = (event as CustomEvent<{ url?: string | null }>).detail;
    if (typeof detail?.url === 'string') kitUrlOverride = detail.url;
    kitVersion += 1;
    for (const notify of kitListeners) notify();
  });
}

/** Fetch an asset's text once per url (same origin), shared by every sandbox on the page. */
export function loadSandboxAsset(url: string): Promise<string | null> {
  let pending = assets.get(url);
  if (pending === undefined) {
    pending = fetch(url, { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.text() : null))
      .catch(() => null)
      .then((text) => {
        if (text === null) assets.delete(url);
        return text;
      });
    assets.set(url, pending);
  }
  return pending;
}

/**
 * An asset's text: `undefined` while it loads, `null` when it could not be had (or no url). The kit
 * follows the dev server's rebuilds (`genui-sandbox-kit:update`): a new url, fetched afresh.
 */
export function useSandboxAsset(
  url: string | undefined,
  options: { kit?: boolean } = {},
): string | null | undefined {
  const [version, setVersion] = useState(kitVersion);
  useEffect(() => {
    if (options.kit !== true) return;
    const notify = () => setVersion(kitVersion);
    kitListeners.add(notify);
    return () => {
      kitListeners.delete(notify);
    };
  }, [options.kit]);
  const effective = options.kit === true && url !== undefined ? (kitUrlOverride ?? url) : url;
  const [state, setState] = useState<{ url: string | undefined; text: string | null | undefined }>({
    url: undefined,
    text: undefined,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` refetches after a rebuild
  useEffect(() => {
    if (effective === undefined) {
      setState({ url: undefined, text: null });
      return;
    }
    let cancelled = false;
    void loadSandboxAsset(effective).then((text) => {
      if (!cancelled) setState({ url: effective, text });
    });
    return () => {
      cancelled = true;
    };
  }, [effective, version]);
  if (effective === undefined) return null;
  return state.url === effective ? state.text : undefined;
}

/** The host page's theme now, and as it changes: the frame's `:root` CSS, dark or not, Tailwind's `@theme`. */
export interface HostTheme {
  css: string;
  dark: boolean;
  tailwind: string;
}

function readHostTheme(): HostTheme | null {
  if (typeof document === 'undefined') return null;
  const vars = collectHostThemeVars(document);
  const dark = isHostDark(document);
  return { css: hostThemeCss(vars, dark), dark, tailwind: tailwindThemeCss(vars) };
}

/** The host's theme, kept current (class / `data-theme` / color-scheme changes). `null` when off. */
export function useHostTheme(enabled: boolean): HostTheme | null {
  const [theme, setTheme] = useState<HostTheme | null>(() => (enabled ? readHostTheme() : null));
  const last = useRef<string>('');
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') {
      setTheme(null);
      return;
    }
    const update = () => {
      const next = readHostTheme();
      const key = next === null ? '' : `${next.dark}|${next.css}`;
      if (key === last.current) return;
      last.current = key;
      setTheme(next);
    };
    update();
    return watchHostTheme(document, update);
  }, [enabled]);
  return useMemo(() => theme, [theme]);
}
