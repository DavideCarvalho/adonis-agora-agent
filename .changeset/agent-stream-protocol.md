---
'@adonis-agora/agent': minor
---

The chat routes can now stream the chat protocol shared with `@dudousxd/nestjs-agent`, so `@dudousxd/nestjs-agent-react` (transport, `useAgentChat`, transcript model) renders an Adonis run unchanged. Opt in with `streamProtocol: 'agent'` in `config/agent.ts`; the default stays `'legacy'`, so the `{"delta":…}` bytes an existing reader parses do not change.

Under `'agent'` every frame is an `AgentStreamEvent`: `step-start`/`step-finish` (with `usage` and `costUsd`), `text`, `reasoning` (streamed by the AI SDK adapter), `tool-input-start`/`-delta`/`-available` (the loop announces a call itself when the provider streams none), `tool-output`/`tool-output-error`/`tool-output-denied`, `elicitation`, `approval-requested`, `ui` (for `ctx.emitComponent`, id `<toolCallId>:ui:<n>`), `title` and `cancelled`; a failed run ends with `event: error` `{ code, message }` (`quota_exceeded`, `output_rejected`, `structured_output_invalid`, `run_failed`). Every frame is written from inside a checkpoint the loop already had, so a durable replay never re-streams one and no checkpoint moved.

`POST /agent/tool-call/approve|reject|answer|skip` accept a body naming the tool call alone (`{ toolCallId }`), reading the run off the call's row through the new optional `AgentStore.getToolCallRunId` (implemented by the Lucid and in-memory stores); an unknown call answers `404`. `@adonis-agora/agent/client` reads both envelopes and surfaces `event: error` as `AgentChatStreamError`. Runners now write a failure as a typed `{ t: 'error' }` frame, which the legacy envelope still spells as the `[error]` delta.
