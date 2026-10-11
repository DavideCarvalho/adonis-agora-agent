import { type ReactNode, useContext } from 'react';
import { Text } from 'react-native';
import {
  GenuiProvider as BaseGenuiProvider,
  type GenerativeUIFallback,
  GenuiActionContext,
  type GenuiProviderProps,
} from '../../react/core/genui/generative-ui.js';
import type { GenerativeUIProblem } from '../../react/core/genui/types.js';
import type { GenuiActionHandler } from './sandbox.js';

/** The item's persisted text, as a `<Text>` — the web default draws a `<span>`, which RN cannot. */
export const nativeGenuiFallback: GenerativeUIFallback = (problem: GenerativeUIProblem) =>
  problem.item.fallbackText !== undefined ? <Text>{problem.item.fallbackText}</Text> : null;

/**
 * `GenuiProvider` for React Native: the same provider (the same shared contexts — `GenerativeUI`
 * and `useGenerativeUI` read it as on the web), with `fallback` defaulting to
 * {@link nativeGenuiFallback} so an unknown or failing component never draws a DOM element.
 */
export function GenuiProvider({ fallback, ...props }: GenuiProviderProps) {
  return <BaseGenuiProvider {...props} fallback={fallback ?? nativeGenuiFallback} />;
}

/** Where UI actions go — a sandbox's `agent.send(…)`. Typically the chat's `sendUiAction`. */
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
