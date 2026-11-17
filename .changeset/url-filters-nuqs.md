---
"@adonis-agora/agent-dashboard": minor
---

Console filters now live in the URL, so a filtered view can be shared, bookmarked and reloaded, and back/forward step through it: the day range (kept across pages), the Runs status, agent and actor, the Tools sort and the chart metric on Overview and Generative UI. They sit in the hash's query (`#runs?status=failed&agent=support`); a value at its default is left out, so existing `#<page>` and `#runs/<id>` links open as before, and opening a run keeps the list's filters.
