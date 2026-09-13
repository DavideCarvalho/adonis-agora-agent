---
'@adonis-agora/agent': patch
---

A declined action reads as a decision, not as a malfunction

When a person declines an action tool, the loop handed the model a tool result whose error text was the single word `rejected`. That names no actor and is indistinguishable from a tool that threw, so the answer that followed diagnosed the refusal — "the key may not exist", "there may be permission restrictions" — and offered to retry the same action, asking the person to say no twice.

- `ToolResult` gains `denied?: true`. It is set instead of a failure and read by everything that has to tell the two apart; `error` still carries what the model is told, because that is the channel a model reads an outcome on.
- That text now says who decided, that nothing ran, and what not to do next: not an error, no guessing at causes, no retry and no reaching for another way to do the same thing. A reason given when declining is included.

Ported from the NestJS sibling, where the bad narration was seen in production.
