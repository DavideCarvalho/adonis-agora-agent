# Independent action proposals PR2 implementation plan addendum

> **For agentic workers:** Use `subagent-driven-development` or `executing-plans` task by task. Record RED before implementation, then GREEN. The user authorized continuing the paired PRs; present this addendum before the major loop and worker changes.

**Goal:** Enable independent HITL proposals explicitly, end their originating turns normally, execute approved work with current authorization, and admit durable outcome facts into the conversation.

**Architecture:** Reuse PR1's scoped proposal row and fenced execution lease. Small modules handle trusted preparation, decisions, worker discovery/execution, outcome admission and client reconciliation. Existing blocking journals and automatic/remembered execution retain their behavior.

**Tech Stack:** TypeScript, Standard Schema, Vitest, inline/durable runners, Lucid/Drizzle/MikroORM, existing conversation queue and shared React client.

## Delivery checkpoint

The trusted preparation, immutable raw/normalized execution descriptor and memory worker-discovery reference form a smaller paired foundation PR. They do not enable independent mode. A following paired foundation implements SQL discovery and explicit bounded upgrade/backfill across all supported stores. Journal/loop integration, authenticated routes, scheduler, atomic outcome admission and client reconciliation follow the ordered tasks below.

## Fixed behavior

- Blocking remains the default. `actionApprovalMode: 'blocking' | 'independent'` is fixed per run in the existing load checkpoint. An old checkpoint without this field means blocking. Configuration changes do not switch a replayed run.
- Only an action whose journaled approval mode is `ask` creates an independent proposal. Auto and remembered calls retain normal invocation, authorization and execute-phase preflight. Built-in elicitation `ask` still waits for human answers.
- Finish the remaining calls in the existing batch. Return a matching pending tool receipt for each independent call; finish the step and end before another model request. Pending does not set successful terminal-tool state or emit execution success.
- A worker executes as the freshly resolved requester, never as the reviewer. Missing actor, agent or persona fails execution explicitly. Stop on the origin or a later turn does not cancel a proposal. Pending rejection remains supported; approved cancellation and supersession are outside PR2.
- Deliver a plain outcome fact and persisted `emitUi` components. Do not start an automatic LLM continuation. Poll scoped proposal state after the originating SSE ends.
- Preserve remembered approval's tenant/requester/thread/tool scope and current preflight checks. Record the remembered grant once when approved execution settles, preserving the current timing, including approved execution failures; queued approval alone does not grant it.

## Module map

Paths under `core/src/` below mean `packages/core/src/` in Nest and `packages/adonis/src/` in Agora.

| Responsibility | New modules | Integration files |
| --- | --- | --- |
| Trusted normalized preparation | `core/src/action-proposal-preparation.ts` | Both `tool-registry.ts`, `agent-loop.ts`; durable dispatched model preparation |
| Contracts and pure protocol | `core/src/spi/background-actor-resolver.ts`, `core/src/spi/action-proposal-worker-store.ts`, `core/src/spi/action-proposal-outcome-store.ts`, `core/src/action-proposal-receipt.ts` | Existing proposal SPI/transitions, `types.ts`, `spi/agent-store.ts` |
| One claimed execution | `core/src/action-proposal-executor.ts` | Existing registry, role policy, deps factories and UI collector |
| Decision and polling services | Nest `packages/nestjs/src/proposals/action-proposal.service.ts`; Agora `packages/adonis/src/action-proposal-service.ts` | Nest `agent.service.ts`, `approval-port.adapter.ts`, controller routes; Agora `agent-service.ts`, `providers/agent_provider.ts`, protocol adapter |
| Scheduler and admission | Nest `packages/nestjs/src/proposals/action-proposal-worker.service.ts`; Agora `packages/adonis/src/action-proposal-worker.ts`; both `core/src/action-proposal-admission.ts` | Existing module/provider lifecycle and chat queue |
| Persistence | Existing Drizzle/MikroORM proposal helpers/entities; Agora Lucid proposal helper/schema | Shared store contracts, additive migrations/provisioning, memory stores |
| Client reconciliation | Nest `packages/react/src/approvals/use-action-proposals.ts` | Shared transport, `use-agent-chat.ts`, transcript model; Agora native client/protocol mapping uses the published shared React client |

