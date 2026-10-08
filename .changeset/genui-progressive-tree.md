---
'@adonis-agora/agent': minor
---

Generative UI: draw a `ui__render` tree while the model writes it.

- **`genui({ streaming: 'partial' })`** (tree mode). The server parses the streaming `ui__render` arguments and pushes the tree so far as `ui` frames marked `partial: true`, under the id the final push replaces (`<toolCallId>:ui:0`). Previews are throttled (`streamingThrottleMs`, default 100 ms, and only when changed), never validated, never persisted, carry no `fallbackText` and are skipped by text channels; a turn whose client cannot draw the tree gets none. Only the final tree goes through the catalog; a preview the call does not replace (an invalid tree, a text fallback) is withdrawn with a partial frame whose `props` are `{}`. AG-UI sends the previews as repeated `agora.ui` events with the same id. The default stays `streaming: 'complete'` (today's behaviour), since renderers written for validated props would otherwise receive half-written ones.
- **Per component:** `defineComponent({ …, streaming: 'complete' })` holds a component back while its subtree is written — the node is a `{ held: true, props: {} }` placeholder until it closes — and `streaming: 'partial'` opts one in.
- **Stable nodes:** every node of a partial tree carries its position as `id` (`root`, `root.0`, …), the same rule that names the final tree's nodes, and `incomplete: true` while it is being written.
- **React:** `<GenerativeUI>` renders partial trees without remounting nodes, skips prop validation for incomplete nodes, exposes `useGenuiNode()` (`{ id, type, incomplete, held }`) for skeletons, and draws `placeholder` (new prop on `<GenerativeUI>` / `<GenuiProvider>`, default `loading`) for held nodes. The transcript drops withdrawn previews and those whose call settled without replacing them.
- **Framework-free client:** component parts carry `partial`; `foldPart` removes a withdrawn preview, and a finished stream drops leftovers (`settleParts`, exported).
- **Tool SPI:** `ToolHandler.previewInput(scope)` lets any tool preview its streaming input; `parsePartialJson` is exported.
