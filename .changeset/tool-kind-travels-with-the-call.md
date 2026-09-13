---
'@adonis-agora/agent': patch
---

A tool call's kind travels with the call, so the approval gate does not depend on which process replays the turn

`claimToolCall` settles a call's kind inside `persist:toolcall` and journals it from there, which makes every replay agree. It does not make the first writer right: a resumed run is handed to whichever instance takes the lease, and an instance that never declared the tool reads `undefined` from its own registry, journals `read` for an action tool, and executes it with nobody's approval.

The kind is now stamped where the tool was OFFERED — inside the `llm:<i>` checkpoint, by the process that built the definition list the model chose from — and `claimToolCall` writes that value rather than asking its own registry. A call that arrives unstamped still falls back to the local lookup, so a journal written before kinds travelled replays unchanged.

No checkpoint name, position or count changes.
