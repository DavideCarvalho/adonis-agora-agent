---
"@adonis-agora/agent": patch
---

Sandbox views a real model writes under strict tool calling (it fills every field):

- The schema offers `jsx` only when the kit has a bundle to draw it with. A stylesheet-only kit (Bootstrap) and a server with no kit built are written as `html`, as their description says.
- When a model writes both `html` and `jsx`, the field holding the view wins (the longer one): a `function App() { return null }` stub next to the real `html` no longer blanks the frame. This applies to the web and React Native renderers (`sandboxDrawsJsx`).
- The JSX rules now say "jsx OR html, never both".