## Contract additions to review and freeze

The following are additive worker capabilities, not mandatory new `AgentStore` methods. Independent mode requires all of them on the same persistence/transaction authority, plus a configured background resolver. A separate proposal database cannot atomically admit into an unrelated conversation database. Advertise admission capability only for drivers with the required multi-statement transactions; distinguish synchronous better-sqlite3 callbacks from asynchronous drivers. Unsupported transactional drivers such as D1 fail independent-mode configuration without affecting blocking mode.

```ts
interface BackgroundActorResolver {
  resolve(ref: { actorRef: string; tenantRef: string | null }): Promise<Actor | null>
}
interface ActionProposalExecutionContext {
  agentName?: string
  persona?: string
  requestId: string
  pageContext?: PageContext
}
interface ActionProposalWorkerStore {
  claimNextActionProposal(command: { workerId: string; leaseMs: number }):
    Promise<ActionProposal | null>
  expireActionProposals(command: { limit: number }): Promise<number>
}
interface ActionProposalOutcomeLease {
  outcomeId: string
  token: string
  generation: number
}
interface ActionProposalOutcomeStore {
  claimNextActionProposalOutcome(command: { workerId: string; leaseMs: number }):
    Promise<{ outcome: ActionProposalOutcome; lease: ActionProposalOutcomeLease } | null>
  admitActionProposalOutcome(command: ActionProposalOutcomeLease):
    Promise<{ status: 'applied' | 'unchanged' | 'busy' | 'conflict' | 'not_found' | 'discarded'; messageId?: string }>
}
```

Add optional `executionContext` and `preparationInput: unknown` to proposal creation and the immutable snapshot. `preparationInput` preserves original JSON before schema parsing; existing `input` preserves the immutable approved normalized value. On older rows lacking `preparationInput`, use `input`; test field absence rather than treating a valid JSON null as missing. Add optional `ui: AgentUiComponent[]` to fenced settlement; persist only JSON, never HTTP requests, ORM handles, role snapshots as authority, or serialized handlers. A named agent/persona must resolve exactly; an absent agent name selects the configured default only if that was the originating context.

`ActionProposalOutcome` contains complete scope, `id`, `proposalId`, `outcomeVersion: 1`, `originRunId`, `originToolCallId`, terminal decision/execution status, `toolName`, `result?`, `error?`, `ui`, and server `createdAt`. Its admission state is `pending | admitted | discarded`, with fenced lease metadata and the admitted message ID. The unique logical key is `(proposalId, outcomeVersion)`; physical keys use canonical identity hashing. PR2 has one immutable terminal outcome per proposal, not one event per execution attempt.

Store the immutable outcome and delivery lease inside the proposal snapshot. Existing winning `settleActionProposal` CAS writes the execution outcome and pending delivery state in the same version-fenced row update. Winning rejection/expiry also writes a terminal decision outcome in that same CAS. Detect a changed pending-to-expired snapshot even when an attempted approval returns `expired`. CAS loss, duplicate settlement, or decision replay cannot create a second outcome. `expireActionProposals` uses the store clock and `now >= expiresAt`, bounded indexed discovery and first-wins expiry CAS. Discovery never exposes an unscoped public ID lookup: these are privileged worker-only methods, with authoritative scope checks preserved after candidate selection.

Admission validates the current outcome token/generation/unexpired lease, locks the conversation admission row, and verifies persisted requester/tenant ownership. If a user turn currently holds the thread, return `busy` and leave delivery pending; the scheduler retries after the lease lapses. Otherwise atomically insert the uniquely keyed assistant outcome fact with UI and mark its proposal delivery state admitted. User-send admission uses the same thread row, so it cannot interleave inside this transaction. Use PostgreSQL/MySQL row locks and a SQLite immediate/write-first transaction. Implement an internal transaction-bound append primitive rather than calling public appendMessage methods that fork managers or use standalone writes. Never install a fake active-stream holder. Add tenantRef to internal memory thread ownership and preserve it on forks. Independent mode requires the actual queued admission path; reject hand-built fallback paths that start a runner before claiming the thread. Never mark admitted before inserting the fact, overwrite a running turn, or rewrite the original pending receipt. Deleted conversations become `discarded` without resurrection. Duplicate admission returns the same message ID. Extend the stored message with canonical escaped TEXT `actionProposalOutcome` metadata including UI; existing native JSON UI columns remain empty for outcome facts and mappers expose the embedded UI; the provider adapter presents its truthful outcome text as assistant content, not an orphan `tool` message.

