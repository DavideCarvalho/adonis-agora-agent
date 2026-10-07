---
'@adonis-agora/agent': patch
---

Fixes from a docs audit:

- `@AiTool` / `static tool` classes keep their `replacementKey` (it only worked with `defineTool`).
- `POST <path>/chat` answers malformed `uiCapabilities` with `400 invalid_ui_capabilities` instead of a `500`.
- A refused proposal decision over AG-UI (text or resume) answers its status (`403`/`404`) instead of a `500`.
- `UiCapabilities` / `validateUiCapabilities` have one definition; both the root and `/genui` entries still export them.
- Corrected stale comments (`genui` needs no extra peer, the default authorizer and actor resolver are not fail-closed, the migrations `configure` publishes) and removed a committed `.orig` file.
