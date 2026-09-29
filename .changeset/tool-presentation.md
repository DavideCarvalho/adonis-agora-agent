---
'@adonis-agora/agent': minor
---

Tools can declare how a chat surface talks about them: `presentation` on `defineTool`, `@AiTool` and `static tool` (`label`, `running`/`done` templates over the call's input, `icon`, `tone`, `confirm` for the approval prompt, `result` for how the output reads) — the `ToolPresentation` shape of `@dudousxd/nestjs-agent`. It is never shown to the model. `GET <path>/tools?agent=` serves `{ name, kind, presentation? }[]` for the tools the caller can reach (the same list the model is offered, via the new `ToolRegistry.visibleSpecs`; `404` for an unknown agent), which `@dudousxd/nestjs-agent-react`'s `useToolCatalog` reads.
