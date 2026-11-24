---
"@adonis-agora/agent": minor
---

Poppy conversations (Company side) implement the optional parts of Personal Agent Protocol 1.0:

- **Operations extension (v3)**: for a personal agent that declares `"operations";v="3"`, an action that waits for approval is not run — the Company Agent's reply carries `extensions.operations.operation`, and the action runs, at most once, when the personal agent sends `extensions.operations.approval` in a later message. Declines answer `extensions.operations.declined`; a stale approval gets a new revision. Operations are stored and verified by the service in `Symbol.for('@adonis-agora/poppy:operations')` (AuthKit); without it they stay off. New config: `operations`.
- **Links and Disclosures extensions**: `postMessage(id, { links, disclosures })` and the new `replyAddons` hook send them as `extensions.links` / `extensions.disclosures` to a personal agent that declares them, and in the text otherwise. Messages keep and return their extension content; links and disclosures from a personal agent are ignored.
- A response carrying an `authorization` event also has the matching `WWW-Authenticate` challenge.
- A reply written after its process died keeps its `as_of_request`.
- `runA2aTurn` takes an optional `onParked` hook to decide parked actions before the policy.