Worker configuration is opt-in with `pollIntervalMs: 1000`, `leaseMs: 30000`, `maxConcurrency: 1`. Reject nonpositive/unsafe integers and polling intervals at or above one third of the lease. Renew executing work every `leaseMs / 3`; stop renewal on settlement/shutdown. Loss of fencing prevents settlement/delivery by that worker; external effects remain protected by the original stable idempotency key. Expired leases allow crash recovery. A valid worker invokes once per claim; a denied preflight or permanent authorization/schema/configuration failure settles failed and is not automatically requeued.

## Ordered implementation and proof

### 1. Trusted preparation and producer stamp

- [ ] Add failing registry tests for schema defaults/transforms: preparation runs schema and the prepare hook once; the card and stored input use the same normalized value. A model-supplied stamp cannot bypass preparation.
- [ ] Add internal `prepareValidated(name, input, ctx, policy, options)` returning `{ preparationInput: unknown, input: unknown, preflight: ToolPreflightResult }` from one call to the existing validated pipeline. Keep public `prepare()` returning only the preflight result by delegating to it. Snapshot both original raw JSON as `preparationInput` and normalized JSON as proposal `input` before returning them for proposal creation. Capture raw JSON before calling a schema that may mutate its argument.
- [ ] Carry that result in a **server-produced** model-step/claimed-call stamp for dispatched execution. Strip model-provided internal stamp fields before enrichment. Resolve stamps through the worker's actual prepared output, never a Boolean asserted by the model. Preserve preflight `completed`/`denied` short-circuits and existing public contracts.
- [ ] Add trusted internal `InvokeOptions.approvedInput` to the existing validation/invocation pipeline. Public invocation behavior remains unchanged when it is absent. Parse `preparationInput` once with the current schema and compare canonical parsed input with approved `approvedInput` before execute preflight or the handler. Never accept this option from provider/model/client payloads.
- [ ] Run focused registry/preflight specs RED, then GREEN in both repositories. Cover transformed confirmation, mutable nested input, raw null, dispatched processes without local handlers, unchanged nonidempotent transforms and changed defaults/transforms rejected before execute preflight. No duplicate schema or prepare-hook invocation.

### 2. Persistence and worker discovery

- [ ] Write shared fail-first contracts for discovery across scopes, two-replica claim, expired execution recovery, expiry-vs-approval, settlement/outbox rollback, terminal-decision/outbox rollback and exact JSON identity.
- [ ] Add execution-context payload and indexed `execution_status`, `lease_expires_at`, `proposal_expires_at` where absent; add embedded terminal outcome/delivery state with indexed delivery status and lease expiry; avoid a separate outbox table. Mirror all dialects and additive schema/migration tests.
- [ ] Implement bounded candidate discovery plus existing scoped CAS. Reuse the 32-attempt contention policy; preserve caller transactions, own winning lease responses, server clock checks and canonical escaped TEXT/LONGTEXT snapshots.
- [ ] Add shared fail-first admission tests: failure after fact insertion rolls both writes back; delivery races a user-send and another delivery; duplicate admission returns one fact; wrong scope/stale lease/deleted thread cannot admit.

### 3. Run mode and pending receipt

- [ ] Write an old-journal replay test and a configuration-change-mid-run test before touching the loop.
- [ ] Extend the existing load checkpoint's new journal payload with fixed mode; normalize old shapes to blocking without inserting checkpoints before old `awaitDecision`/signal positions. Mirror inline and durable hooks.
- [ ] Create the deterministic proposal within the existing trusted claim checkpoint using both original preparation input and normalized approved input plus execution context. Store a proposal link and `proposed` call status; exclude it from dead-run pending-call cleanup and legacy approval signaling.
- [ ] Add `recordProposalReceipt` and truthful wire metadata `{ proposalId, status: 'pending', executed: false }`. Persist its matched tool result through the existing step-output path, finish remaining batch calls, then end normally. Distinguish `hasIndependentProposal` from successful `terminal` state.
- [ ] Prove a second message starts before decision, batch ordering remains intact, pending terminal tools never claim success, auto/remembered/elicitation keep their previous behavior, and replay creates one proposal/card.

