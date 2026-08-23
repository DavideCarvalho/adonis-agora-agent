---
name: agent-personas-agents
description: >-
  Shape @adonis-agora/agent behavior per request: personas (Persona { id, label,
  systemPrompt string | PromptBuilder, allowedTools }, defaultPersona, the
  /agent/threads/personas/catalog route), named agents (agents: AgentDefinition[] with
  tools/maxSteps/actorResolver overrides), delegatesTo multi-agent delegation via
  synthesized ask_<target> agent-kind tools and DelegateEdge { agent, roles, ability },
  HITL approval flow over POST /agent/tool-call/approve|reject with pending_approval
  status, maxSteps budgeting, and PromptContext/basePrompt composition. Use for
  "persona picker", "orchestrator delegates to specialists", "ask_researcher denied",
  "action tool hangs waiting for approval", "prompt builder".
metadata:
  type: core
  library: "@adonis-agora/agent"
  library_version: "0.25.2"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-agent:packages/adonis/docs/authoring/personas-and-agents.mdx"
  - "DavideCarvalho/adonis-agent:packages/adonis/docs/streaming-and-http.mdx"
  - "DavideCarvalho/adonis-agent:packages/adonis/src/types.ts"
  - "DavideCarvalho/adonis-agent:packages/adonis/src/agent-loop.ts"
---

# Personas, named agents & delegation

The default setup is one agent. Two features extend it: **personas** reshape a single
agent per request (prompt + optional tool allow-list), and **named agents** with
`delegatesTo` turn one assistant into a small team that hands work around through
synthesized `ask_<target>` tools.

## Setup

Personas on the implicit default agent; the caller selects one via `POST /agent/chat`'s
`persona` field, and it pins to the thread:

```ts
// config/agent.ts
export default defineConfig({
  model: () => aiSdkModel(openai('gpt-4o-mini')),
  store: 'lucid',
  stores: { lucid: stores.lucid() },
  actorResolver: new AuthActorResolver(),
  defaultAgent: {
    systemPrompt: 'You are the assistant for our store.',
    defaultPersona: 'shopper',
    personas: [
      {
        id: 'shopper',
        label: 'Shopping assistant',
        systemPrompt: 'Help the customer find and track products. Be concise.',
        allowedTools: ['getOrder', 'searchProducts'],
      },
      {
        id: 'support',
        label: 'Support agent',
        systemPrompt: 'Help resolve issues. You may issue refunds with approval.',
        allowedTools: ['getOrder', 'issueRefund'],
      },
    ],
  },
})
```

A persona's `systemPrompt` resolves WITH the agent's base prompt available as
`basePrompt`, so it can wrap rather than discard; it may be a `PromptBuilder`
(`(ctx: PromptContext) => string | Promise<string>`) composed from actor/persona/
pageContext. Render a picker from `GET /agent/threads/personas/catalog`.

Source: `packages/adonis/docs/authoring/personas-and-agents.mdx`.

## Core patterns

### Pattern 1 — orchestrator delegating to named specialists

Each `delegatesTo` edge auto-registers an `agent`-kind tool named `ask_<target>`
(non-alphanumerics become underscores) whose input is `{ task }`. You never write its
handler — the loop runs the target and feeds the answer back:

```ts
// config/agent.ts
export default defineConfig({
  // ...
  defaultAgent: {
    name: 'orchestrator',
    systemPrompt: 'You coordinate specialists. Delegate work, then summarize.',
    delegatesTo: [
      { agent: 'researcher', roles: ['ANALYST', 'ADMIN'] },   // role-based gate
      { agent: 'billing', ability: 'agent.delegate.billing' }, // ability-based gate (authz)
    ],
  },
  agents: [
    { name: 'researcher', systemPrompt: 'You research questions using read tools.', tools: ['searchDocs'] },
    { name: 'billing', systemPrompt: 'You handle billing. Refunds require approval.', tools: ['getInvoice', 'issueRefund'] },
  ],
})
```

When the target has a flat-string base prompt, it is appended to the delegate tool's
generated description so the orchestrator's model knows what the specialist is for.

