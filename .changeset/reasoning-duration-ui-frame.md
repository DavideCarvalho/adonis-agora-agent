---
'@adonis-agora/agent': patch
---

`AgentChatTransport`: a component pushed mid-step (`ui` frame) now closes only the open text run. It used to close the reasoning run too, stamping the browser's elapsed time on it — so when a tool pushed a component while it ran (a search pushing its result card), the tool's whole execution was counted as thinking, and the backend's `step-finish.reasoningMs` arriving after it was dropped. The reasoning run now closes at the step boundary with the backend's own measurement, the same number a reloaded thread shows.
