import { type Context, createContext, type ReactNode, useContext } from 'react';
import type { TranscriptUiBlock } from '../transcript/model.js';

/** Draws a server-pushed component block. */
export type AmbientRenderUi = (block: TranscriptUiBlock) => ReactNode;

/**
 * A context stored on `globalThis` under a registered symbol. Each entry point (`.`, `/genui`,
 * `/genui/json-render`) is its own bundle with its own copy of every module, so a context one entry
 * provides and another reads has to be found by key, not by module identity.
 */
export function sharedContext<T>(key: string): Context<T | null> {
  const symbol = Symbol.for(key);
  const holder = globalThis as Record<symbol, Context<T | null> | undefined>;
  const existing = holder[symbol];
  if (existing !== undefined) return existing;
  const created = createContext<T | null>(null);
  holder[symbol] = created;
  return created;
}

/**
 * How pushed components are drawn when no `renderUi` is passed — set by `<GenuiProvider>` (the
 * `/genui` subpath) and read by `MessageItem`.
 */
export const AmbientRenderUiContext: Context<AmbientRenderUi | null> =
  sharedContext<AmbientRenderUi>('@adonis-agora/agent/react:ambient-render-ui');

/**
 * The renderer `<GenuiProvider>` installed for pushed components, or `null` outside one. For a
 * custom transcript built on `useTranscriptItem`: draw a `ui` block with it and you get what
 * `MessageItem` draws.
 */
export function useAmbientRenderUi(): AmbientRenderUi | null {
  return useContext(AmbientRenderUiContext);
}
