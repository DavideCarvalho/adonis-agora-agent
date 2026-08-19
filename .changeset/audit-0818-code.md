---
'@adonis-agora/agent': minor
'@adonis-agora/agent-dashboard': patch
---

Delegation is authorizable, the actor directory is consumed, and `dashboard` is part of the typed config.

- **`delegatesTo` accepts an object edge.** A synthesized `ask_<target>` tool goes through the same
  `RolesPolicy` gate as any other tool, and a bare-string edge carries neither `roles` nor `ability` —
  which is ADMIN-only under `DefaultToolAuthorizer` and an outright deny under `authzToolAuthorizer`,
  so delegation was unreachable under authz with no way to open it. `delegatesTo` now also takes
  `{ agent, roles?, ability? }` (`DelegateEdge`), whose annotation lands on the synthesized spec. Bare
  strings keep their existing fail-closed behaviour.
- **`ActorDirectory.resolveDisplay` is now called.** `actorDirectory` resolved into a provider field
  that was never read, so governance surfaces always rendered raw refs. Every governance route
  returning an `actorRef` now carries an optional `actorLabel`, filled from one batched directory
  lookup per page and omitted for unknown refs. Fail-soft: an unbound or throwing directory leaves the
  rows exactly as the read-model produced them.
- **`AgentConfig.dashboard` is typed.** The console's config block was read through an untyped
  `config.get('agent.dashboard')` string path, so writing it inside `defineConfig({ ... })` was an
  excess-property error. It is now a declared `AgentConfig` field and the provider reads it off the
  typed config.
- **`engines.node` is a range again.** Both packages published an exact version (`v22.23.2` /
  `v26.7.0`), which warns on install for every consumer on any other Node and hard-fails under
  `engine-strict`. Renovate's global `rangeStrategy: "pin"` had rewritten the ranges; `engines` is now
  excluded from pinning so it cannot happen again.
- JSDoc: the published source carried Portuguese doc comments (`sse.ts`, `spi/tool.ts`, `base-tool.ts`,
  `stores/factory.ts`, `rag/qdrant-store.ts`, `ai-tool-ref.ts`) — translated to English. Corrected the
  stale cost formula on `AgentGovernanceQueries` (it omitted the cache-token split), the attachment
  allow-list default (an exact-match list of 7 types, not `text/*`), and two NestJS-era references.
