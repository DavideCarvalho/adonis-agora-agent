---
'@adonis-agora/agent': patch
---

A turn that dies mid-step no longer takes its thread with it.

A turn writes its tool results onto the assistant message once the step's last tool has settled. A
run that died before that — refused a checkpoint position, killed with its worker, failed while
settling a tool — left an assistant message asking for tools and answered by nothing, a call still
`pending_approval`, a run row still `running`. The next message on the same thread was then sent to
the provider with a tool call and no result after it, and failed with the AI SDK's "No output
generated. Check the stream for errors." — every time, for the rest of the conversation.

- **History is settled before it is sent.** Reading the thread for a turn now answers every tool
  call its message holds no result for: with what the call's own row says where the store can read
  it (`AgentStore.toolCallOutcomes`, optional, implemented by the Lucid and in-memory stores) — a
  tool that DID run hands the model its real output, so it is not run a second time — and otherwise
  with a result saying the call was never completed. Done inside `load:thread`, so it takes no
  checkpoint position and a replay composes the same prompt. `settleDanglingToolCalls` /
  `danglingToolCallIds` are exported.
- **A run that ends without settling leaves nothing waiting on it.** A failing run settles the calls
  it had put to a person as `failed` (`AgentStore.failUnsettledToolCalls`, optional). A run refused
  a checkpoint position — which cannot write a checkpoint — settles its row, its calls and its
  thread straight to the store. A send that finds its thread held by a run that is gone settles
  that run the same way (`settleDeadRun`).
- **A decision for a run that is over is refused**, not swallowed: `approve` / `reject` / `answer` /
  `skip` throw `RunNotActiveError` (`409 { code: 'run_not_active' }` on the routes) instead of
  signalling a run that will never read it — the card no longer says "approved" for something that
  will not run.
- **The error frame is written for the person reading the chat.** `streamErrorFrame` carries a
  stable `code` (`run_failed`, plus the new `replay_diverged` and `model_no_output`) and, in
  production, `RUN_FAILED_MESSAGE` instead of the error's own text; the error is logged with its
  run id and stays on the run row. Outside production the raw message still rides the frame;
  `exposeStreamErrorDetails(true | false)` decides it outright. Messages the library words itself
  (`quota_exceeded`, `output_rejected`, `structured_output_invalid`) are unchanged.
- **`aiSdkModel` throws the provider's own error** when the stream carries one, instead of letting
  it surface as "No output generated".
