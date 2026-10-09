---
'@adonis-agora/agent': minor
---

Generative UI and approvals, from a real-model pass:

- `ui__render` takes a malformed call as meant when that is unambiguous: an element that left out its `{ type, props }` envelope (`{ props: { html, … } }` or the bare props) when exactly one component's schema fits, props written beside `type`, an element wrapped in one more key (`{ props: <element> }`, `{ root: "{…}" }`) or named under `component` / `root`, stringified `props`, and stringified arguments that wrote `>` for a key's `:`. `normalizeTreeInput(catalog, args)` applies the same reading for a client that draws a call from its arguments. The tool's description shows the envelope with an example from the catalog.
- `componentTools: ['Sandbox']` (tree mode) also registers a flat `ui__sandbox` tool whose input is the sandbox's props — no envelope to leave out. On `claude-haiku-5.5` it took the bill-splitter sandbox from 11 of 16 runs with a refused first call to 0 of 16.
- The transcript leaves out a failed tool call the model retried at once with the same tool (`retriedCallIds`; `hideRetriedFailures: false` keeps every attempt).
- Approvals carry the tool's `presentation.confirm` filled from the call's input on the server (`fillToolConfirmation`), so AG-UI, A2UI, OpenUI and A2A clients show "Refund order #1002?" rather than "Approve refund_order?". The AG-UI interrupt carries the whole confirmation as `metadata['agora.confirmation']`; the A2UI approval surface shows its `detail` and words the button with its `verb`.
