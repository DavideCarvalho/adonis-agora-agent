---
'@adonis-agora/agent': minor
---

`useAgentChat` over AG-UI from `@adonis-agora/agent/react` — `agUiBackend()`, and a CSRF-aware `agUiChatStream`

`@dudousxd/nestjs-agent-react`'s AG-UI 1.0 consumer (`agUiChatStream`, `reframeAgUiStream`) was already reachable through the re-export, but sent only the headers it was handed once — so behind an Adonis session shield refused the first `POST`. Now:

- `agUiBackend()` — `<AgentProvider backend={agUiBackend()}>` runs every chat turn over `POST <path>/ag-ui` (the `agUiAdapter()` route) and keeps threads, the queue, approvals and uploads on the REST routes, with the session cookie and the CSRF token read per request. `url` points it at any other AG-UI producer.
- `agUiChatStream` from `@adonis-agora/agent/react` adds the CSRF header on every call.

The `@dudousxd/nestjs-agent-react` peer floor moves to `>=0.30.0` (the release that has the consumer).
