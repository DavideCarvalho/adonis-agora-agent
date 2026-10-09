---
"@adonis-agora/agent": patch
---

OpenCode: record the title OpenCode generates (and a compaction) even though OpenCode 2.0 does not stream those calls. A turn reads the session's spend (`session.get`) before it prompts and, when the execution ends, records what the session spent that its steps did not report as a `title` (or `summary`) usage row, counted in the run's usage.
