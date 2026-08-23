# Skill spec — adonis-agent

Autonomous compressed discovery. No maintainer interview was run (fully autonomous
constraint); everything below is grounded in `README.md`, `packages/adonis/docs/**`
(35 mdx files, all read), `packages/*/README.md`, and `packages/{adonis,dashboard}/src`.

## Scope decision

The monorepo publishes two packages, but a consumer's surface is dominated by one:
`@adonis-agora/agent` (core module — config, loop, tools, governance, stores, routes,
RAG, data tool, testing kit) and `@adonis-agora/agent-dashboard` (the governance console
SPA + browser client). The dashboard has a meaningful but small API surface, so it gets
exactly one skill. Ecosystem peers (`@adonis-agora/durable`, `@adonis-agora/authz`,
`@adonis-agora/telescope`, `ai`) are separate packages with their own repos; their seams
are summarized inside the primary skills and the decision is recorded in
`_artifacts/domain_map.yaml` → `secondary_packages` / `gaps`. **Decision: 5 skills for
`@adonis-agora/agent`, 1 for `@adonis-agora/agent-dashboard` — 6 total**, within the 4–6
budget; RAG/MCP/durable got no dedicated skills (recorded as gaps).

## Skill set (flat; every skill type `core`; names prefixed with the library)

Core package — `packages/adonis/skills/`:
1. `agent-setup` — `node ace configure`, `defineConfig` (model/store/quota/pricing/sink/
   actorResolver/path), Lucid vs in-memory store, auto-created tables, cost fold +
   `seedModelPrices`, Redis sink, production identity wiring.
2. `agent-tools` — `@AiTool` classes, `BaseTool`/`ReadTool`/`ActionTool`, `defineTool`,
   discovery barrel vs runtime scan, `toolsHook` options, roles/ability gating, IoC DI,
   the governed `dataTool`.
3. `agent-governance` — actor resolvers, `DefaultToolAuthorizer`, the offered+invoke
   double check, object-level ownership (`evaluateOwnership`),
   `governanceAuthorize` route mounting semantics, dashboard mount decisions.
4. `agent-personas-agents` — personas & `PromptBuilder`s, named agents, `delegatesTo`
   synthesized `ask_<target>` tools and their authorization, HITL approve/reject flow.
5. `agent-testing` — `FakeModelProvider`/`echoScript`, the in-memory doubles,
   `runAgentLoop` + hooks seam, `InlineAgentRunner`, asserting on `StreamFrame`s.

Dashboard package — `packages/dashboard/skills/`:
6. `agent-console-client` — embedded vs standalone provider registration, the shared
   `config('agent').dashboard` block, `decideDashboardMount` refusal reasons, and the
   framework-free `AgentClient` read/HITL/pricing API.

## Highest-value AI-agent guidance (what to get right)

- **Identity never fabricated**: with no `actorResolver` every request throws/401s —
  agents that "just add a default user" break the security model; wire
  `AuthActorResolver` (or `HeaderActorResolver` behind a gateway).
- **Fail-closed roles**: a tool without `roles` is ADMIN-only by default; under the authz
  adapter a tool without `ability` is *always* denied. A forbidden tool is never even
  offered to the model — "the model didn't call my tool" is usually this.
- **Governance surfaces mount only when configured**: `/agent/governance/*` answers 404
  without `governanceAuthorize`; the console refuses to mount without it (or with
  `governanceQueries: false`, logged with a distinct reason).
- **Quota off = fail-open**; `quotas.ledger.bump` must stay a no-op or you double-count;
  unpriced turns are `null` cost but $0.00 in rollups until `seedModelPrices` runs.
- **Delegation is authorized like any tool**: bare-string `delegatesTo` edges are
  ADMIN-only (or denied outright under authz); denials persist as failed calls that the
  model papers over — check the tool-call feed.
- **Single-replica defaults**: in-process token sink means re-attach works only on the
  pod that started the run; use `tokenSinks.redis()` for multi-replica.

## Remaining Gaps (interview substitutes)

- No GitHub issue mining this session — failure frequencies inferred from source JSDoc
  and doc callouts (both unusually detailed), not from real reports.
- RAG stack, MCP server, durable runner, attachments/generative-UI flows summarized only
  where failure modes demanded; each plausibly deserves its own skill later.
- Maintainer priorities among optional surfaces unknown (e.g. is MCP more common than
  pgvector RAG?).
- Whether per-agent `actorResolver` mismatch strands callers in practice is assumed from
  the doc warning, not telemetry.
