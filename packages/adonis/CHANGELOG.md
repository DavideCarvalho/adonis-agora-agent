# @adonis-agora/agent

## 0.22.1

### Patch Changes

- [`f0a622a`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/f0a622aeadec938355f9b5f5f515e335b406e712) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Republishes with the updated `agent-dashboard` embed (`packages/adonis/dist/assets/spa`, copied at build time from `@adonis-agora/agent-dashboard`'s own `dist/spa`) — the console's visual-identity fix from `ce1d08f` (dark-by-default, Aviary token/font/radius parity) has no effect on hosts until this package is rebuilt and republished, since it embeds the dashboard's built assets rather than depending on it at runtime. No source change in `packages/adonis` itself.

## 0.22.0

### Minor Changes

- [`079da35`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/079da35e91f1eab93020212bb93686eaa8dd9bee) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ported the Nest ("Aviary") telescope extension's governance and RAG coverage onto `@adonis-agora/agent/telescope`, alongside the existing entry-backed providers:

  - **Governance-backed providers** (`agent-governance-providers.ts`): spend by model/actor, usage trend, run reliability (total/success-rate/failed/avg-duration/by-agent/trend), recent runs/tool-calls/threads, and the pending-approvals inbox — reading the SAME `AgentGovernanceQueries` read-model the `/agent/governance/*` routes and the standalone dashboard SPA already use, via a new package-internal registry `AgentProvider#boot()` populates (`src/telescope/governance-registry.ts`). Several Nest-reference panels have no equivalent on this SPI and are deliberately not ported — top-threads-by-cost, run retries, run duration percentiles, error-code breakdowns, and paged tool-calls/threads/runs tables — see that file's header for the full list and why.
  - **RAG providers** (`rag-data-providers.ts`): retrieval count, zero-hit rate, mean chunk count, and a retrievals/zero-hits trend, read off the `retrieved` diagnostic event `agent-loop.ts`'s inject-mode retrieval already publishes. Latency, score distribution, and store/collection breakdowns are NOT ported — the recorded event carries none of that data today; see that file's header for what widening the instrumentation would need.
  - **Host extensibility**: `agentTelescopeExtension({ providers, sections })` lets a host app append its own data providers and dashboard sections, mirroring the Nest reference (with the same `agent.`-prefix reservation on host providers).
  - The "Agent" dashboard gained four new sections (Spend & usage, Spend detail, Run reliability, Governance activity, RAG) binding to the above.

  No watcher and no dedicated `agent`/`agent-rag` entry types are contributed — confirmed against `@adonis-agora/telescope`'s current `TelescopeExtension` contract, which has no `watchers` hook and gives every `agora:agent:*` event the same generic `diagnostic` entry type. That's a real, documented SDK constraint (see `extension.ts`'s header), not an oversight: RAG and every other agent event share one capped `lib:agent` window as a result.

## 0.21.0

### Minor Changes

- [`58783fb`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/58783fb433fd3c641dc9a42b80eaba09f2c9a62b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `@adonis-agora/agent` now ships its own governance dashboard — `node ace configure @adonis-agora/agent` registers an embedded `dashboard_provider` that serves the `@adonis-agora/agent-dashboard` SPA straight out of `@adonis-agora/agent`'s own build (`../dashboard/dist/spa` is copied into `dist/assets/spa` at build time), so a new app needs no separate install or provider registration to get the console. Configure it via the same optional `config('agent').dashboard` block as before.

  This is purely additive: the standalone `@adonis-agora/agent-dashboard` package and its own `agent_dashboard_provider` keep working exactly as before for apps that already install and register it directly — both providers now share one implementation (`@adonis-agora/agent/dashboard`, a new subpath export) so their behavior is byte-for-byte identical. Register only one of the two in a given app; mounting both at the same path throws AdonisJS's "duplicate route" error at boot.

  `@adonis-agora/agent-dashboard`'s peer dependency floor on `@adonis-agora/agent` moves to `>=0.21.0` (the version that introduces the shared `@adonis-agora/agent/dashboard` export its provider now imports from); already-published `agent-dashboard` versions are unaffected.

## 0.20.0

### Minor Changes

- [`4e3a372`](https://github.com/DavideCarvalho/adonis-agent/commit/4e3a372e9ecf53ec4c34bbe31ab6177262b0dcd5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `GET`/`POST /agent/governance/pricing` and a Pricing panel in the console.

  The `pricingStore` bound to the agent (default-mirrored from a Lucid `store`, or opt-in for other
  backends) was already driving cost accounting for runs, but had no read/write surface of its own —
  operators had to reach for the database directly to see or change a model's per-1M-token rates. The
  two new routes expose `AgentPricingStore.listCurrentPrices()`/`upsertModelPrice()` behind the same
  authenticated + authorized governance gate as every other `/agent/governance/*` route, mounted only
  when a pricing store is bound. The dashboard's new "Pricing" section reads and edits rates through
  them.

- [`4e3a372`](https://github.com/DavideCarvalho/adonis-agent/commit/4e3a372e9ecf53ec4c34bbe31ab6177262b0dcd5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add a thread governance drill-down: `GET /agent/governance/threads/:id` and a `ThreadDetailView` you
  reach by clicking a row in the console's Recent threads table.

  `AgentGovernanceQueries` gets a new optional `threadDetail(threadId)` method returning the thread's
  metadata plus a lifetime usage rollup (total tokens, cost, run/message counts) and its most recent
  runs/messages — implemented in both `LucidGovernanceQueries` and `InMemoryGovernanceQueries`. It's
  optional so a third-party or pre-existing adapter that predates it doesn't break: the route responds
  `501` instead of the dashboard hitting a missing endpoint.

  The Recent threads and Tool calls panels also gain "Load more" pagination instead of a fixed row cap.

- [`4e3a372`](https://github.com/DavideCarvalho/adonis-agent/commit/4e3a372e9ecf53ec4c34bbe31ab6177262b0dcd5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `RunReliability` (from `GET /agent/governance/reliability`) gains two optional fields: `byAgent` (run
  and failure counts per agent, highest call count first) and `trend` (daily run/failure counts over the
  same range, oldest first) — implemented in both `LucidGovernanceQueries` and
  `InMemoryGovernanceQueries`. Both are optional so an adapter that predates them can keep returning the
  existing shape; the dashboard's Reliability section renders a trend chart and a by-agent breakdown when
  present and stays as before when absent.

## 0.19.1

### Patch Changes

- [`3377419`](https://github.com/DavideCarvalho/adonis-agent/commit/3377419676511876522258d6156ccf79a7b302a0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Type the MCP actor on `AuthInfo.extra`: the `authKitAuth()`/`apiKeyAuth()` strategies now return a typed `McpAuthInfo` (`extra: { actor: Actor }`), and `actorFromAuthInfo`/`isActor` are exported from `@adonis-agora/agent/mcp` so consumers no longer hand-roll a runtime guard. The MCP provider reuses the promoted helpers instead of its module-local copies.

## 0.19.0

### Minor Changes

- [`9a91190`](https://github.com/DavideCarvalho/adonis-agent/commit/9a91190936f24f912ccb756c58f490381f2b13c7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add an MCP (Model Context Protocol) endpoint that exposes the agent's ToolRegistry over Streamable
  HTTP.

  - New `./mcp` subpath: `defineMcpConfig`, `createMcpServer`, and two auth strategies — `authKitAuth()`
    (OAuth OIDC via `@adonis-agora/authkit-server`, resolved lazily) and `apiKeyAuth()` (constant-time
    key compare). The acting `Actor` resolves from the verified auth and gates `tools/list` /
    `tools/call` through the same role-checked registry the agent loop uses (fail-closed).
  - New `./mcp_provider` subpath: an Adonis provider that mounts `POST|GET|DELETE /mcp` plus
    `GET /.well-known/oauth-protected-resource/mcp` (RFC 9728 metadata when OAuth is configured), with
    per-session Streamable HTTP transports.
  - `configure` publishes `config/mcp.ts` via the new `config/mcp.stub`.

  The published `dist` ships `./mcp` and `./mcp_provider` export maps (mirroring `./agent_provider`).

## 0.18.0

### Minor Changes

- [`634c2df`](https://github.com/DavideCarvalho/adonis-agent/commit/634c2df384e90df85014d0ddb8e9c2215bb4c7b1) - **Security fix**: the cross-actor `/agent/governance/*` read-model is no longer mounted when no `governanceAuthorize` gate is configured.

  Previously these routes mounted whenever the governance read-model resolved — which happens **by default** whenever the main store is Lucid — and the `governanceAuthorize` gate was optional. With no gate, the gate evaluated to "allow", so **every authenticated actor could read the platform-wide governance data: every actor's spend, token usage, thread activity, run traces and pending HITL approvals.** Apps that never configured a gate got this by taking the default; the library only printed a boot warning, which is not a control. If your app has ordinary end users (not just trusted staff) as resolved actors, assume this data was readable by any of them.

  The cross-actor routes now mount **only when `governanceAuthorize` is set**. Without a gate they do not exist and return `404`. Affected routes:

  `GET /agent/governance/spend/model`, `spend/actor`, `usage/trend`, `tool-calls/recent`, `threads/recent`, `runs`, `runs/:id`, `approvals/pending`, `tools/stats`, `reliability`.

  **`GET /agent/approvals/mine` is unaffected.** It keeps mounting whenever the governance read-model resolves, gate or no gate — it is always scoped to the calling actor's own pending approvals, and non-admin surfaces (e.g. a chat page polling for its own suspended tool calls) depend on it.

  Two migration paths, both in `config/agent.ts`:

  ```ts
  // 1. The intended fix — mount the routes gated (typically an ADMIN check):
  governanceAuthorize: (actor) => actor.roles?.includes('ADMIN') ?? false,

  // 2. Deliberately keep the old open behaviour — explicit, greppable, reviewable:
  governanceAuthorize: () => true,
  ```

  Boot still succeeds without a gate: the provider warns (it does not throw) and names both paths.

- [`38106a9`](https://github.com/DavideCarvalho/adonis-agent/commit/38106a9d981b770dd755a2779810e27aa2a890f6) Thanks [@claude](https://github.com/claude)! - Three RAG capabilities: metadata that can be corrected without re-embedding, enumeration and bulk deletion that don't walk the corpus document-by-document, and a chunker that can be told where the records are.

  **`updateMetadata(documentId, patch)` — change a document's metadata without paying to re-embed it.** Optional on `VectorStore`, implemented by all three shipped stores, resolving to the number of chunks written. Until now the only way to change a chunk's metadata was `upsert`, which needs the text and a fresh embedding — so a consumer whose documents get re-classified had to choose between re-embedding a whole document to change one label, or not stamping the mutable dimension onto chunks at all and resolving it at query time instead, which turns a filter the index could apply into a join the caller has to do. The second is the one people actually pick, and it is what makes an actor-derived retrieval filter unaffordable: such a filter only pays off if the dimensions it filters on are _on_ the chunks and can be corrected when they change. `patch` is a **shallow JSON Merge Patch** — `null` deletes a key (said in those words on `MetadataPatch`, because "patch" alone does not tell you whether `null` deletes or stores a null), values replaced wholesale, `undefined` ignored, absent keys left alone. Text and embeddings are untouched; on pgvector the merge happens in SQL so `SET` structurally cannot name the embedding column, and on Qdrant it goes through `set_payload`, which has no vector field at all. Verified against Postgres 17 + pgvector 0.8.5 and Qdrant 1.18 asserting the stored vector is byte-identical afterwards.

  **`listDocumentIds(filter?)` and `removeWhere(filter)` — enumerate and drop in bulk, without a document-by-document walk.** Both optional on `VectorStore`, both on all three stores. Dropping a collection used to mean `listDocuments()` — which fetches and JSON-parses a metadata blob _per chunk_ only to collapse it to one entry per document — followed by one `remove()` per document: N+1 round trips where one filtered delete would do. (The Qdrant adapter had already grown a defensive page cap on that `listDocuments` scroll, which is the tell that an enumeration API was carrying work it is not shaped for.) `listDocumentIds` skips the per-chunk metadata entirely — a `SELECT DISTINCT` on pgvector, a one-key scroll on Qdrant. `removeWhere` deletes in one filtered statement and reports how many chunks went.

  Because `removeWhere` is the only call here that destroys data, it removes **exactly what a `search` carrying the same filter could reach, and never more**: every store builds the delete predicate with the very same filter builder its `search` uses, so the two cannot drift. The empty-array deny is honoured and means "delete nothing", not "no filter". And `removeWhere({})` throws `UnsafeRemovalError` instead of wiping the store, because an empty object is far more likely to be a filter that got built wrong than a deliberate request to delete everything — deliberate mass deletion stays explicit via `remove` over `listDocumentIds()`.

  **`chunkText(text, { separator })` — cut on the record boundary instead of guessing one.** The chunker breaks on the latest paragraph/sentence/word boundary in its window, which is right for prose and wrong for text whose boundaries _mean_ something: a spreadsheet flattened to one field-labelled record per line gets cut mid-record, so the half holding the row identifier lands in a different chunk from the half holding the value and neither can answer a question about that row. Pass `separator` and it becomes the only boundary the chunker may cut on. Two consequences, documented on the option: a record longer than `chunkSize` is emitted **whole** as its own over-size chunk rather than being cut (`chunkSize` becomes a target, not a cap — falling back to a mid-record cut would defeat the point, and an over-size chunk is visible where a mangled record is not), and `overlap` becomes a character _budget_ spent on whole trailing records, never a partial one. Reaches `ingestDocuments` for free.

  Nothing changes for existing callers: omit `separator` and the prose path is byte-for-byte what it was — guarded by frozen boundary cases and confirmed by a differential run over 20,000 random input × option combinations, because a shifted chunk boundary silently invalidates stored embeddings and is not something a minor release may do. All three store operations are **optional** on the `VectorStore` interface, so a host-written store that implements none of them still compiles.

- [`6d0d746`](https://github.com/DavideCarvalho/adonis-agent/commit/6d0d746ebe88da5f7931059ea544a5d2b63b7679) - **Security-relevant feature**: inject-mode RAG retrieval can now be scoped per actor via the new `retrievalFilter` config option — and **without it, retrieval remains unscoped**.

  Inject-mode RAG (setting `retriever` in `config/agent.ts`) retrieves passages for the user's message and folds them into the system prompt on every turn, but had no seam through which a host could supply a filter: `retriever.retrieve(text, { topK })` was called with no `filter` and no actor, so a host could not scope it even by wrapping the retriever. Any deployment that turns on `retriever` and shares one corpus across tenants was leaking passages across tenants into the system prompt, on every turn, for every user — the write side (`rag-media` ingestion tagging `tenantRef`/`ownerId`) and the store-level `filter` support (`pgvector`/Qdrant, both correct) already existed; nothing ever populated `filter`.

  `retrievalFilter?: (actor: Actor) => Record<string, unknown>` closes that gap: it derives the same `audience`-style ACL filter documented for manual/agentic retrieval, but from the run's actor, and applies it automatically inside the existing `hooks.step('retrieve', …)` (so durable replay determinism is unaffected). With no hook configured, the retriever receives options with no `filter` key at all (not `filter: undefined`) — existing single-tenant deployments are byte-identical. A hook that throws fails the turn rather than falling back to unfiltered retrieval.

  **Action for existing multi-tenant deployments using inject mode**: set `retrievalFilter` in `config/agent.ts`. Without it, you may have been retrieving across your entire corpus regardless of who is asking. See `docs/retrieval/rag.mdx`.

  Deliberately out of scope: the `Retriever` SPI is unchanged (third-party retrievers still satisfy it unmodified), and retrieved passages are still folded into the system prompt without fencing as untrusted data — the second half of this finding, tracked separately.

### Patch Changes

- [`63b9b08`](https://github.com/DavideCarvalho/adonis-agent/commit/63b9b08caa19a092965a465612215254fbb14997) - **No published version of either package is affected.** This is a repo-tooling fix with no runtime change — nothing in `src/` moved. Checked rather than assumed: the live tarballs for `@adonis-agora/agent@0.17.0` and `@adonis-agora/agent-dashboard@0.3.2` contain 105 and 13 `.js` files respectively, exactly what a full local build emits. The release workflow publishes from a cold `actions/checkout`, which has no `dist/` and no `.tsbuildinfo` to go stale, so the defect below could not reach npm. It could reach a contributor's working copy, and did.

  `pnpm build` could exit `0` having emitted no JavaScript. `tsc` ran with `incremental: true` against a `.tsbuildinfo` that records what it already wrote to `dist/`; delete `dist/` and leave the buildinfo behind and `tsc` concludes every output is current and emits nothing. In `@adonis-agora/agent`, `copy:stubs` is a plain `cp` and ran anyway, so `dist/` came out holding four stub files and zero `.js`. Turbo then cached that empty directory as a _successful_ `build` and replayed it onto clean trees — a later `pnpm build` on a freshly wiped checkout restored the vacuum as `FULL TURBO` in 32ms. Downstream, `packages/dashboard` failed with `TS2307: Cannot find module '@adonis-agora/agent'` against the package that had just "built".

  Both packages are fixed the same way:

  - `build` removes `dist/` up front and compiles through a new `tsconfig.build.json` with `incremental: false`, so an emit is always a full emit and no state survives to disagree with `dist/`.
  - A new `scripts/assert-build-output.mjs` runs as the last step of `build` and fails it if `dist/` holds no JavaScript or is missing the package entrypoint. It runs inside the build, so it also covers `prepack` — which never goes through turbo, and is the path a manual `pnpm publish` would take.
  - `build` and `typecheck` no longer share a buildinfo. `typecheck` keeps `.typecheck.tsbuildinfo`; `build` keeps none at all. `turbo.json` is unchanged.

  If you have a checkout in the broken state, the guard now prints the way out — and the command it prints works, which took a second pass to get right: the buildinfo files are dotfiles and a shell `*` does not match those.

  ```
  rm -rf dist .*tsbuildinfo *.tsbuildinfo
  pnpm run build
  ```

  The dashboard's exposure needed a different guard. Its `build` is `vite build && tsc`, and vite keeps populating `dist/spa/` whatever `tsc` does — a `dist/` with no provider in it still holds a dozen `.js` files. Counting JavaScript would have passed it, so `check:dist` there asserts the entrypoint by name.

  Neither a count nor a named entrypoint is enough on its own. A _partial_ emit was observed during this fix: `dist/` came out holding exactly one `.js`, `src/index.js`, which satisfies both checks — and because `index.d.ts` was there too, the dashboard compiled against it without a single `TS2307`. Every subpath export (`@adonis-agora/agent/rag-media`, `/durable`, `/testing`, …) pointed at a file that did not exist, and the first thing to notice would have been a consumer's failed import. So the guard also walks `package.json`'s `exports` and requires every target it declares. That list is the package's real publish contract, and it maintains itself — adding an export adds a post-condition, with nobody having to remember. It also covers `@adonis-agora/agent-dashboard/client`, which the by-name check never looked at.

- [`fa39b5f`](https://github.com/DavideCarvalho/adonis-agent/commit/fa39b5faef317fb47cf1fbb8fe29cec448270d21) - **If your governance console suddenly 404s, or every panel in it is failing: set `governanceAuthorize` in `config/agent.ts`.**

  ```ts
  // config/agent.ts
  export default defineConfig({
    // ...
    governanceAuthorize: (actor) => actor.roles?.includes("ADMIN") ?? false,
  });
  ```

  That one line brings both the console and its data back. If you deliberately want the old behaviour where any authenticated actor could read the platform-wide governance data, say so explicitly with `governanceAuthorize: () => true` — same effect, but greppable and reviewable.

  **Why.** The cross-actor `/agent/governance/*` read routes stopped mounting without a `governanceAuthorize` gate (see the previous `@adonis-agora/agent` release). Ten of the console's eleven read endpoints are those routes, and the SPA calls them **from the browser** — so an app with the dashboard installed and no gate got a console that loaded fine and then failed on every panel except Quota, with nothing in the logs explaining it.

  **What changed.** `@adonis-agora/agent-dashboard` now refuses to mount when the agent config has no `governanceAuthorize`, and logs a boot warning naming both fixes above. The console URL returns `404` instead of serving a shell that cannot work. Nothing that still worked is broken by this: every affected app already had a console dead in six of its seven views.

  Unaffected:

  - Apps that already set `governanceAuthorize` — no change whatsoever.
  - `dashboard: { enabled: false }` — still off, still silent, no warning.
  - `dashboard.authorize` — still an optional EXTRA gate on the SPA shell, unchanged. It is deliberately not what decides whether the console mounts: it gates the shell, not the data, so an app could set it and still have a console with nothing to render.
  - `GET /agent/approvals/mine` — never behind the governance gate; still mounted and still scoped to the calling actor.

  The `@adonis-agora/agent` half of this release is documentation only: the `governanceAuthorize` JSDoc and the `governance-gate.ts` comments still described the old open-by-default behaviour they no longer have. `evaluateGovernanceGate`'s behaviour is unchanged.

- [`58177f7`](https://github.com/DavideCarvalho/adonis-agent/commit/58177f718477ecdda362b6870b25225cff391759) - **Security fix**: `agent`-kind delegate tool calls now go through the same role/ability check and allow-list filter as every other tool call, instead of executing unconditionally.

  Previously, when the model emitted a tool call for an `agent`-kind (delegation) tool, the loop called `hooks.runAgent` directly at the loop level — it never went through `ToolRegistry.invoke`, so the `policy.can(actor, spec)` re-check, the Zod input validation, and the persona/agent allow-list filter (only applied when building the offered-tools set) were all skipped. A model steered by injected content — delegate tool names are advertised in sibling delegate descriptions — could name a delegate tool it was never offered and run it regardless of the actor's role or the agent's configured allow-list. The synthesized delegate specs carry no `roles` and no `ability`, so they were meant to be unreachable by a non-privileged actor; the loop ran them anyway.

  The delegation branch now: (1) fails closed if the delegate's spec cannot be resolved; (2) verifies the tool name is in the set actually offered to the model (the same persona/agent allow-list intersection used to build the offer); (3) re-checks `rolesPolicy.can(actor, spec)`. All three checks run _before_ the tool call is persisted and before the `agent.delegated` event is published, so a denied delegation is recorded `failed` — never `auto_executed`, even transiently.

  **Behaviour change for hosts using `AuthzToolAuthorizer`**: delegate tools carry no `ability` by design. Under an authz posture, a tool with no `ability` is _always_ denied — so after this fix, delegation will be denied for any actor unless the host explicitly declares an `ability` on its delegate tools. This is not a regression: it is what an authz-backed configuration with no `ability` on these tools always meant. Hosts that rely on delegation under `AuthzToolAuthorizer` need to declare an `ability` for their delegate tools (or otherwise grant it through their policy) to keep delegation working.

- [`3627aec`](https://github.com/DavideCarvalho/adonis-agent/commit/3627aece5817f93518154133b07a29fb4068e1ff) - `node ace add @adonis-agora/agent` now actually registers the provider and publishes the config and migration stubs, instead of silently warning "the module does not export the configure hook" and doing nothing. AdonisJS resolves the configure hook by importing the package's main entry and reading `configure` off the module namespace — it never reads the `./configure` subpath. The package main now re-exports `configure` from the package root so `node ace configure` finds it.

- [`f4f3fb1`](https://github.com/DavideCarvalho/adonis-agent/commit/f4f3fb1cdd0117f5a748a3088d4fdc032d6fa7fc) - **Security fix**: `dataTool`'s tenant scoping no longer treats a tenant predicate found under an `OR` as coverage.

  `TenantScopeRewriter.collectTenantPredicates` recursed into `OR` branches exactly as it did into `AND` branches, with no record of which boolean context it was in. Any tenant predicate found anywhere in a query's `WHERE` tree — including inside an `OR` — marked that table's alias "already scoped", so the rewriter added no constraint at all. A model-authored query of the form `... WHERE base_id = '<own tenant>' OR 1 = 1` (or any other disjunctive shape naming the caller's own tenant) passed through unconstrained and returned every tenant's rows from an allow-listed table.

  Coverage is now computed from the top-level `AND` spine only (`collectConjunctiveTenantPredicates`): a predicate under an `OR`, `NOT`, or any non-conjunctive operator no longer suppresses the AND-ed tenant constraint. The **mismatch rejection** is unchanged and deliberately still walks the _whole_ tree (`collectAllTenantPredicates`): a query naming a foreign tenant anywhere — even inside an `OR` — still throws `tenant scope: tenant mismatch`, rather than being silently AND-ed down to zero rows.

  **Behaviour change**: queries that previously passed through unconstrained because of an `OR`-side tenant predicate (e.g. `WHERE base_id = 'mine' OR 1 = 1`, `WHERE (base_id = 'mine' AND x) OR y`) are now correctly constrained — the emitted SQL gains an additional `AND <tenantColumn> = '<tenantRef>'`. A query whose tenant predicate is already on the top-level `AND` spine is unaffected (no duplicate predicate is added).

  A second, adjacent bug was found and fixed while implementing this: `andCondition` built the AND-tenant-predicate AST node without marking the pre-existing (possibly `OR`-rooted) `WHERE` as parenthesized. `node-sql-parser`'s printer only wraps a subexpression in `(...)` when a `parentheses` flag is explicitly set on it — without it, `AND`/`OR` print at the same precedence, left-to-right, so a real database (which applies standard SQL precedence, `AND` binding tighter than `OR`) would have misread the emitted text and applied the tenant constraint to only the last disjunct, silently re-opening the same bypass this fix closes. `andCondition` now always parenthesizes the existing WHERE before AND-ing.

- [`258e322`](https://github.com/DavideCarvalho/adonis-agent/commit/258e322c8454020f52d110b328514ff5478c1a60) - Delegation now applies the input-schema gate, closing the last of the three gates `ToolRegistry.invoke` applies.

  `invoke` gates every tool call on (1) the role/ability check, (2) input validation against `spec.inputSchema`, then (3) execution. `agent`-kind (delegate) calls are handled at the loop level and deliberately bypass `invoke` — the durable runner maps them to `ctx.child`, a ctx-level suspend point. The previous fix re-applied the role and allow-list gates to that branch but not the input gate, so a malformed delegate input was silently coerced instead of rejected: `extractTask` fell back to `JSON.stringify(input)`, and a model emitting `{ task: { nested: 1 } }` or `{ tsak: '...' }` delegated a JSON blob as the task string. Every other tool kind rejects that with `ToolInputInvalidError`.

  The delegation branch now validates `call.input` against the delegate spec's `inputSchema` and throws the same `ToolInputInvalidError`, after the role and allow-list checks so the ordering matches `invoke` (authorization first, then shape). The task handed to the target agent is derived from the validated value rather than the raw input. A rejected input lands in the existing `try/catch`, so it is recorded `failed` and never emits `agent.delegated`.

  This only rejects inputs that were previously mis-coerced; no public signature changes.

- [`c78c0f4`](https://github.com/DavideCarvalho/adonis-agent/commit/c78c0f4a1897f7aab5caf3ceb7857927dde934a6) - The optional `@adonis-agora/*` peer ranges (`authz`, `diagnostics`, `durable`, `telescope`) no longer point at a single already-superseded minor. On a `0.x` package `^0.x.y` means "this exact minor only," so every sibling minor bump silently made these ranges unsatisfiable against what's published on npm — a consumer installing any current sibling version got an `ERESOLVE`/warning wall. Ranges now use `>=<floor> <1.0.0`, matching the pattern already used by `agent-dashboard`'s peer on `agent` and `authz-react`'s peer on `authz`. The floor for each is the version this package was actually verified against (the one the dev install had resolved), not the current published version:

  - `@adonis-agora/authz`: `>=0.4.2 <1.0.0`
  - `@adonis-agora/diagnostics`: `>=0.1.0 <1.0.0`
  - `@adonis-agora/durable`: `>=0.8.0 <1.0.0`
  - `@adonis-agora/telescope`: `>=0.4.0 <1.0.0`

  The matching devDependencies were bumped to the current published versions (durable 0.20.0, telescope 0.6.0, authz 0.10.1, diagnostics 0.2.5) so this repo's typecheck and test suite actually run against current sibling APIs instead of many minors behind. No source changes were required — the integration code under `durable/`, `telescope/`, `authz/` and `diagnostics.ts` typechecked and passed its tests unchanged against the newer siblings.

## 0.17.0

### Minor Changes

- [#36](https://github.com/DavideCarvalho/adonis-agent/pull/36) [`0c3c1c0`](https://github.com/DavideCarvalho/adonis-agent/commit/0c3c1c01e52d588c9aaaae8d2467999937233687) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `QdrantStore.upsert` agora fatia os pontos em lotes (novo `upsertBatchSize`, default 100) em vez de um único request. Fontes grandes viram muitos chunks (ex.: PDF de ~200 páginas → ~700 pontos); enviar tudo num request só estourava o timeout default de 300s do `@qdrant/js-client-rest` (`QdrantClientTimeoutError: This operation was aborted`). Batchar mantém cada request pequeno e previsível — ingestão robusta pra qualquer tamanho de fonte.

## 0.16.0

### Minor Changes

- [#34](https://github.com/DavideCarvalho/adonis-agent/pull/34) [`5afc7e5`](https://github.com/DavideCarvalho/adonis-agent/commit/5afc7e5cab6de57abc8662e70fc4c72476015c96) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Adiciona um backend Qdrant (`QdrantStore implements VectorStore`) ao lado do pgvector, com a factory `retrievers.qdrant({ embedder, url, apiKey, collection, dimension, metric })`. O `@qdrant/js-client-rest` é peer dependency opcional (import lazy). Contratos `Passage`/`VectorStore` inalterados; uma collection só com filtro de payload (a mesma semântica de ACL por token do pgvector), id de chunk mapeado para UUIDv5 no ponto.

## 0.15.0

### Minor Changes

- Tool discovery now runs after `app.booted()` instead of during the provider's `boot()`. This lets `app/agent_tools` files use ordinary top-level imports of Adonis service singletons (e.g. `@adonisjs/lucid/services/db`) without the import throwing during boot (which, in a pruned production build, surfaced as `Cannot read properties of undefined (reading 'booted')` and left the tool missing). The tool registry is populated before the HTTP server accepts traffic, so no behavior changes for consumers.

## 0.14.0

### Minor Changes

- Add `RetrieveOptions.minScore` — a relevance floor applied to vector-store retrieval (passages with `score < minScore` are dropped before the top-K cut), enabling strict-grounding RAG. Also add per-agent `AgentDefinition.actorResolver`, letting an individual agent resolve its request actor differently from the global `config.actorResolver` (the per-agent resolver is preferred when present, falling back to the global otherwise).

## 0.13.3

### Patch Changes

- [`22b207e`](https://github.com/DavideCarvalho/adonis-agent/commit/22b207ed263192e8a34922b08d04821f3fa61d8d) - Tool discovery no longer aborts the whole scan when one tool file fails to import.

  The `app/agent_tools` readdir scan imported each file with no per-file guard, so a single tool whose module throws at import time (e.g. a top-level `@adonisjs/*/services/*` singleton resolving `app` as `undefined` during boot) took down the entire scan and left the agent with ZERO tools — which surfaces as the model "narrating" tool calls as text (it was never given any tools) rather than any visible error. Each import is now wrapped: a failing file is logged loudly (`app.logger`, else `console.error`) and skipped, so the other tools still register and the failure is diagnosable.

## 0.13.2

### Patch Changes

- [`88f70d8`](https://github.com/DavideCarvalho/adonis-agent/commit/88f70d851070767a70b1b1c7278a1a1e01f578f2) - Fix `tokenSinks.redis()` crashing at boot with "Cannot read properties of undefined (reading 'booted')".

  The Redis sink factory built its client by importing `@adonisjs/redis/services/main`, whose module-level `app` is `undefined` when the sink is resolved during `AgentProvider.boot` — so the sink threw at boot and, under `durable: true`, the first frame write hung (runs stuck at step 0). The sink factory now receives the app context (like store/quota factories) and resolves Redis via `app.container.make('redis')` with the live application, so it builds correctly. `SinkFactory` / `TokenSinkFactory` now take a `{ app }` context argument (a no-arg factory stays assignable, so existing custom sink factories keep working).

## 0.13.1

### Patch Changes

- [`293843c`](https://github.com/DavideCarvalho/adonis-agent/commit/293843c7fc6082453b80ab4b5272ca3cd31da887) - Redis token-stream sink: expire a run's replay keys instead of leaking them.

  The framework never calls the sink's `close()`, so the Redis multi-replica sink's per-run `chunks`/`state` keys accumulated forever. They now get a TTL (default **1h**, sliding window refreshed on every write — so a long run stays alive and a crashed run that never `end`s still expires). Configurable via `tokenSinks.redis({ ttlSeconds })`; set `0` to keep the previous retain-forever behaviour. Adds an optional `expire(key, seconds)` to the `RedisStreamClient` interface (the `@adonisjs/redis` adapter implements it; a bring-your-own client that omits it keeps working, just without the TTL).

## 0.13.0

### Minor Changes

- [`b684986`](https://github.com/DavideCarvalho/adonis-agent/commit/b68498606a02e82dc92d01a7aa139eb6ba752bee) - Add a framework-agnostic browser client and a React hook for the chat SSE endpoints.

  Consuming the agent's SSE envelope (`POST /agent/chat` → `event: meta` / `data: {delta}` / `event: component` / `event: done`) and reconnecting a dropped stream used to be re-implemented by hand in every app. Two new entry points move that logic into the package, next to the server that emits the envelope:

  - **`@adonis-agora/agent/client`** — zero-dependency, isomorphic. `createAgentChatClient({ basePath, fetch, getHeaders, resume })` returns `send()` / `resume()` that post a turn, parse the envelope, capture the run id, and — when the connection drops before `done` — re-attach to `GET /agent/chat/:runId/stream` (which replays the whole stream from the start and follows live) with backoff, until the run finishes or the retry budget is exhausted. The run is durable and keeps executing server-side across the drop, so no tokens are lost. Also exports the parsing primitives (`parseSseEvent`, `decodeFrame`, `foldPart`, `readSseStream`) and `AgentChatDisconnectedError` (which carries the partial parts).
  - **`@adonis-agora/agent/react`** — `useAgentChat({ ...clientOptions, buildBody })` returning `{ messages, status, error, send, cancel }`, a thin state wrapper over the client. `react` is a new optional peer dependency.

## 0.12.0

### Minor Changes

- [`0998975`](https://github.com/DavideCarvalho/adonis-agent/commit/0998975ca76b88c84b5e428139af0f363f28abbb) - Generative UI: typed stream frames (`text`|`component`), `AiToolCtx.emitComponent`, and `event: component` in the SSE provider. Backward compatible for text-only consumers.

### Patch Changes

- [#29](https://github.com/DavideCarvalho/adonis-agent/pull/29) [`fd77544`](https://github.com/DavideCarvalho/adonis-agent/commit/fd77544040bdf8d95c532f3f70c6bd7673cec4ca) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix agent tool-loop dropping tool results. `mapMessages` in the AI SDK adapter skipped `toolResults` on `role: 'user'` messages (early `continue`), but `agent-loop` feeds tool output back as a synthetic `{ role: 'user', content: '', toolResults }` carrier — so the results were silently dropped and the follow-up model call threw `AI_MissingToolResultsError`. The user branch now emits the `tool` result message (via a shared `pushToolResults` helper) and skips the empty user turn so the tool result stays adjacent to the assistant tool-call. Multi-step tool-calling now completes for OpenAI-compatible providers.

## 0.11.0

### Minor Changes

- [#31](https://github.com/DavideCarvalho/adonis-agent/pull/31) [`315eb41`](https://github.com/DavideCarvalho/adonis-agent/commit/315eb41839bff2903e96481e7ca98881accdd8cd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Tools de classe agora são instanciados pelo **container do Adonis**, então `@inject` no construtor funciona — o app deixa de fazer service-locator (`app.container.make(...)`) dentro do `execute()`.

  ```ts
  @inject()
  export default class ReatribuirPesquisa extends ActionTool<Input, Result> {
    constructor(private allocation: CoordinatorAllocationService) {
      super();
    }
    static tool = {
      name: "reatribuir_pesquisa",
      description: "…",
      input,
      ability,
    };
    async execute(input, ctx) {
      return this.allocation.reassign({
        ...input,
        coordinatorId: ctx.actor.id,
      });
    }
  }
  ```

  A resolução é **lazy** (no primeiro `execute`) e cacheada: a descoberta roda no `boot()` do provider, antes do app estar totalmente booted, então um `container.make()` eager poderia falhar resolvendo um peer service — o mesmo motivo pelo qual a store factory do Lucid resolve lazy. Tools sem dependências continuam funcionando iguais.

  `discoverTools`, `registerToolsFromBarrel` e `registerToolExport` aceitam um `app?: ApplicationService` opcional (o provider passa `this.app`); sem ele, o comportamento pré-DI (`new Ctor()`) é preservado. `registerToolExport` continua síncrono.

## 0.10.1

### Patch Changes

- [#29](https://github.com/DavideCarvalho/adonis-agent/pull/29) [`6f0465d`](https://github.com/DavideCarvalho/adonis-agent/commit/6f0465d0fcedd3f826687154f60317d180e56651) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix agent tool-loop dropping tool results. `mapMessages` in the AI SDK adapter skipped `toolResults` on `role: 'user'` messages (early `continue`), but `agent-loop` feeds tool output back as a synthetic `{ role: 'user', content: '', toolResults }` carrier — so the results were silently dropped and the follow-up model call threw `AI_MissingToolResultsError`. The user branch now emits the `tool` result message (via a shared `pushToolResults` helper) and skips the empty user turn so the tool result stays adjacent to the assistant tool-call. Multi-step tool-calling now completes for OpenAI-compatible providers.

## 0.10.0

### Minor Changes

- [#27](https://github.com/DavideCarvalho/adonis-agent/pull/27) [`426b504`](https://github.com/DavideCarvalho/adonis-agent/commit/426b5040203fae41bb6a6fcc79ac5dbc0e9bc0ad) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Novas bases kind-específicas `ReadTool` e `ActionTool` (além do `BaseTool`): fixam o `kind` no base, então a subclasse escreve `static tool = { name, description, input, ability }` **truly bare** — sem `satisfies AiToolOptions` e sem a anotação `: AiToolOptions`. Antes o `kind: 'read' | 'action'` do `BaseTool`/`AiToolOptions` forçava um dos dois (a estática herdada não dá contextual-typing, então o literal alargaria `kind` para `string`). A descoberta lê o `kind` da estática do base. Exporta também `BaseToolOptions` (= `Omit<AiToolOptions, 'kind'>`).

## 0.9.0

### Minor Changes

- [#25](https://github.com/DavideCarvalho/adonis-agent/pull/25) [`e726f1f`](https://github.com/DavideCarvalho/adonis-agent/commit/e726f1fdcc13e479ffc10c150dc4148bc18efdfb) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Novo `BaseTool` (classe base opcional para a forma de classe de um tool) — o análogo do `BaseWorkflow` do durable. Declarar `static tool = { … }` numa subclasse de `BaseTool` é type-checado pela estática herdada (`static tool?: AiToolOptions`), sem precisar de `satisfies AiToolOptions`. `ToolHandler<I, O = unknown>` e `defineTool<I, O>` passam a tipar o retorno do `execute` (antes `Promise<unknown>`), então o compilador confere o corpo contra o que o tool promete. Ambos non-breaking (defaults preservam o comportamento anterior).

## 0.8.0

### Minor Changes

- [#23](https://github.com/DavideCarvalho/adonis-agent/pull/23) [`19c9ffd`](https://github.com/DavideCarvalho/adonis-agent/commit/19c9ffd9c285c7cab4e487c8bda73f7ce668be9e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `authzActorResolver` (exported from `@adonis-agora/agent/authz`) — resolve the agent `Actor` from the Agora context populated by authkit (`userRef`, `tenantId`) plus authz `effectiveRoles` (the union global ∪ app ∪ store). Structural, zero hard dependency; authkit+authz apps can drop hand-written actor resolvers. Fail-closed: no identity in context → 401.

## 0.7.1

### Patch Changes

- [#21](https://github.com/DavideCarvalho/adonis-agent/pull/21) [`d02b26b`](https://github.com/DavideCarvalho/adonis-agent/commit/d02b26bea2acd8d6f7daac166116a6813d321a02) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Internal: simplify `readAiToolMeta` metadata resolution

  Refactor the tool-metadata lookup so the two authoring mechanisms (`@AiTool`
  decorator and `static tool`) and the two subjects (the value, its constructor)
  are composed explicitly — `metaOn(target) ?? metaOn(ctor)` — instead of a flat
  four-way fallback chain. No behavior or API change; discovery of both forms is
  unchanged (mutation-proven).

## 0.7.0

### Minor Changes

- [#19](https://github.com/DavideCarvalho/adonis-agent/pull/19) [`c3d7b14`](https://github.com/DavideCarvalho/adonis-agent/commit/c3d7b140cdf32ef4324e18d84a13860ff0eb1a7c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add a decorator-free `static tool` authoring form for class tools

  A tool class can now declare its metadata with a `static tool = { name, kind, description, input, … }`
  config instead of the `@AiTool({ … })` decorator — the same shape, mirroring
  `@adonis-agora/durable`'s `static workflow`. Discovery, registration, and execution are identical;
  `readAiToolMeta` now reads the static config when no decorator is present.

  ```ts
  import type {
    AiToolCtx,
    AiToolOptions,
    ToolHandler,
  } from "@adonis-agora/agent";
  import { z } from "zod";

  export default class GetWeather implements ToolHandler<{ city: string }> {
    static tool = {
      name: "getWeather",
      kind: "read",
      description: "Get the weather",
      input: z.object({ city: z.string() }),
    } satisfies AiToolOptions;

    async execute(input: { city: string }, ctx: AiToolCtx) {
      return { tempC: 21 };
    }
  }
  ```

  The `@AiTool` decorator and the functional `defineTool(...)` forms are unchanged.

## 0.6.0

### Minor Changes

- [#17](https://github.com/DavideCarvalho/adonis-agent/pull/17) [`ea6122f`](https://github.com/DavideCarvalho/adonis-agent/commit/ea6122f468f5308d3506461fb2bd2d7fc3159ef5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Owner-scope the per-actor run/thread routes (object-level authorization)

  Follows up `0.5.0` (which authenticated these routes) by adding the ownership check: authentication
  alone let any authenticated caller act on ANOTHER actor's run/thread by id. Now a caller may act only
  on runs/threads it OWNS, unless it is governance-privileged.

  - **Run routes** — `GET /agent/chat/:runId/stream`, `POST /agent/chat/:runId/cancel`,
    `POST /agent/tool-call/approve`, `POST /agent/tool-call/reject` — now assert the resolved actor owns
    the run (the run's `actor_ref`, recorded as the loop's first step). A non-owner gets `403`; an
    unknown run gets `404` (so an id the caller doesn't own is never confirmed).
  - **Thread routes** — `GET /agent/threads/:id`, `DELETE /agent/threads/:id`,
    `POST /agent/threads/:id/fork-from/:messageId`, and `POST /agent/chat` when it continues an existing
    thread (`body.threadId`) — now assert the actor owns the thread. The chat case is the important one:
    without it an authenticated caller could pass another actor's `threadId` to load that thread's full
    history into the model (and read it back over SSE) and append its own turn into the victim's thread.
  - **Cross-actor override.** A caller that passes `governanceAuthorize` (the app's "may act across
    actors" seam, typically an ADMIN check) may act on any run/thread. With no `governanceAuthorize`
    configured, ownership is strict — no cross-actor access.

  New `AgentStore` SPI methods back the checks: **`getRunActorRef(runId)`** and
  **`getThreadActorRef(threadId)`** (both return the owning `actor_ref` or `null`), implemented on the
  Lucid and in-memory stores. A custom `AgentStore` implementation must add them. Also exposes the
  router-free `evaluateOwnership` helper and the `OwnershipVerdict` type, and `AgentService.runOwner` /
  `AgentService.threadOwner` passthroughs.

## 0.5.0

### Minor Changes

- [#14](https://github.com/DavideCarvalho/adonis-agent/pull/14) [`5de6247`](https://github.com/DavideCarvalho/adonis-agent/commit/5de6247c95a1f92fc92ba89bd1eaa2e89d0ba4ba) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Authenticate the mutation/lifecycle routes and gate the cross-actor governance read-model

  Closes a privilege gap surfaced the first time the routes were mounted behind a real app's
  auth. Previously several `/agent/*` routes were reachable without resolving an actor, and the
  `/agent/governance/*` read-model was readable by any authenticated caller regardless of role.

  - **Every `/agent/*` route now resolves the actor (401 on failure).** `chat/:runId/stream`,
    `chat/:runId/cancel`, `tool-call/approve`, `tool-call/reject`, `threads/personas/catalog`,
    `threads/:id` (GET/DELETE), and `threads/:id/fork-from/:messageId` previously ran with no
    actor resolution — an anonymous same-origin request could re-attach a run's token stream,
    cancel a run, or deliver a HITL approve/reject decision. They now go through the same resolver
    (and 401) as `chat`/`threads`/`quota`. The stream route authenticates via the request's
    session/cookies, so an `EventSource` re-attach still works. Apps that configured an
    `actorResolver` (the norm) are unaffected on legitimate calls; an app with no resolver now
    correctly 401s these routes instead of serving them anonymously.

  - **New `governanceAuthorize?: (actor, ctx) => boolean | Promise<boolean>` config option.** When
    set, each `/agent/governance/*` route runs it after resolving the actor and replies `403` on
    deny (fail-closed if it throws) — so the platform-wide spend/usage/threads/approvals read-model
    can be restricted (typically ADMIN-only). Omitted, governance stays readable by any resolved
    actor (the historical behavior). Mirrors `@adonis-agora/agent-dashboard`'s `authorize` hook so
    the JSON routes and the console SPA can be gated with the same predicate. Exposed as
    `evaluateGovernanceGate` (a router-free, unit-tested helper) and the `AgentGovernanceAuthorize`
    / `GovernanceGateVerdict` types.

  - **New `GET /agent/approvals/mine` route.** Returns the calling actor's OWN pending HITL
    approvals (`pendingApprovals({ actor })`, filtered by the owning run's `actor_ref`). It is
    mounted with the governance read-model but is NOT behind `governanceAuthorize`, so a non-admin
    surface (e.g. a coordinator's chat) can poll its own suspended tool calls even while the
    cross-actor `governance/approvals/pending` inbox is ADMIN-only.

## 0.4.1

### Patch Changes

- [#8](https://github.com/DavideCarvalho/adonis-agent/pull/8) [`8763c29`](https://github.com/DavideCarvalho/adonis-agent/commit/8763c29c43c4f766bc3f80e25d6e19f4e0c8aa6e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix `app/agent_tools` discovery registering nothing in a dev/TypeScript app

  The `app/agent_tools` scanner picked which module extension to import from
  `extname(import.meta.url)` — the extension of the SCANNER's own file. Since the
  package ships compiled (`.js`), that was always `.js`, so an app running from
  TypeScript source under a loader (`app/agent_tools/*.ts`, no build barrel wired)
  had its directory scanned for `.js` files, matched none, and registered zero
  tools — the agent silently ran with an empty `ToolRegistry`.

  The extension is now derived from what the scanned directory actually holds
  (`.ts` when it has any non-declaration `.ts` file, else `.js`). At runtime an app
  runs from EITHER its source or its build — never both in one directory — so this
  still guarantees a built `.js` and a dev `.ts` of the same module never
  double-register. `.d.ts` declarations are still skipped.

## 0.4.0

### Minor Changes

- [#6](https://github.com/DavideCarvalho/adonis-agent/pull/6) [`363382b`](https://github.com/DavideCarvalho/adonis-agent/commit/363382b5bd182f8de6184cd1c509209113710111) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `pricingStore` and `governanceQueries` now default to mirroring the main `store`.

  When `store` is a `stores.lucid()` store, the agent now defaults the pricing store and the governance read-model to a Lucid store on the **same connection** (tables auto-created) with no extra config — so cost tracking and the `/agent/governance/*` routes work out of the box. Previously both were opt-in and omitting them left cost `null` and the governance routes unmounted.

  - Override by passing a factory/instance as before (e.g. a different connection, or `pricingStores.memory()` for tests).
  - Set `pricingStore: false` / `governanceQueries: false` to disable (cost stays `null`; governance routes not mounted).
  - When the main store is not Lucid, both stay off unless set explicitly.

  Adds `lucidStoreConnection(factory)` to read a `stores.lucid()` factory's connection (used internally for the mirroring). The `@adonis-agora/agent` peer range on `@adonis-agora/agent-dashboard` widens to `^0.4.0`.

## 0.3.1

### Patch Changes

- [#4](https://github.com/DavideCarvalho/adonis-agent/pull/4) [`487ad72`](https://github.com/DavideCarvalho/adonis-agent/commit/487ad7265d512ab27b67a5b25802591f8719923c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix an app-boot crash when configuring the Lucid store, pricing store, or governance read-model via the factory helpers.

  `stores.lucid()`, `pricingStores.lucid()`, `governanceQueries.lucid()`, and the pgvector retriever resolved the Lucid `Database` from `@adonisjs/lucid/services/db`'s default export. AdonisJS assigns that default only inside `app.booted()` — after every provider's `boot()` — but the agent provider builds these stores eagerly during its own `boot()`, so the default was still `undefined` and `db.connection(...)` threw a `TypeError`, failing the whole app boot. They now resolve the `Database` from the container via the `'lucid.db'` alias (registered in the database provider's `register()`, so it is available during boot) — the same binding `services/db` itself resolves. No public API change.

## 0.3.0

### Minor Changes

- [#2](https://github.com/DavideCarvalho/adonis-agent/pull/2) [`3ed796f`](https://github.com/DavideCarvalho/adonis-agent/commit/3ed796f5106416726526651088fb98c1d2495172) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `autoCreateTables` now defaults to **`true`** for the Lucid stores — the agent lib manages its own
  schema by default, completing the ecosystem convention (mirrors `@adonis-agora/durable` and
  `@adonis-agora/authz`). On first use a store provisions the six shared agent tables with `CREATE
TABLE IF NOT EXISTS`; set `autoCreateTables: false` (on `stores.lucid`, `pricingStores.lucid`, or
  `governanceQueries.lucid`) to opt out and run the published migration instead.

  Crucially, provisioning is no longer the agent store's job alone: the **pricing store** and the
  **governance read-model** also auto-provision on first use, sharing one memoized `CREATE TABLE` pass
  per db client (new exported `ensureAgentTables`). This closes two real gaps — seeding model prices
  before the first agent run, and opening the governance dashboard on a fresh deploy — that the
  store-only auto-create left broken.

  The dashboard's peer range is bumped to `@adonis-agora/agent@^0.3.0`.

## 0.2.0

### Minor Changes

- [`f1fea00`](https://github.com/DavideCarvalho/adonis-agent/commit/f1fea00e165ef6d106fa67ed9ceda6e03ddbca3b) - Suporta `@adonis-agora/durable` 0.8.x (o peer passa de `^0.7.0` para `^0.8.0`).

  O durable 0.8.0 removeu o decorator `@Workflow`, que o `AgentRunWorkflow` usava, em favor de
  `BaseWorkflow` + `static workflow = { name, version }`. Instalar agent 0.1.0 ao lado de durable
  0.8.0 derrubava o modo durable inteiro — `TypeError: (0 , Workflow) is not a function` ao carregar
  o módulo, com o provider caindo silenciosamente no runner inline. O `^0.7.0` barrava a combinação,
  então ninguém instalou os dois juntos; o preço era ficar preso ao durable 0.7.

  O `AgentRunWorkflow` agora estende `BaseWorkflow` e declara `static workflow`. O resto da
  integração (`WorkflowEngine.start/signal/cancel`, `registerWorkflowClass`, `WorkflowSuspended`,
  `ContinueAsNew`, `WorkflowCtx`) não mudou.

  O bug nasceu de um vão de teste: o `durable` não era devDependency, então o lockfile resolvia
  0.7.0 e a suíte exercitava o runner durable contra a versão antiga — verde e cega para o 0.8.0.
  Agora é devDependency em `^0.8.0`, e os testes rodam contra a mesma versão que o peer promete.
