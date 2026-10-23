---
'@adonis-agora/agent': patch
---

fix(ai-sdk): a summarizing `historyWindow` no longer fails the turn. The summary goes into the thread as a `system` message and AI SDK 7 rejects those by default (`AI_InvalidPromptError: System messages are not allowed…`), so every turn of a thread long enough to be summarized errored. `aiSdkModel` now passes `allowSystemInMessages: true`.
