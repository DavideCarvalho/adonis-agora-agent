---
'@adonis-agora/agent': minor
'@adonis-agora/agent-dashboard': minor
---

`RunReliability` (from `GET /agent/governance/reliability`) gains two optional fields: `byAgent` (run
and failure counts per agent, highest call count first) and `trend` (daily run/failure counts over the
same range, oldest first) — implemented in both `LucidGovernanceQueries` and
`InMemoryGovernanceQueries`. Both are optional so an adapter that predates them can keep returning the
existing shape; the dashboard's Reliability section renders a trend chart and a by-agent breakdown when
present and stays as before when absent.
