# Independent approvals and component capabilities

Aviary and Agora expose the same approval behavior. Blocking approval remains the default. Set `actionApprovalMode: 'independent'` to let an action wait for a decision while its originating turn finishes and the conversation accepts another message.

## Configuration

Add these options to `AgentModule.forRoot(...)` in Aviary or `defineConfig(...)` in Agora:

```ts
{
  actionApprovalMode: 'independent',
  backgroundActorResolver: {
    async resolve({ actorRef, tenantRef }) {
      // Load the current actor and roles from your application's authorization system.
      // Return null if the actor was deleted or no longer belongs to this tenant.
      return findCurrentActor(actorRef, tenantRef)
    },
  },
  actionProposalWorker: {
    pollIntervalMs: 1_000,
    leaseMs: 30_000,
    maxConcurrency: 1,
  },
}
```

`findCurrentActor` is application code. The resolver must return the current `Actor`, including its ID, tenant and roles. A reviewer authorizes the decision; execution still acts as the requester. The worker resolves the recorded agent and persona against current configuration and checks current tool permissions before executing.

Independent mode requires a store that supports scoped proposals, fenced execution leases, terminal outcomes, atomic outcome admission and the thread chat queue. Configuration fails early when these capabilities are missing. Built-in memory storage supports one process; durable deployments should use the database adapters. Certified Drizzle transaction drivers are better-sqlite3, node-postgres, mysql2 and libSQL. Other Drizzle drivers do not advertise independent admission support. MikroORM and Lucid support SQLite, PostgreSQL and MySQL.

The module/provider starts and stops the proposal worker with the application. Poll interval must be less than one third of the lease; all worker options are positive integers. Multiple workers coordinate through database leases and compare-and-set transitions.

## Approval policy and per-call checks

`approvalPolicy.requirementFor(tool, actor, thread)` decides whether a tool requires approval, who can decide, and its optional `ttlMs`. `approvalPolicy.canDecide(actor, decision)` can apply application authorization. Without a custom rule, `requester` means the conversation owner; another approver string means a role.

The tool's `preflight(input, ctx, { phase })` handles domain checks. `prepare` runs before the card and can return `ready` with a custom `confirmation`, `denied` with a reason, or `completed` with an existing result. `execute` checks current domain state immediately before the side effect. This is where an application detects a duplicate or a change that makes the approved action unsafe. The policy and remembered approval never bypass this check.

Declare card templates through `presentation.confirm` (`title`, `verb`, optional `detail`). Placeholders such as `{amount}` resolve from the validated input. A preparation preflight can override those strings for that particular call.

The card persists the approved normalized input and original preparation input. The worker parses the original input through the current schema and compares the result with the approved snapshot. Schema drift fails execution instead of silently changing what was approved.

## Decision channels and expiration

Independent approval routes are:

- `GET /threads/:threadId/action-proposals`
- `POST /threads/:threadId/action-proposals/:proposalId/approve`
- `POST /threads/:threadId/action-proposals/:proposalId/reject`

The routes are relative to the configured agent base path. Lists return arrays and paginate with an exclusive `after` query cursor. When `X-Action-Proposals-Next` is present, decode it with `decodeURIComponent` and send that JSON string as the next `after` value. The SDK traverses these pages automatically. Cross-origin hosts must expose that response header through their CORS configuration. Each page rechecks authorization; an empty authorized page can still have a next cursor. Approval accepts optional `remember`; rejection accepts optional `reason`. The authenticated actor and channel are recorded by the server; the client cannot supply execution authority. Aviary operator integrations can use the approval port's `approveActionProposal` and `rejectActionProposal`; Agora integrations use the agent service's `decideActionProposal`. Both require an actual actor and an explicit thread/proposal target. Slack, Teams or other integrations call the same scoped service and supply their channel for the audit.

Text is another channel. Whole-message commands include `sim`, `confirmar`, `aprovar`, `não`, `cancelar` and `rejeitar`; append `#ID` to select a proposal. `confirmar sempre nesta conversa #ID` requests remembered approval. Bare commands only act on one authorized pending candidate. Multiple candidates ask for an explicit ID. Questions, quoted text and free-form mentions do not become consent. A saturated candidate list also requires an explicit choice. The decision is recorded as `via: 'text'` and does not invoke the model.

Remembered approval is scoped to the tool and conversation. An independent remembered grant takes effect after the approved execution reaches a terminal state. It does not become a grant merely because execution was queued. The next call still passes current permissions, validation and domain preflight.

