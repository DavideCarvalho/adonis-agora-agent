---
'@adonis-agora/agent': minor
---

Proposal and presentation hooks, and AG-UI fidelity:

- **Text decisions**: English commands work alongside Portuguese (`yes`, `confirm`, `approve`, `no`, `cancel`, `reject`, `deny`, `always in this conversation`). The new `actionProposalText: { vocabulary, replies }` config replaces the word lists and the reply texts; replies stay Portuguese by default. A command naming an `#ID` that is not a proposal of the thread (`sim #abc`) is now an ordinary message for the model instead of a `404`.
- **`actionProposalWorker.onSettled(proposal)`**: called when a proposal's execution settles, so another channel (a WhatsApp bridge) gets the outcome pushed instead of polling. A throwing listener is logged and does not fail the worker.
- **`onPresentationError(error, { toolName, toolCallId?, runId?, threadId? })`**: now wired for turns and proposal executions. Default: a warning on the app logger (was `console.warn`).
- **No genui catalog + `uiCapabilities`**: `ctx.emitUi` no longer throws. A component the client declares is drawn; any other one degrades to its `fallbackText` (or is left out when it has none).
- **AG-UI**: `agora.ui` carries `fallbackText` and `componentVersions`; `agora.approval-requested` carries the proposal `target` (and `confirmation`); a proposal's interrupt has `metadata['agora.target']` and resuming it decides the proposal through the proposal service (it used to hit the parked-call approve and fail with `400`).
- **AG-UI event rename**: the proposal-decision custom event is now `agora.action-proposal-decision`, like every other `agora.*` event. The old `aviary.action-proposal-decision` is no longer sent — move listeners to the new name.
- `AgentService.chat` lost an unreachable proposal-decision branch (`chat` never decides by text; `send` does).
