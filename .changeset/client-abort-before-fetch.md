---
"@adonis-agora/agent": patch
---

fix(client): aborting `send`/`resume` settles the call even while a host `fetch` has not reached the network yet (e.g. it is still awaiting a token refresh) — before, `send` stayed pending forever and a "Stop" button could not stop it.
