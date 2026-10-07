---
'@adonis-agora/agent': minor
---

Fixes to generative UI, the React AG-UI client and `AuthActorResolver`:

- **GenUI text:** a `fallbackText` that returns an empty string renders nothing: a bare `Stack`, or a `Card` without a title, sent a JSON block of its props (`{}`) to text channels. In a tree, a layout's children still render.
- **GenUI tools:** outside tree mode, layout components (`children: true`, like `Stack` and `Card`) get no `ui__show_*` tool, and the generic show tool (`showTool`) no longer offers them. They could only push an empty container. **Behavior change:** compose layouts with `mode: 'tree'`.
- **`Chart` text:** the fallback draws every series instead of only the first. A bar chart gets one bar per series at each point, all on one scale. A line chart gets a sparkline per series (first → last, min/max) and the points as a table.
- **React over AG-UI (`agUiBackend()` / `agUiChatStream`):**
  - Files the composer uploaded are now sent with the turn, as media parts by `file` handle (`{ type: 'file', provider: 'agora', value: <mediaId> }`). Before, they were dropped.
  - Regenerate now sends `forwardedProps.regenerate`, so the answer is regenerated. Before, the question was posted again as a new turn.
  - Question sets (`agora.elicitation`) render as the normal question block.
  - Per-step usage, cost and model (`agora.step-usage`) reach `step-finish`.
  - A tool call keeps its kind (`read`/`action`).
  - An interrupt the stream already carried as an approval or a question set no longer also renders as `AgUiInterrupt`.
  - `ChatStreamRequest.files` describes the send's staged uploads, and `content(body, files)` receives them.
- **AG-UI producer (`agUiAdapter()`):**
  - Accepts a `file` handle with `provider: 'agora'` that names an upload it staged. The upload is resolved for the caller, as the native `attachments` refs are (`403` when it is not theirs).
  - Reads `forwardedProps.regenerate`.
  - `TOOL_CALL_START` carries `metadata['agora.toolKind']`, `agora.elicitation` carries the call `id`, and `agora.step-usage` carries the step's `model`.
- **`AuthActorResolver`:** the agent routes run no auth middleware, so `ctx.auth.user` was never set and every request was refused with `401`. When no guard has tried the request yet, the resolver now calls `ctx.auth.check()` itself; with the new `guards` option it calls `checkUsing(guards)` instead. Neither throws for an anonymous request, and the resolver still answers `401` when there is no user. `resolve()` is now async.
