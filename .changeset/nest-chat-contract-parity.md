---
'@adonis-agora/agent': minor
---

The chat contract `@dudousxd/nestjs-agent` settled (its `docs/stream-protocol.md`), ported:

- **Refusals answer `{ message, code? }` (BREAKING for readers of `error`).** Every refused request on the agent routes (and the dashboard's asset route) answers its status with `{ message, code? }` instead of `{ error }` — `code` where there is a machine-readable reason (`unauthorized`, `model_not_allowed`, `thread_required`, `quota_exceeded`). `@adonis-agora/agent/client` now throws a refused send as `AgentChatHttpError` (`status`, `code`, `body`, and the server's `message` as its own message) instead of a bare `Error('Failed to start agent chat (HTTP n).')`.
- **A send's `model` is that turn's only** — never stored on the thread; `PATCH threads/:id { model }` is the only pin (documented and tested; the service already behaved this way).
- **Regenerate.** `POST chat { threadId, regenerate: true }` answers the thread's last user message again: `400 thread_required` without a thread, `message` ignored, no user message stored, the answer(s) after it dropped (a new `regenerate:truncate` durable step — normal turns journal exactly what they did), a new run. `AgentRunInput.regenerate` replaces the unused `isRegenerate`; `RegenerateNeedsThreadError` is exported.
- **Model lock.** `ModelCatalogView.locked: { model, reason? }` runs every turn of that agent on `locked.model` and refuses a send naming another (`400 model_not_allowed`); `GET agents` entries carry `lockedModel` (`AgentCatalogEntry`). `listAgents(actor)` is now async.
- **Quota soft limit and USD-only windows.** `QuotaWindow.usedTokens` is optional; `QuotaWindow.warnAt`, `QuotaReport.warning: { period, ratio, reason? }` (never while blocked), `quotaWarning(windows)`, `quotaUsedRatio(window)`; `quota: { limits, warnAt }` stamps it on the ledger windows (`LedgerQuotaProvider`'s new `options.warnAt`). `exhaustedWindow` reads a missing `usedTokens` as `0`.
- **Who answered a question.** `POST tool-call/answer|skip` take `via?` (1–64 characters, `'web'` by default; `400` otherwise); the settled outcome carries `answeredBy` / `answeredVia` (`ElicitationReply.answeredVia`, `ElicitationOutcome.answeredBy|answeredVia`), streamed as the call's `tool-output` and persisted with its result.
- **`GET tools?agent=*`** (`ALL_AGENTS`) answers the union across every agent, each tool once, under the same gates; an unknown name is still `404`.
- **Frame ids.** `SseEvent.id` (the client parser now keeps the `id:` line). Ids stay strictly increasing within a run; readers must tolerate gaps.
