---
'@adonis-agora/agent': minor
---

AG-UI: the encoder is now the shared one in `@dudousxd/nestjs-agent-core/ag-ui` — one implementation for both servers instead of a copy each. `@adonis-agora/agent/ag-ui` re-exports it unchanged (same events, same interrupt ids), with `AgUiEncoder` and `agUiEvents` still reading this package's `StreamFrame`s; `toAgUiFrame` / `agUiFrames` are the new mapping helpers.

**Requires `@dudousxd/nestjs-agent-core` 0.35 or later** (an optional peer, raised from 0.26) for the `ag-ui` entry — install it if you serve AG-UI. A `approval-requested` or `elicitation` event a custom runner writes into the sink directly is now an interrupt too (the parked run defaults to the stream's own), rather than only a `CUSTOM` event.
