---
'@adonis-agora/agent': major
'@adonis-agora/agent-dashboard': major
---

Every HTTP list route speaks `@adonis-agora/filter`'s wire format: `filter[field]`, a fixed `sort`, cursor paging with `first`/`after` (and `last`/`before` where a list pages backward), and a `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }` body. Unknown filter fields, other sorts and forged cursors answer `400`.

- `GET /agent/threads`, `/agent/attachments`, `/agent/approvals/mine`, `/agent/governance/tool-calls/recent`, `/agent/governance/threads/recent`: `{ data, meta }`, `first` + `after`/`before`. `?limit=` is gone.
- `GET /agent/governance/approvals/pending`: `filter[actor]` instead of `?actor=`.
- `GET /agent/governance/runs`: `filter[actor]`, `filter[agent]`, `filter[status]`, `filter[startedAt][gte|lte|between]` instead of `?actor=&agent=&status=&from=&to=`; the body is `{ data, meta }` instead of `{ items, nextCursor, … }`.
- `GET /agent/threads/:id/action-proposals`: `{ data, meta }` with an opaque `after` cursor; the `X-Action-Proposals-Next` header is gone.
- React: `AgentClient.listThreads(page?)` and `AgentBackend.listThreads` return `{ data, meta }`; `useThreads()` adds `hasMore` and `loadMore()`.
- Dashboard client: `listRuns`, `recentThreads`, `recentToolCalls` and `pendingApprovals` return `{ data, meta }`; the feeds take `{ after?, first? }`; `PendingApprovalsFilter.limit` → `first`; the `limit` option → `pageSize`.
