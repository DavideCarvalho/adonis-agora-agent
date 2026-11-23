---
'@adonis-agora/agent': minor
---

Poppy client and connections: Personal Agent Protocol 1.0 (was Draft 0.3).

Breaking for code that uses `@adonis-agora/agent/poppy-client` directly:

- **Versions (3.4).** The client uses Companies that serve a 1.x version, directly or through `supported_versions` (same host, no redirects), and sends `Poppy-Version: 1.0` on every request with the Session header. `PoppyAgent` takes `extensions` (name → major version); each one the Company lists in that version is declared in `Poppy-Extensions`, and new values start a new Session. `version_unsupported` fetches `poppy.json` again past the cache. A Company on a port other than 443 needs `allowPorts` (or `insecureDev`), and its `organization.domain` includes the port.
- **Sessions (5).** The delegation is `poppy-delegation+jwt` in the `poppy_dlg` header. `session_ended` starts a new Session and sends the request again once; `invalid_session` is no longer retried. `company.fetchPage(url)` fetches a website page with the Session header, signed out, only on `organization.domain`.
- **Sign-in (4).** Direct Sign-In sends `prompt=consent` and is pushed (PAR) whenever the issuer lists `pushed_authorization_request_endpoint`; `startDirectSignIn(company, scope, { state })` sets the `state`. Every refresh proves the DPoP key the sign-in used, MCP tokens included (they're used as their `token_type` says; the `bearer` option is gone). `scopesForSignIn` asks for every scope still needed, the granted ones included, and `offeredScopes` reads the issuer's and the domain's `scopes_supported`. `auth.disabled` offers no sign-in type; `invalid_target` uses that service signed out; the device link must be on the issuer's host or `organization.domain`. The client metadata document no longer lists `extensions`.
- **Conversations (8).** Every POST carries a request `id` and messages have none (`requestId` option on `start`/`send`/`handoff`/`close`); responses are only `conversation_id` unless `wait` is set. The state is `working`/`handoff`/`responder`/`closed` (`readState`), `follow` yields `working` items and `untilSettled` ends when `working` is false. New: `cancelHandoff`, starting a Direct Conversation from a `user_requested` event without a message, `poppyProtocols` with each entry's `description`, `isFromCompany` / `authorTypeOf` for unknown roles and author types, `as_of_cursor` on the agent's own messages, and `ConversationError.protocolVersion` for `version_mismatch`.
- **Task coverage (9).** `taskCoverage(company)` reads `tasks.endpoint` once per Session (excluded tasks, skills, feedback endpoint); `excludedTasks` and `sendFeedback` use it.
- **Mediated Sign-In** reads version 1 of the extension from its list of versions.

Poppy connections: a step-up asks for the granted scopes plus the new ones, Direct Sign-In is pushed when the person opens the connect page, `poppy:browser-sign-in` is never requested, and `poppy_ask`'s `status` is `idle`, `waiting_for_person`, `with_person`, `closed` or `timeout`.
