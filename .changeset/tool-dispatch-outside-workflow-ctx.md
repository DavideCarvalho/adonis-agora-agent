---
'@adonis-agora/agent': patch
---

A tool that starts a workflow no longer breaks the durable run it was called from.

Under the durable runner a tool's `execute` runs inside the agent run's `tool:<callId>` step, and
`@adonis-agora/durable` routes a `BaseWorkflow` static by the ambient workflow ctx. So a tool that
called `SomeWorkflow.dispatch(...)` — directly, or through a service of the app's — had it turned
into `ctx.startChild`, which wrote a `spawn:<id>` checkpoint into the AGENT run's journal from
inside the step. A replay skips a completed step's body, so the next resume offered that position
to `persist:toolexec:<callId>` and the runtime failed the run:

```
non-determinism at <run>#41: code expects "persist:toolexec:call_…" but history recorded
"spawn:…". The workflow changed under an in-flight run — register a new workflow version.
```

Nothing had changed under the run. It took a resume AFTER such a tool to get there — two actions
awaiting approval in the same step (the run parks again between them), or an approval in any later
step — which is why a turn with a single approval never showed it.

Every checkpoint body of the agent workflow now runs outside the ambient workflow ctx. A workflow
started from a tool, a processor, a store or a quota provider goes to the engine, as it does from a
controller: it is a run of its own (no longer a child of the chat's run, so a failed or cancelled
turn does not take it down), and the step's memoized result keeps a replay from starting it twice.

A run that is ALREADY suspended with such a `spawn:` in its journal still fails on its next resume
— the position is in its history. Settle it as failed and ask again.

Also: `foldPart` (`@adonis-agora/agent/client`) closes the text of a model step with a paragraph
break when the next step starts, so two steps no longer run into each other in one message
("…before answering.Let me compare…"). `STEP_SEPARATOR` is exported.
