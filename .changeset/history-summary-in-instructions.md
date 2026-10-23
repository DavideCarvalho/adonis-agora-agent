---
'@adonis-agora/agent': minor
---

fix: a summarizing `historyWindow` hands its summary to the model through the system prompt, not as a `system` message in the conversation. The summary is appended to the turn's system prompt, after every other block; the journaled `history:summarize` payload is unchanged, and a run that recorded the older single `history:window` checkpoint is lifted the same way on replay. New optional `HistoryWindow.renderSummary` (and `SlidingWindowHistory`'s `renderSummary` option) words the block; `renderHistorySummary` is the default, exported.

`aiSdkModel` / `aiSdkModels` now hoist any `system` message they are handed into `instructions` (in order, after the turn's system prompt) and send only user/assistant/tool messages, instead of relying on `allowSystemInMessages: true` — some providers still refuse a system message that follows a user or assistant one.
