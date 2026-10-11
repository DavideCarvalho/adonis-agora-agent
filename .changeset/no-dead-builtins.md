---
'@adonis-agora/agent': patch
---

The `remember` built-in is no longer offered to an actor whose memory scopes resolve to nothing, and `skill` is no longer offered when the actor's catalog is empty. A personal agent (A2A/Poppy) resolves no memory or skill scope, so it was offered tools that could do nothing — and the model promised to "remember" things it could not.
