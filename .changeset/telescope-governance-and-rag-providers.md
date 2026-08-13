---
'@adonis-agora/agent': minor
---

Ported the Nest ("Aviary") telescope extension's governance and RAG coverage onto `@adonis-agora/agent/telescope`, alongside the existing entry-backed providers:

- **Governance-backed providers** (`agent-governance-providers.ts`): spend by model/actor, usage trend, run reliability (total/success-rate/failed/avg-duration/by-agent/trend), recent runs/tool-calls/threads, and the pending-approvals inbox — reading the SAME `AgentGovernanceQueries` read-model the `/agent/governance/*` routes and the standalone dashboard SPA already use, via a new package-internal registry `AgentProvider#boot()` populates (`src/telescope/governance-registry.ts`). Several Nest-reference panels have no equivalent on this SPI and are deliberately not ported — top-threads-by-cost, run retries, run duration percentiles, error-code breakdowns, and paged tool-calls/threads/runs tables — see that file's header for the full list and why.
- **RAG providers** (`rag-data-providers.ts`): retrieval count, zero-hit rate, mean chunk count, and a retrievals/zero-hits trend, read off the `retrieved` diagnostic event `agent-loop.ts`'s inject-mode retrieval already publishes. Latency, score distribution, and store/collection breakdowns are NOT ported — the recorded event carries none of that data today; see that file's header for what widening the instrumentation would need.
- **Host extensibility**: `agentTelescopeExtension({ providers, sections })` lets a host app append its own data providers and dashboard sections, mirroring the Nest reference (with the same `agent.`-prefix reservation on host providers).
- The "Agent" dashboard gained four new sections (Spend & usage, Spend detail, Run reliability, Governance activity, RAG) binding to the above.

No watcher and no dedicated `agent`/`agent-rag` entry types are contributed — confirmed against `@adonis-agora/telescope`'s current `TelescopeExtension` contract, which has no `watchers` hook and gives every `agora:agent:*` event the same generic `diagnostic` entry type. That's a real, documented SDK constraint (see `extension.ts`'s header), not an oversight: RAG and every other agent event share one capped `lib:agent` window as a result.
