/**
 * The slice of `react-native-webview` the React Native entry uses, for this package's own type
 * checking only (see `types/react-native.d.ts`). Prop names and values are the real package's
 * (v13/v14 `WebViewTypes`).
 */
import type { ComponentType } from 'react';
import type { NativeSyntheticEvent, StyleProp, ViewStyle } from 'react-native';

export interface WebViewNativeEvent {
  url: string;
  loading?: boolean;
  title?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  lockIdentifier?: number;
}
export interface WebViewNavigation extends WebViewNativeEvent {
  navigationType?: string;
  mainDocumentURL?: string;
}
export interface ShouldStartLoadRequest extends WebViewNavigation {
  isTopFrame?: boolean;
}
export interface WebViewMessage extends WebViewNativeEvent {
  data: string;
}
export type WebViewMessageEvent = NativeSyntheticEvent<WebViewMessage>;
export interface WebViewProps {
  source?: { html: string; baseUrl?: string } | { uri: string };
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
  originWhitelist?: string[];
  onShouldStartLoadWithRequest?: (event: ShouldStartLoadRequest) => boolean;
  onMessage?: (event: WebViewMessageEvent) => void;
  onNavigationStateChange?: (event: WebViewNavigation) => void;
  onRenderProcessGone?: (event: NativeSyntheticEvent<{ didCrash: boolean }>) => void;
  onContentProcessDidTerminate?: (event: NativeSyntheticEvent<WebViewNativeEvent>) => void;
  javaScriptEnabled?: boolean;
  javaScriptCanOpenWindowsAutomatically?: boolean;
  setSupportMultipleWindows?: boolean;
  domStorageEnabled?: boolean;
  allowFileAccess?: boolean;
  allowFileAccessFromFileURLs?: boolean;
  allowUniversalAccessFromFileURLs?: boolean;
  allowsLinkPreview?: boolean;
  incognito?: boolean;
  cacheEnabled?: boolean;
  cacheMode?: 'LOAD_DEFAULT' | 'LOAD_CACHE_ELSE_NETWORK' | 'LOAD_NO_CACHE' | 'LOAD_CACHE_ONLY';
  mixedContentMode?: 'never' | 'always' | 'compatibility';
  sharedCookiesEnabled?: boolean;
  thirdPartyCookiesEnabled?: boolean;
  geolocationEnabled?: boolean;
  mediaCapturePermissionGrantType?:
    | 'grantIfSameHostElsePrompt'
    | 'grantIfSameHostElseDeny'
    | 'deny'
    | 'grant'
    | 'prompt';
  mediaPlaybackRequiresUserAction?: boolean;
  allowsFullscreenVideo?: boolean;
  allowsAirPlayForMediaPlayback?: boolean;
  allowsProtectedMedia?: boolean;
  allowsBackForwardNavigationGestures?: boolean;
  pullToRefreshEnabled?: boolean;
  dataDetectorTypes?: string | string[];
  saveFormDataDisabled?: boolean;
  setBuiltInZoomControls?: boolean;
  setDisplayZoomControls?: boolean;
  textZoom?: number;
  paymentRequestEnabled?: boolean;
  enableApplePay?: boolean;
  webviewDebuggingEnabled?: boolean;
  scrollEnabled?: boolean;
  bounces?: boolean;
  overScrollMode?: 'always' | 'content' | 'never';
  nestedScrollEnabled?: boolean;
  showsVerticalScrollIndicator?: boolean;
  showsHorizontalScrollIndicator?: boolean;
  automaticallyAdjustContentInsets?: boolean;
  contentInsetAdjustmentBehavior?: 'automatic' | 'scrollableAxes' | 'never' | 'always';
  startInLoadingState?: boolean;
}
export declare const WebView: ComponentType<WebViewProps>;
export default WebView;
