# @adonis-agora/agent-dashboard

## 0.6.1

### Patch Changes

- [`89c35f0`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/89c35f01b698715a4b39ae36b0bea9abd151499b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fixed three visual bugs found while running the console against real seeded data end-to-end (Chrome DevTools MCP, not just source-level review):

  - The "Set a price" form's cache-write/cache-read rate inputs had no minimum width, so their placeholder text ("cache write $/1M (optional)") was clipped mid-word by unconstrained flex-shrink. They now carry a `min-width` so the full placeholder is always legible; the row already wraps, so this never comes at the cost of a broken layout on narrow screens.
  - The shell's footer always rendered `Read-only governance data · {fromDay} → {toDay}`, even on the eight sections (Runs, Threads, Tool calls, Approvals, Tools, Reliability, Quota, Pricing) that are not scoped by that date range at all — visibly contradicting the data shown (e.g. a Runs row dated before the claimed range start). The range now only appears while Overview, the one section it actually filters, is active.
  - The Tools panel's empty state read "No tool calls recorded in this range.", a copy-paste leftover implying date-range scoping that section never had (unlike Overview's genuinely range-scoped empty states). It now reads "No tool calls recorded yet.", matching its sibling sections' phrasing.

## 0.6.0

### Minor Changes

- [`58783fb`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/58783fb433fd3c641dc9a42b80eaba09f2c9a62b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `@adonis-agora/agent` now ships its own governance dashboard — `node ace configure @adonis-agora/agent` registers an embedded `dashboard_provider` that serves the `@adonis-agora/agent-dashboard` SPA straight out of `@adonis-agora/agent`'s own build (`../dashboard/dist/spa` is copied into `dist/assets/spa` at build time), so a new app needs no separate install or provider registration to get the console. Configure it via the same optional `config('agent').dashboard` block as before.

  This is purely additive: the standalone `@adonis-agora/agent-dashboard` package and its own `agent_dashboard_provider` keep working exactly as before for apps that already install and register it directly — both providers now share one implementation (`@adonis-agora/agent/dashboard`, a new subpath export) so their behavior is byte-for-byte identical. Register only one of the two in a given app; mounting both at the same path throws AdonisJS's "duplicate route" error at boot.

  `@adonis-agora/agent-dashboard`'s peer dependency floor on `@adonis-agora/agent` moves to `>=0.21.0` (the version that introduces the shared `@adonis-agora/agent/dashboard` export its provider now imports from); already-published `agent-dashboard` versions are unaffected.

## 0.5.0

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

## 0.4.0

### Minor Changes

- [`05ea997`](https://github.com/DavideCarvalho/adonis-agent/commit/05ea997c6c9d4f20497ca0a1f81a1e09b77141b3) - O console de governança agora também se recusa a montar quando `governanceQueries: false`, não só quando falta o `governanceAuthorize`.

  Os dois casos produzem o MESMO console quebrado — 10 dos 11 endpoints de leitura do console são `/agent/governance/*`, e sem read-model essas rotas não existem, então todo painel menos o Quota dá 404 no clique. Antes, `governanceQueries: false` com um gate configurado passava pela checagem de mount e servia esse console morto sem nada explicando o motivo.

  **Como voltar a ter o console:** o aviso de boot agora nomeia QUAL das duas peças falta, porque as duas quebram igual e mensagem genérica não ajuda ninguém a diagnosticar.

  - Faltando o gate → configure `governanceAuthorize` em `config/agent.ts` (tipicamente uma checagem de ADMIN), ou `governanceAuthorize: () => true` pra restaurar deliberadamente o comportamento antigo de deixar QUALQUER ator autenticado ler.
  - `governanceQueries: false` → remova essa linha (omitir dá o read-model Lucid quando o store principal é Lucid) ou passe um store/factory explícito.
  - Pra manter o console desligado de propósito e sem aviso: `dashboard: { enabled: false }`.

  Só um `false` explícito em `governanceQueries` bloqueia o mount. `undefined` NÃO é esse caso: o provider do agent resolve o read-model Lucid por default quando o store principal é Lucid, então omitir a chave continua montando o console normalmente.

  `GET /agent/approvals/mine` segue inalterado — montado e escopado ao ator chamador.

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

## 0.3.2

### Patch Changes

- [#16](https://github.com/DavideCarvalho/adonis-agent/pull/16) [`07a46bd`](https://github.com/DavideCarvalho/adonis-agent/commit/07a46bd3d7efcc6861dee6c977ab0b19b6d4575b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Widen the `@adonis-agora/agent` peer range to `>=0.4.0 <1.0.0`

  The dashboard only consumes the agent's stable HTTP routes and public types, which are
  compatible across the agent's pre-1.0 minor releases — so pinning the peer to `^0.4.0`
  (i.e. `>=0.4.0 <0.5.0`) was too tight: every agent minor pushed the installed agent out
  of range, producing a spurious peer warning in consumers and forcing an unwarranted major
  bump of the dashboard. The range now tolerates any `0.x` agent from `0.4.0` up, and will
  intentionally require a re-check at the agent's eventual `1.0.0`.

## 0.3.1

### Patch Changes

- [#12](https://github.com/DavideCarvalho/adonis-agent/pull/12) [`4021b6b`](https://github.com/DavideCarvalho/adonis-agent/commit/4021b6b5355ec7679f44f035a2c1dfafeb3c5e61) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix the dashboard provider crashing every app boot (and a duplicate-route crash)

  Two bugs that made the provider unbootable in a real app — surfaced the first time
  it was registered in one (entre-textos):

  - **`router` was `undefined` at boot.** The provider imported `router` from
    `@adonisjs/core/services/router` and called `router.get(...)` in `boot()`. That
    service's default export is only assigned inside an `app.booted()` hook, which
    runs AFTER every provider's `boot()`, so it was still `undefined` — `router.get`
    threw `Cannot read properties of undefined (reading 'get')` and crashed the whole
    app. It now resolves the router from the container (`app.container.make('router')`),
    available during boot, mirroring how the agent provider registers its routes.

  - **Duplicate `GET <mount>` route.** The provider registered a bare-mount redirect
    (`<mount>` → `<mount>/`) plus the shell at `<mount>/`. The AdonisJS router
    normalizes trailing slashes, so both are the SAME pattern — the second
    registration threw `Duplicate route found`. The shell now serves at the bare
    `<mount>` (one route), and `sendIndex` injects a `<base href="<mount>/">` so the
    SPA's relative `./assets/*` URLs (Vite `base: './'`) still resolve against the
    mount directory regardless of the URL's trailing slash.

## 0.3.0

### Minor Changes

- [#10](https://github.com/DavideCarvalho/adonis-agent/pull/10) [`c2ddde3`](https://github.com/DavideCarvalho/adonis-agent/commit/c2ddde3d4fdb5f87f3c49984c5cbbe145fbd1038) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add an optional `authorize` gate to the dashboard config

  The console serves the governance read-model, which spans EVERY actor's spend and
  usage — so authenticating the caller (the default gate, shared with
  `/agent/governance/*`) is often not enough; you want to restrict it to admins.

  `config('agent').dashboard.authorize` is an optional `(actor, ctx) => boolean |
Promise<boolean>` run after the actor resolves. Return `false` (or throw) to deny
  — the request gets `403`. Omit it to keep the previous behavior (any resolved
  actor allowed). Typical use: `authorize: (actor) => actor.roles?.includes('ADMIN')
?? false`. The gate decision lives in a router-free `evaluateDashboardGate` helper
  so it is unit tested directly.

## 0.2.2

### Patch Changes

- [#6](https://github.com/DavideCarvalho/adonis-agent/pull/6) [`363382b`](https://github.com/DavideCarvalho/adonis-agent/commit/363382b5bd182f8de6184cd1c509209113710111) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `pricingStore` and `governanceQueries` now default to mirroring the main `store`.

  When `store` is a `stores.lucid()` store, the agent now defaults the pricing store and the governance read-model to a Lucid store on the **same connection** (tables auto-created) with no extra config — so cost tracking and the `/agent/governance/*` routes work out of the box. Previously both were opt-in and omitting them left cost `null` and the governance routes unmounted.

  - Override by passing a factory/instance as before (e.g. a different connection, or `pricingStores.memory()` for tests).
  - Set `pricingStore: false` / `governanceQueries: false` to disable (cost stays `null`; governance routes not mounted).
  - When the main store is not Lucid, both stay off unless set explicitly.

  Adds `lucidStoreConnection(factory)` to read a `stores.lucid()` factory's connection (used internally for the mirroring). The `@adonis-agora/agent` peer range on `@adonis-agora/agent-dashboard` widens to `^0.4.0`.

## 0.2.1

### Patch Changes

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

- [`f1fea00`](https://github.com/DavideCarvalho/adonis-agent/commit/f1fea00e165ef6d106fa67ed9ceda6e03ddbca3b) - Acompanha o `@adonis-agora/agent` 0.2.x (o peer passa de `^0.1.0` para `^0.2.0`).

  O dashboard em si não mudou. Ele sobe junto porque o peer aponta para uma faixa que o agent acabou
  de deixar: publicar só o agent deixaria `agent-dashboard@0.1.0` exigindo um agent `^0.1.0` que não
  é mais a versão corrente.

  O peer já vai fixado em `^0.2.0` neste commit de propósito. Se ele ficasse em `^0.1.0`, o agent
  subindo para 0.2.0 o deixaria fora de range, e o changesets responde a isso bumpando o dependente
  para **major** (1.0.0) — mesmo com este changeset pedindo minor, porque ele toma o máximo dos dois.
  Com o peer já dentro da faixa nova, a cascata não dispara.
