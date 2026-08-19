---
'@adonis-agora/agent': patch
---

Fix `node ace configure @adonis-agora/agent`, which was broken in every published version.

The configure codemod runs each stub through Tempura, which compiles the stub **body** into a JavaScript
template literal. A bare backtick in the body closes that literal; a bare `${` opens an interpolation.
All four published stubs were full of both, in ordinary JSDoc prose — `` `lucid` ``, `` `model` ``,
`` `${documentId}#<n>` `` — so every one of them threw at render time.

`configure` therefore aborted on the very first stub, *after* `updateRcFile` had already succeeded. The
result was worse than nothing happening: `adonisrc.ts` came out referencing the agent and dashboard
providers while `config/agent.ts` was never written, leaving an app that could not boot.

Both constructs are now backslash-escaped in the stub bodies (`` \` ``, `\${`). This is a render-time
concern only — the generated files are **byte-identical** to what the stubs always intended, backticked
prose and all, which was verified against the pre-fix sources.

The reason no gate caught this: every stub harness here rendered by stripping the `{{{ }}}` header with a
regex and using the remainder, which is not what the generator does. A gate that renders differently from
the generator is not testing the generator. All of them now render through the real engine
(`app.stubs.create().build().prepare()`), and a new `stub-render.spec.ts` asserts that every stub
`configure.ts` publishes actually renders — including the two config stubs, which no test had touched.

Users on an earlier version who ran `configure` and saw it fail should re-run it after upgrading; if
`adonisrc.ts` already lists the providers, the codemod is idempotent and only the missing files are written.
