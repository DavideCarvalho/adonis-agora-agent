---
'@adonis-agora/agent': patch
---

Durable runs started by this package are now stamped with `origin: '@adonis-agora/agent'` (`agora.agent.run`, `agora.agent.opencode.run`, `agora.channel.job`, `agora.channel.timer`), so the durable console's ORIGIN facet separates the library's runs from the app's own.
