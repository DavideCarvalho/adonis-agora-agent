/**
 * The slice of `react-native` the React Native entry (`src/react-native`) uses, for this package's
 * own type checking only (`paths` in tsconfig.json) — the real types declare globals that would
 * retype the rest of the package. The names are the real package's; an app compiles the emitted
 * declarations against it.
 */
import type { ComponentType, ReactNode } from 'react';

export interface ViewStyle {
  [property: string]: unknown;
}
export interface TextStyle extends ViewStyle {}
export type StyleProp<T> = T | readonly StyleProp<T>[] | null | undefined | false;
export interface NativeSyntheticEvent<T> {
  nativeEvent: T;
}
export interface ViewProps {
  testID?: string;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  accessibilityState?: { busy?: boolean };
  children?: ReactNode;
}
export interface TextProps {
  testID?: string;
  style?: StyleProp<TextStyle>;
  children?: ReactNode;
}
export declare const View: ComponentType<ViewProps>;
export declare const Text: ComponentType<TextProps>;
