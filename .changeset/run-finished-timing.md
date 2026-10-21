---
'@adonis-agora/agent': minor
---

`agora:agent:run.finished` carries the turn's timing: `durationMs` (turn start to end) and `ttftMs` (turn start to the first `text` frame on the stream, absent when no text went out). Both use the clock of the process running the turn, so a resumed run measures from its resume.
