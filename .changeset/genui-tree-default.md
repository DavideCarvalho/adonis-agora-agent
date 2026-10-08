---
'@adonis-agora/agent': minor
---

Generative UI: tree mode is the default, with an exact `ui__render` schema.

**BREAKING:** `genui({ catalog })` (and `genuiTools`) now default to `mode: 'tree'`. An app that relied on the default gets ONE model tool, `ui__render`, instead of a `ui__show_<component>` tool per component:

- the model-facing tool names change (prompts, allow-lists, evals or approval policies naming `ui__show_*` must follow);
- the client needs a renderer for every layout component it lets the model use (`Stack`, `Card`, … from `LAYOUT_COMPONENTS`), since composed layouts now arrive as `genui:tree` frames;
- threads persisted before the upgrade keep rendering: their stored per-component `ui` parts are drawn by the same registry as before.

**Migration:** to keep the old behaviour, pass `mode: 'per-component'` — still fully supported, and the better fit for small models or when each tool should carry its own exact schema.

- **Exact schema.** `ui__render`'s input schema is now a recursive union by `type` (through `$defs` / `$ref`): each node variant carries its component's own props schema, and only components that take children have `children`. The root stays a plain object (OpenAI and Anthropic refuse a top-level union in tool parameters) listing every type and props schema. It follows the negotiated and per-request catalogs. A props schema that is not self-contained (a recursive Zod schema) is described as a plain object. `treeSchema: 'loose'` restores the previous generic node shape for a provider that refuses `$ref`. `validateTree` remains the check every call goes through.
- **Single-node trees.** `{ type: 'DataTable', props }` is a valid tree and is pushed exactly as `ui__show_data_table` would push it (same component frame, version and `fallbackText`), so tree mode covers the one-component case.
- The `node ace configure` config stub suggests `genui({ catalog: defineCatalog([...BUILTIN_COMPONENTS, ...LAYOUT_COMPONENTS]) })`.
