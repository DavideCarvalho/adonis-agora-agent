---
name: agent-personas-agents
description: >-
  Shape @adonis-agora/agent behavior per request: personas (Persona { id, label,
  systemPrompt, allowedTools, aliases }, defaultPersona, send → thread pin → default,
  PATCH threads/:id { persona }, 400 persona_not_found, GET /agent/agents, the
  persona:resolve durable checkpoint), named agents (agents: AgentDefinition[] with
  tools/maxSteps/actorResolver overrides), delegatesTo multi-agent delegation via
  synthesized ask_<target> agent-kind tools and DelegateEdge { agent, roles, ability, detached }
  (detached → start_<target>, a background run that posts its answer back into the thread),
  HITL approval flow over POST /agent/tool-call/approve|reject with pending_approval
  status, maxSteps budgeting, and PromptContext/basePrompt composition. Use for
  "persona picker", "persona not applied after resume", "fold agents into personas",
  "orchestrator delegates to specialists", "ask_researcher denied",
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
`persona` field (AG-UI: `forwardedProps.persona`), and a persona a send NAMES is pinned on
the thread:

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

A flat persona `systemPrompt` stands in for the base prompt; a `PromptBuilder`
(`(ctx: PromptContext) => string | Promise<string>`) gets the base as `ctx.basePrompt` and
can wrap it; no `systemPrompt` keeps the base. `allowedTools` narrows the offer AND what
`ToolRegistry.invoke` will run (handoffs included). A send runs under: its own `persona` →
the thread's pin (if this agent declares it) → `defaultPersona` → none. Unknown id → `400`
`code: 'persona_not_found'`. `PATCH /agent/threads/:id { persona }` pins (`null` clears).
Render a picker from `GET /agent/agents` (`personas`, `defaultPersona` per agent).

Durable: the service resolves the persona to an id; the loop freezes the definition (prompt,
allow-list) in a `persona:resolve` checkpoint, so a parked run resumes on the persona it
started with even if config changed. Queued messages store their persona. `aliases: ['old-agent']`
on a persona keeps an old agent name (sends, thread `defaultAgent`, queued messages, in-flight
runs) resolving to this agent + persona.

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

Background delegation: an edge `{ agent: 'researcher', detached: true, roles: [...] }`
synthesizes `start_researcher` instead. The call returns a receipt
(`{ detached: true, status: 'started', agent, runId, note }`), the turn ends, and the
delegate's answer is posted into the same thread later as its own message stamped
`runId` / `agentName`; a failure or a Stop (`POST /agent/chat/:runId/cancel` with the
receipt's `runId`) posts a message too. A Stop on the turn that started it does NOT stop it. The client tracks them with
`useAgentChat({ background: true })` (`chat.background.runs`). Detached is per edge, never
the model's choice. Source: `personas-and-agents.mdx` ("Background delegation").

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
carries nothing, so under `DefaultToolAuthorizer` it takes `defaultRoles` (open unless
configured — except for personal agents (A2A/PACT, Poppy), which reach only tools that declare one of
their roles), and under the authz Bouncer adapter a spec without `ability` is denied
outright — the edge becomes uncalled for everyone.
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

### MEDIUM — answering a delegated sub-agent's approval against the wrong run

```ts
// Wrong — the nested researcher parked, but this signals the ORCHESTRATOR's run, so the
// child stays suspended and the delegation never returns.
const { runId } = await service.chat({ actor, message: 'go', agentName: 'orchestrator' })
await service.approve(runId, toolCallId)
```

```ts
// Correct — read the parked run off the frame. It is the CHILD's run, not the stream's.
for await (const frame of service.subscribe(runId)) {
  if (frame.t === 'approval') await service.approve(frame.runId, frame.id)
}
```

Mechanism: a sub-agent's `action` parks on `tool:<childRunId>:<callId>` on both runners. Its
frames are forwarded into the top-level ancestor's stream (durable `sinkRunId`; the inline
nested loop mirrors it), so the stream you subscribed to is NOT the run that is parked — and
the `approval` / `elicitation` frame carries `runId` for exactly that reason. A sub-agent
whose approvals nobody answers hangs. Source:
`packages/adonis/docs/durability/durable-runner.mdx` ("Answering a sub-agent"),
`packages/adonis/src/spi/token-stream-sink.ts` (`StreamFrame`).

### MEDIUM — expecting an edited persona to reach a run that is already parked

```ts
// Symptom — you changed `systemPrompt`/`allowedTools`, approved a parked call, and the run
// still answers with the old prompt and tools.
```

```ts
// Correct — that is the contract: `persona:resolve` froze the definition when the run
// started. New sends (new runs) pick up the edit; a parked run never changes persona mid-run.
```

Mechanism: the persona is journaled once per run so a durable replay is deterministic.
Source: `packages/adonis/src/agent-loop.ts` (`resolveTurnPersona`),
`packages/adonis/docs/authoring/personas-and-agents.mdx` ("Durable").

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
