---
'@adonis-agora/agent': minor
---

The sandbox component in React Native: `@adonis-agora/agent/react-native/genui`.

- **`createNativeSandboxRenderer(options)`** draws `Sandbox` (`ui__sandbox`) in a `react-native-webview` built from the web renderer's own document (`buildSandboxDocument`, the same CSP — no network unless the policy lists an origin), streaming the same way (placeholder → preview → live, code posted in as it closes) and sized to its content within the policy's `maxHeight`. Register it like the web one: `<GenuiProvider registry={{ Sandbox: createNativeSandboxRenderer({ … }) }}>`.
- **Hardened WebView** (`NATIVE_SANDBOX_WEBVIEW_PROPS`): every navigation refused but the inline document (with an `originWhitelist` of `['*']`, so a refused URL is never handed to `Linking.openURL`), no DOM storage, incognito, no cache or cookies, no file access, no new windows, no mixed content, no link previews, no scrolling. The only bridge is the document's: `ReactNativeWebView.postMessage` out, `injectJavaScript` dispatching JSON `message` events in.
- **The same checks as the web host**: the raw message is length-capped before parsing and needs the view's token; `agent.send` then goes through the count, interval, JSON, size, `schema` and `confirm` checks, `onRefused` gets the web `SandboxRefusal` reasons, and an accepted send reaches `onAction` / the enclosing `GenuiActionProvider` as a `UiAction`.
- **Theme and Tailwind**: `theme: { vars, dark }` (or a hook returning it) becomes the frame's `:root` custom properties and follows changes without reloading; Tailwind (and the kit) come from a config object (assets inline or by url) or the agent's `GET <baseUrl>/config`, relative urls resolved against `baseUrl`.
- The entry also re-exports the React Native-safe genui pieces — `GenuiProvider` (its default fallback a `<Text>`), `GenerativeUI`, `GenuiActionProvider`, `useGenuiNode`, the types. `@adonis-agora/agent/react/genui` is not safe to import in React Native (its iframe renderer's assets module calls `window.addEventListener` as it loads).
- `react-native` (>= 0.74) and `react-native-webview` (>= 13) are optional peers, imported by this entry only. `buildSandboxDocument` takes `transport: 'react-native'` (default `'parent'`, unchanged).