Source: `packages/adonis/docs/authoring/personas-and-agents.mdx` ("Multi-agent
delegation", "How a delegate tool is named").

### Pattern 2 — approving a paused `action` tool (HITL)

An `action` call records `pending_approval` and suspends the run; the client reads the
pending `toolCallId` from thread detail, then decides. The decision is scoped to one
`(runId, toolCallId)` pair, so one run can never approve another's call:

```bash
curl http://localhost:3333/agent/tool-call/approve \
  -H 'content-type: application/json' \
  -d '{"runId":"<runId>","toolCallId":"<toolCallId>"}'

curl http://localhost:3333/agent/tool-call/reject \
  -H 'content-type: application/json' \
  -d '{"runId":"<runId>","toolCallId":"<toolCallId>","reason":"not this account"}'
```

On reject, the reason is fed back to the model and the turn continues. A UI can also poll
`GET /agent/approvals/mine` — the calling actor's own pending approvals.

Source: `packages/adonis/docs/streaming-and-http.mdx` ("Human-in-the-loop").

### Pattern 3 — cap runaway loops with `maxSteps`

`maxSteps` bounds model↔tool iterations per turn (default 8). Give a shallow specialist a
smaller budget than the orchestrator:

```ts
agents: [
  { name: 'summarizer', systemPrompt: 'Summarize in one pass.', maxSteps: 2 },
]
```

Source: `packages/adonis/src/types.ts` (`AgentDefinition.maxSteps`),
`packages/adonis/src/agent-loop.ts` (`const maxSteps = deps.maxSteps ?? 8`).

## Common mistakes

### HIGH — bare-string `delegatesTo` edges under non-admin callers or authz

```ts
// Wrong — declares NO roles and NO ability.
delegatesTo: ['researcher']
```

```ts
// Correct — say who may delegate.
delegatesTo: [{ agent: 'researcher', roles: ['ANALYST', 'ADMIN'] }]
```

Mechanism: a delegate tool goes through the SAME gate as every other tool. A bare string
carries nothing, so under `DefaultToolAuthorizer` it is ADMIN-only, and under the authz
Bouncer adapter a spec without `ability` is denied outright — the edge becomes uncalled
for everyone but admins.
Source: `packages/adonis/docs/authoring/personas-and-agents.mdx` ("Authorizing a
delegation"), `packages/adonis/src/types.ts` (`DelegateEdge`).

### MEDIUM — debugging "the orchestrator ignored the specialist" as a prompt problem

```ts
// Symptom — the model apologizes and answers alone; no visible error anywhere.
// The delegation was DENIED and recorded failed:
//   { toolName: 'ask_researcher', status: 'failed', error: 'Tool "ask_researcher" is not allowed...' }
```

```ts
// Correct move — check the tool-call feed (governance read-model / dashboard Tool calls panel).
// A denied delegation persists as failed — never auto_executed — and the error text goes back
// to the model as a tool result, which it paraphrases away silently.
```

Mechanism: the loop re-applies all three gates before delegating (offered-tools check,
role check, input validation); on denial it records the call `failed`, skips
`agent.delegated`, and pushes `{ output: null, error }` into the transcript — so the run
completes normally while the delegation quietly never happened.
Source: `packages/adonis/src/agent-loop.ts` (agent-kind branch), `packages/adonis/docs/
authoring/personas-and-agents.mdx` ("A denied delegation is recorded, not retried").

### MEDIUM — expecting a delegated sub-agent's action tools to wait for a human

```ts
// Wrong assumption — nested researcher asks for approval; the run should pause.
defaultAgent: { delegatesTo: [{ agent: 'researcher' }] }
agents: [{ name: 'researcher', tools: ['issueRefund' /* action */] }]
```

```ts
// Correct — keep human-approval actions on the TOP-LEVEL agent only.
agents: [
  { name: 'researcher', tools: ['searchDocs', 'getInvoice'] }, // read tools only
]
```

Mechanism: under the inline runner a sub-agent runs as a nested in-process loop with no
human attached, so its `action` tools are AUTO-DECLINED rather than left hanging; under
the durable runner the same delegation maps to a tracked child workflow instead.
Source: `packages/adonis/docs/authoring/personas-and-agents.mdx` (final paragraph).

### LOW — using wall-clock time or randomness inside a PromptBuilder

```ts
// Wrong — non-deterministic prompt; a durable replay recomputes a DIFFERENT prompt.
const builder: PromptBuilder = async (ctx) => `${ctx.basePrompt}\nNow: ${new Date().toISOString()}`
```

```ts
// Correct — derive from stable inputs (actor/persona/pageContext) resolved once per turn.
const builder: PromptBuilder = (ctx) => `${ctx.basePrompt}\nAssist ${ctx.actor.id} in ${ctx.actor.tenantRef ?? 'the org'}.`
```

Mechanism: the loop resolves the effective system prompt exactly once per turn from
stable context; injecting entropy breaks replay determinism under the durable runner.
Source: `packages/adonis/docs/authoring/personas-and-agents.mdx` (replay-safety note),
`packages/adonis/src/agent-loop.ts` (`resolveSystemPrompt`).

See also: `agent-governance/SKILL.md` — the policy behind `roles`/`ability` gates;
`agent-testing/SKILL.md` — scripting multi-turn runs offline.
