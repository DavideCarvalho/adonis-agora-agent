---
'@adonis-agora/agent': patch
---

Fix the `@adonis-agora/agent/hooks/tools` assembler hook, which `node ace configure` registers and which failed every build with `handler.handle is not a function` on @adonisjs/assembler 8.6: `toolsHook()` and the default export are now plain hook functions (as `@adonis-agora/durable` did for its hooks), matching the assembler's `LazyImport` hook type. If you called `toolsHook().run(...)` directly, call the returned function itself; with options, register `async () => ({ default: toolsHook({ ... }) })`.