A `ttlMs` produces a persisted expiration deadline and a card countdown. Expiration and decisions use the same atomic state transition, so a stale card cannot authorize an expired action. The origin turn records `{ proposalId, status: 'pending', executed: false }`; approving a proposal reports that it was queued, never that its effect already succeeded.

## Replacing a pending action

Declare `replacementKey` on an action's tool specification. It can be a stable string or a function of the validated input and tool context. Only proposals with the same requester, tenant, conversation, tool and key belong to the same replacement group. Creating the new proposal and superseding pending predecessors happens in one transaction. Replaying the original creation does not supersede a newer proposal. Approved or executing proposals remain eligible to run.

## Execution, outcomes and retries

Execution is at least once. Pass `ctx.idempotencyKey` to the external service or use it as a unique key for your application's write. A worker can die after the side effect but before recording its result; the stable key is what prevents a repeated effect during recovery.

A terminal decision or execution records its outcome durably. Admission writes one assistant fact and its UI atomically with delivery state. It waits while a user turn owns the conversation, deduplicates retries and discards delivery if the conversation was deleted or its scope changed. It does not start an automatic model continuation. Stopping a chat turn does not cancel an independent proposal.

Clients reconcile proposals after SSE ends and refresh on focus/reconnect. Late facts merge into history without overwriting an active local turn. Status distinguishes pending, queued, executing, succeeded, failed, rejected, expired and superseded.

## Shared component catalog

Use the matching updated shared core and React packages to enable capability negotiation and persisted fallback metadata. Older optional core peers retain their legacy behavior when capabilities are omitted.

The server catalog owns each component's name, props schema, version and text representation. Apps advertise renderer support through:

```ts
uiCapabilities: {
  components: [
    { name: 'DataTable', version: 1 },
    { name: 'Metric', version: 1 },
  ],
}
```

Use the names and versions actually defined in your catalog. `components: []` requests text only. Omitting capabilities preserves the legacy catalog behavior. The server intersects capabilities with the authorized catalog; client declarations never create components or grant permissions. Only supported components are offered to the model. Unsupported validated emissions and trees become their complete text representation.

Capabilities travel through native HTTP, queued messages, proposal execution context and AG-UI forwarded properties. Shared React can derive capabilities from its renderer registration or accept `uiCapabilities` explicitly. Drawable emissions retain `fallbackText` so stored history remains readable when a component renderer is removed, its version changes or rendering fails. A custom renderer fallback can override the default text display.

## Database rollout

Apply the additive runtime schema before enabling independent mode. Existing deployments need proposal discovery/delivery/replacement indexes and metadata, outcome storage on messages, proposal pointers on tool calls, and capabilities on queued messages. Agora ships a forward migration through its configure workflow; Drizzle and MikroORM consumers should generate/apply their database migrations from the updated schemas/entities.

Stop older writers, apply schema changes, run the bounded proposal-discovery backfill from the earlier foundation layer, then deploy the new writers/workers. Do not run the backfill implicitly on every worker tick. Older terminal rows without runtime outcome metadata do not gain retroactive assistant messages. Existing durable checkpoints without the new mode remain blocking; changing configuration does not rewrite an in-flight run's journal.

## Paired development preview

The independent runtime and capability negotiation require the matching Aviary core/React preview until those peer releases are published. Published older peers retain legacy UI behavior when capabilities are omitted; explicit capability negotiation requires the updated peer.

After a frozen install, prepare the exact upstream commit recorded in `.aviary-preview.json`:

```sh
pnpm install --frozen-lockfile
pnpm prepare:aviary-peers
pnpm typecheck
pnpm test
```

The script clones the pinned source into ignored `.aviary-preview/source`, verifies its exact commit and clean working tree, installs its frozen dependencies and builds core/React. To reuse an existing clean checkout at that exact commit, run `pnpm prepare:aviary-peers --source /path/to/nestjs-agent`. Remove the preview cache when changing the pin. CI checks out the same manifest commit and runs the same preparation before validation.

Preparation replaces only the installed peer `dist` directories inside this checkout's `node_modules`; it removes old directories first to avoid modifying pnpm store hardlinks. Dependency versions, lockfiles and published production dependencies remain unchanged. Re-run preparation after reinstalling dependencies. Once matching peers are published, replace this development-only preview step with released version pins and a frozen lockfile update.
