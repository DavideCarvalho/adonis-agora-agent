---
"@adonis-agora/agent": minor
---

The governance console's lists page by keyset, so "Load more" no longer re-reads every row above the page.

- `GET /agent/governance/tool-calls/recent` and `/threads/recent` page through two new optional read-model methods, `toolCallsPage` and `threadsPage` (`{ after, first }` in, `CursorPage` out). Both seek past the `(created_at | updated_at, id)` of the previous page's last row, with no offset. `LucidGovernanceQueries` and `InMemoryGovernanceQueries` implement them. A read-model without them keeps the old capped read. Cursors from older servers and `before` keep working.
- `listRuns` hands out a keyset cursor over `(started_at, id)` instead of an offset. An offset cursor from an older version (`"50"`) is still honoured.
- New migration `add_agent_governance_list_indexes` (published by `configure`), plus `createAgentGovernanceIndexes` / `dropAgentGovernanceIndexes` / `governanceIndexStatements`. It adds indexes on tool calls `(created_at, id)`, threads `(updated_at, id)` and `(tenant_ref, updated_at)`, and runs `(agent_name, started_at)` and `(tenant_ref, started_at)`. It creates only the missing ones, `CONCURRENTLY` on Postgres. Opt-in: run it once on existing installs (see the Lucid store docs).
