---
"@adonis-agora/agent": minor
"@adonis-agora/agent-dashboard": minor
---

Organizations (tenancy). With `tenancy.enabled` in `config/context.ts` (new `tenancy` option in `config/agent.ts`, default `'inherit'`, `false` opts out), actors carry the active organization as `tenantRef` (a resolver that sets one wins), `recordUsage` stamps it, threads and runs of another organization answer 404 on every route, and `GET /agent/threads` lists only the organization's threads. `quota: { per: 'tenant' | 'actor-in-tenant' }` budgets per organization (new optional store method `usageBetweenForTenant`, index `(tenant_ref, created_at)` on the token ledger). The console reads only the viewer's organization, or the `tenants` (`'*'` or ids) its `authorize` returns; the header gets an Organization chip/picker kept in `?tenant=`, and `GET /agent/governance/tenants` feeds it. The Lucid governance read-model gains `forTenants(scope)` and `listTenants()`; the Lucid store gains `listThreadsInScope`, `getThreadTenantRef` and `getRunTenantRef`.
