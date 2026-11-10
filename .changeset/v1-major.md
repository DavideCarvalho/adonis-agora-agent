---
"@adonis-agora/agent": major
"@adonis-agora/agent-dashboard": major
---

1.0. Breaking changes (see "Migrating to 1.0" in the docs):

- `ChatQueueService`: the deprecated `personaFor` option is removed. Use `resolveTarget`.
- Sandbox kit: `genuiSandboxKit()`, `genuiKitHook()`, `writeSandboxKitDocs()` and `defineSandbox()` no longer check for the options replaced in 0.75 (`entry`, `include`, `css`, `tailwind`, `tailwindCss`), and `assertNoLegacyKitOptions` is no longer exported from `@adonis-agora/agent/genui/kit`. Use `components` and `styles`.
- React: `ApprovalTarget` drops the unused `{ kind: 'legacy' }` member; only `{ kind: 'proposal' }` remains.
- Requires Node 24 or later.

Also:

- The optional `@adonis-agora/*` peers (authz, diagnostics, durable, media, telescope) accept `<2.0.0`; `@adonis-agora/agent-dashboard` accepts `@adonis-agora/agent` `<2.0.0`.
- `@streamdown/code` 2 is accepted as a peer alongside 1.
