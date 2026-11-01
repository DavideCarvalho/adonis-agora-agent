---
"@adonis-agora/agent": patch
---

`withRag` no longer loses the Lucid model API under `compose`: the mixin's constructor type was `abstract`, which TypeScript does not combine with the base model's.