### 4. Authorized decision and read routes

- [ ] Add separate routes: `GET /threads/:threadId/action-proposals`, `POST /threads/:threadId/action-proposals/:proposalId/approve`, and `/reject`. Internal route names follow each library's convention.
- [ ] Resolve actor from the authenticated request; derive stored thread scope server-side, then apply existing policy `canDecide` to the immutable requester/approver. Body accepts only `remember?` or `reason?`; never input, card, tenant, requester or decision time.
- [ ] Keep legacy tool-call/run routes unchanged. Add a discriminated proposal target to shared transport/console integration; do not try legacy signaling merely because a proposal ID resembles a call ID. Preserve trust boundaries for operator ports rather than treating opaque `executedByRef` as authorization.
- [ ] Test unauthorized tenant/requester/role, forged body fields, duplicate decision, expiry boundary and proposal approval after origin run completion. Return serialized proposal state and explicit CAS outcome; do not return a false execution-success acknowledgement.

### 5. Current-authority executor and scheduler

- [ ] Fail configuration early unless the store has proposal/worker/outcome/admission capabilities and `BackgroundActorResolver` is configured. Do this only when independent mode is enabled.
- [ ] Build `ActionProposalExecutor.execute(claimed)` from exact recorded agent/persona, current requester and fresh deps. Verify identity/tenant match; reapply current allow-list and registry authorization. Invoke the current schema on `preparationInput` (falling back only when absent) with trusted `approvedInput: proposal.input`; canonical mismatch fails work before execute preflight or the handler. Reuse `registry.invoke` rather than calling prepare a second time. This preserves unchanged nonidempotent transforms and rejects schema/default drift from the approved action.
- [ ] Use recorded origin identifiers and the unchanged proposal idempotency key in tool context. Recreate server host dependencies through the deps factory. Collect `emitUi` into outcome UI without writing to the completed origin sink.
- [ ] Implement lifecycle polling of expirations, execution claims and delivery claims; use persisted recovery as the authority, not an in-memory promise map or wake-up notification. Admission never starts an LLM run.
- [ ] Test revoked roles/flag/allow-list/`canUse`, invalid transformed input under changed schema, deleted requester, missing named agent/persona, denied/completed preflight, crash after effect, same key after recovery, stale settlement and lease renewal/shutdown.

### 6. History, React and late updates

- [ ] Add provider-contract tests proving the original call retains its matching pending receipt and later facts never become unmatched tool results, including history window selection and a conversation that has advanced.
- [ ] Add scoped polling to the shared React client while proposals are pending/queued/executing, and refetch on focus/reconnect. Merge state by proposal ID; reconcile terminal fact/UI by outcome ID. Invalidate transcript reads when an outcome becomes admitted. Client reads cannot overwrite local active-run messages with an older snapshot.
- [ ] Render existing approval controls using the explicit proposal target; status distinguishes pending, queued, executing, succeeded and failed. Do not reuse finished SSE, mark pending as executed, or auto-retry failed work. Agora maps its native wire shapes into the same published React implementation.
- [ ] Test origin SSE ended, decision in another tab, completion during a different active turn, reconnect after admission, duplicate polling payload and late UI persistence after reload. Premium UI redesign and supersession remain the next stage.

## Verification and review checkpoints

Every task begins with its stated failing test. Run targeted RED/GREEN commands using existing package Vitest configurations; SQL contracts run on SQLite, PostgreSQL and MySQL. Before paired PR2 publication run `pnpm test`, `pnpm test:db`, build, production/spec typechecks, Biome and diff checks in Nest; run the existing package test/build/typecheck/lint commands plus its real-DB matrix in Agora. Review normalized preparation and old-journal compatibility before the loop integration, then review settlement/admission transactions before worker lifecycle wiring.

Acceptance is one truthful pending receipt, a normally ended/free conversation, one authorized recoverable execution, one durable terminal fact/UI delivery, and valid provider history after subsequent messages. The user sees this plan before runtime changes begin.
