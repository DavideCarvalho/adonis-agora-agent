---
'@adonis-agora/agent': minor
---

**BREAKING — the agent stream protocol is the only wire.** `POST /agent/chat` and `GET /agent/chat/:runId/stream` always write the chat stream protocol shared with `@dudousxd/nestjs-agent`: `event: meta`, then one numbered `AgentStreamEvent` per `data:` frame (`{"kind":"text","text":…}`, `ui`, `elicitation`, `approval-requested`, reasoning, tool calls, steps, title, …), then `event: done` — or `event: error` `{ code, message }` for a failed run. `@dudousxd/nestjs-agent-react` and `@adonis-agora/agent/client` / `./react` read it unchanged.

- **The `'legacy'` envelope is removed** — `data: {"delta":…}` text, the named `event: component` / `event: elicitation` / `event: approval` frames and the `[error]` text delta are no longer written, and `@adonis-agora/agent/client`'s `decodeFrame` no longer reads them (a `{"delta"}` payload decodes to `null`).
- **The `streamProtocol` option is removed** from `defineConfig`, with no shim: delete `streamProtocol: 'agent'` from `config/agent.ts`; if you relied on the old `'legacy'` default, move the browser to `@adonis-agora/agent/client` (or `./react`, or `@dudousxd/nestjs-agent-react`) or read `{"kind":"text","text":…}` where you read `{"delta":…}`.
- **`frameToSse` and the `StreamProtocol` type are no longer exported.** Use `AgentSseEncoder` (or the pure `frameToEvents`).

`ChatFrame` / `ChatPart` / `foldPart` are unchanged, so code built on the package client needs no change beyond the server config.
