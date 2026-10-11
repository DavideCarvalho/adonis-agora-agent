---
'@adonis-agora/agent': patch
---

The React Native sandbox works on Android: `dataDetectorTypes` is passed as `['none']` (react-native-webview's Fabric codegen wants an array and only its iOS wrapper boxes a string, so the bare `'none'` aborted the app the moment a sandbox WebView mounted), and a frame message whose `url` is `'null'` (how Android reports the inline document's opaque origin in `onMessage`) is accepted instead of dropped, so the view's height, `agent.send` and error reports reach the host again.
