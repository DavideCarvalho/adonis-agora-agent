---
"@adonis-agora/agent": minor
---

Security: MCP sessions are bound to their caller and bounded, and thread ids are validated before they reach a response header (GHSA-m2qv-2rj8-3883, backported to 0.x).

- MCP (stateful mode): a session belongs to the caller (token client and actor) that opened it; another caller's request on its id answers `403`. Sessions are capped per caller (`sessions.maxPerPrincipal`, default 16; the caller's least recently used session is closed to make room) and per endpoint (`sessions.max`, default 1000; past it `initialize` answers `503`), and a session unused for `sessions.idleTimeoutMs` (default 30 minutes) is closed. Configure them under `sessions` in `config/mcp.ts`. An unknown or expired session id now answers `404` (was `400`), so clients initialize again.
- `POST /agent/chat` and the A2UI route: a `threadId` must be 1-200 letters, digits or `_ - . : @`, starting with a letter or digit; anything else answers `400 { code: 'invalid_thread_id' }`. The `X-Agent-Thread-Id` header is only written for valid ids.
