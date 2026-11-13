---
'@adonis-agora/agent': patch
---

Dev tools: an object that appears twice in a tool's result (a flag's `stored` and `definition`) is written out both times instead of showing as `"[circular]"`; only a real cycle is marked.
