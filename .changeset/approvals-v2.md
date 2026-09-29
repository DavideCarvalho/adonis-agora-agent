---
'@adonis-agora/agent': minor
---

Approvals v2, matching `@dudousxd/nestjs-agent`: an `approvalPolicy` in `config/agent.ts` decides who approves an `action` call and for how long — the shorthand `{ approver?, ttlMs?, tools: { <name>: { approver?, ttlMs?, required? } } }`, or a whole `ApprovalPolicy` (`requirementFor`, optional `canDecide`). Omitted, nothing changes: the requester approves, with no expiry.

- A non-requester approver is enforced on `POST /agent/tool-call/approve|reject` (`403` for anyone `canDecide` refuses — by default, anyone without that role).
- A `ttlMs` puts `expiresAt` on `approval-requested` and bounds the wait (an inline timer; the durable runner's signal-wait timeout). A lapsed request settles `expired` — `approval-settled { status: 'expired' }`, `tool-output-denied` with reason `approval expired`, a model narrative that says nobody approved in time — and a late decision answers `410`.
- `remember: true` on an approval approves later calls of that tool in the thread (`decidedVia: 'remembered'`); `via` records the surface a decision came through (`'web'` by default).
- `approval-settled` streams who decided, through what and why; `StoredMessage.approvals` returns it from `GET /agent/threads/:id`.

The requirement is settled inside the call's `persist:toolcall` checkpoint, so no position moved and a parked durable run keeps the answer it got. The Lucid store adds nullable `agent_tool_call.approver`, `expires_at`, `remember`, `decided_via` (ALTERed in by `createAgentTables`); `AgentStore` gains optional `rememberedApprovals` and `toolCallApproval`. `Decision` gains `remember`, `decidedVia`, `expired`; `ToolCallStatus` gains `'expired'`.
