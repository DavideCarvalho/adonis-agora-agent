---
'@adonis-agora/agent': minor
---

Poppy conversations (`@adonis-agora/agent/poppy`) now implement Personal Agent Protocol 1.0 (was Draft 0.3). Breaking for the conversation wire format and the `PoppyConversations` API:

- Every POST carries a top-level request `id` (`{ "id": "…" }` for handoff, cancel and close); the message has no `id` of its own and is recorded with its request's. A reused id with another path or body is `request_id_conflict` (was `message_id_conflict`).
- POSTs answer only `{ conversation_id }` (`201` to start, `202` otherwise — close included, also on a closed conversation); reads report the state as `working`, `handoff` (`none`/`pending`), `responder` and `closed` instead of `status`. `state` events carry `handoff`, `responder` and `closed`; streams send `working` events.
- New `POST {endpoint}/{id}/handoff/cancel`, with an optional `handoff.withdraw` hook. While a handoff is pending the Company Agent keeps answering; messages it had not taken up when a person joins go to `handoff.message`.
- Direct Conversations can accept a `user_requested` event with `user_requested_event_id`, with or without a message (the Company Agent then speaks first, `texts.userJoined`); a nested parent is `invalid_request`. `requestUser` answers the event's id.
- `Poppy-Version` is required (`version_unsupported` otherwise); conversations record their protocol version and extensions, and `continueVersion` can refuse a request in other versions with `version_mismatch`. The principal may carry `protocolVersion`/`extensions` from the resolver.
- Messages: `context` fields set to `null` are cleared, unknown `author.type` counts as `agent`, `as_of_cursor` is kept and Company Agent replies carry `as_of_request`.
- `description` in `config/poppy.ts` (default `'Can help with anything.'`) is announced with the endpoint in `Symbol.for('@adonis-agora/poppy:endpoints')`, for the required `description` of the `poppy.json` entry.
- The Lucid store adds its new columns to existing tables; rows from before read as before.
