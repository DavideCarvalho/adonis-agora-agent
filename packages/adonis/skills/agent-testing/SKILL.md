---
name: agent-testing
description: >-
  Test @adonis-agora/agent offline: FakeModelProvider with a pure FakeScript
  (args, turnIndex) and echoScript, the in-memory SPI doubles from
  @adonis-agora/agent/testing (InMemoryAgentStore, InMemoryTokenStreamSink.subscribe,
  InMemoryQuotaStore, InMemoryPricingStore, InMemoryGovernanceQueries,
  InMemoryActorDirectory, InMemoryAttachmentStagingStore, FakeEmbeddingProvider,
  FakeReranker, inMemoryRetriever), driving runAgentLoop directly with the
  step/awaitApproval/openSink hooks seam, or AgentDepsFactory + InlineAgentRunner, and
  asserting on typed StreamFrames. Use for "test the agent without an API key",
  "script a tool-call turn", "assert streamed text", "HITL approve in tests".
metadata:
  type: core
  library: "@adonis-agora/agent"
  library_version: "0.25.2"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-agent:packages/adonis/docs/testing.mdx"
  - "DavideCarvalho/adonis-agent:packages/adonis/src/testing/index.ts"
  - "DavideCarvalho/adonis-agent:packages/adonis/src/testing/fake-model-provider.ts"
  - "DavideCarvalho/adonis-agent:packages/adonis/src/agent-loop.ts"
---

# Testing @adonis-agora/agent offline

Everything the agent depends on is a seam, so a test can run a full turn — model call,
tool execution, governance, cost accounting — with **no API key and no database**. The
in-memory doubles implement the SAME SPIs as the production adapters, so a green test
exercises the real loop code paths.

## Setup

A minimal turn through the full loop, straight from the testing kit:

```ts
import {
  runAgentLoop,
  ToolRegistry,
  DefaultRolesPolicy,
} from '@adonis-agora/agent'
import {
  FakeModelProvider,
  echoScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '@adonis-agora/agent/testing'

const sink = new InMemoryTokenStreamSink()
const { text } = await runAgentLoop(
  {
    model: new FakeModelProvider(echoScript('hi there')),
    store: new InMemoryAgentStore(),
    registry: new ToolRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    day: '2026-07-21',
    systemPrompt: 'You are a helpful assistant.',
  },
  { threadId: 'thread-1', actor: { id: 'user-1', roles: ['USER'] }, userText: 'hi' },
  {
    runId: crypto.randomUUID(),
    openSink: () => sink.open('run-1'),
    awaitApproval: async () => 'approve',
    step: (_name, fn) => fn(),
  },
)
```

`hooks.step(name, fn)` is the checkpoint seam: inline it just calls `fn`; the durable
runner memoizes each named step. `hooks.awaitApproval` is where a HITL decision comes
from — return `{ approved: true }` (or a bare `'approve'`) to auto-approve in tests.

Source: `packages/adonis/README.md` ("Framework-agnostic core"),
`packages/adonis/src/agent-loop.ts` (`AgentLoopHooks`).

## Core patterns

### Pattern 1 — script a tool-call round-trip

`FakeModelProvider` takes a script — a pure function of `(args, turnIndex)`. `turnIndex`
counts assistant turns already in history, so there is no internal counter to reset:

```ts
import { FakeModelProvider } from '@adonis-agora/agent/testing'

const model = new FakeModelProvider((args, turnIndex) => {
  if (turnIndex === 0) {
    // first turn: ask to call a tool
    return { text: 'Let me check that.', toolCall: { name: 'getWeather', input: { city: 'Lisbon' } } }
  }
  // second turn: finish with the tool result in hand
  return { text: 'It is 21°C in Lisbon.' }
})
```

A scripted turn may also report `costUsd`, exactly as a gateway provider would, to
exercise the cost fold.

Source: `packages/adonis/docs/testing.mdx` ("The fake model"),
`packages/adonis/src/testing/fake-model-provider.ts`.

### Pattern 2 — run through the runner like production does

`AgentDepsFactory` + `InlineAgentRunner` is the same composition the provider builds at
boot, so the test covers run lifecycle persistence, not just the loop:

```ts
import {
  AgentDepsFactory,
  AgentRegistry,
  ToolRegistry,
  DefaultToolAuthorizer,
  InlineAgentRunner,
} from '@adonis-agora/agent'
import {
  FakeModelProvider,
  echoScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '@adonis-agora/agent/testing'

const store = new InMemoryAgentStore()
const sink = new InMemoryTokenStreamSink()
const registry = new ToolRegistry()
const agents = new AgentRegistry()
agents.register({ name: 'default' })

const factory = new AgentDepsFactory({
  model: new FakeModelProvider(echoScript('hello')),
  store,
  sink,
  rolesPolicy: new DefaultToolAuthorizer(['ADMIN']),
  registry,
  agents,
})

const runner = new InlineAgentRunner(factory, store)
const { runId } = await runner.start({
  threadId: (await store.createThread({ actor: { id: 'u1', roles: ['ADMIN'] }, persona: 'default' })).id,
  actor: { id: 'u1', roles: ['ADMIN'] },
  userText: 'hi',
})

let text = ''
for await (const frame of sink.subscribe(runId)) {
  if (frame.t === 'text') text += frame.v
}
```

Source: `packages/adonis/docs/testing.mdx` ("A minimal turn in a test").

### Pattern 3 — assert on typed `StreamFrame`s, not bytes

`sink.subscribe(runId)` yields discriminated frames — `{ t: 'text', v }` and
`{ t: 'component', name, data }` — so one loop can assert prose and Generative-UI
emissions separately. The SSE wire encoding happens later, in the provider's route
handler; a test never sees it:

```ts
const components: { name: string; data: unknown }[] = []
for await (const frame of sink.subscribe(runId)) {
  if (frame.t === 'text') text += frame.v
  if (frame.t === 'component') components.push({ name: frame.name, data: frame.data })
}
```

Source: `packages/adonis/docs/testing.mdx` ("Because the fakes are behavioral twins"
note), `packages/adonis/src/in-process-sink.ts`.

## Common mistakes

### MEDIUM — keeping mutable state in a FakeModelProvider script

```ts
// Wrong — a closure counter: the script is no longer a pure function of its inputs.
let calls = 0
const model = new FakeModelProvider(() => (calls++ === 0 ? { text: 'call tool' } : { text: 'done' }))
```

```ts
// Correct — derive the turn from turnIndex (assistant turns already in history).
const model = new FakeModelProvider((_args, turnIndex) =>
  turnIndex === 0 ? { text: 'call tool' } : { text: 'done' },
)
```

Mechanism: `turnIndex` is computed from the message history each call
(`messages.filter(m => m.role === 'assistant').length`), so history-derived scripts stay
deterministic and replay-safe; a closure counter diverges the moment a run is retried or
replayed.
Source: `packages/adonis/src/testing/fake-model-provider.ts` (`turnIndex` derivation).

### MEDIUM — registering a tool the test actor's roles cannot reach, then asserting it ran

```ts
// Wrong — DefaultRolesPolicy(['ADMIN']) + actor roles: ['USER'] → the tool is never OFFERED.
registry.register({ name: 'get_weather', kind: 'read', description: '', inputSchema: zodSchema }, handler)
const { text } = await runAgentLoop({ ..., rolesPolicy: new DefaultRolesPolicy() },
  { actor: { id: 'u1', roles: ['USER'] }, ... }, hooks)
```

```ts
// Correct — align the actor's roles with the tool spec (or the policy's defaults).
await runAgentLoop({ ..., rolesPolicy: new DefaultRolesPolicy() },
  { actor: { id: 'u1', roles: ['ADMIN'] }, ... }, hooks)
```

Mechanism: the offered-tools filter drops role-forbidden tools BEFORE the model turn, so
the fake model's `toolCall` for a hidden tool fails with `ToolForbiddenError` at invoke —
the loop never auto-executes what was never offered.
Source: `packages/adonis/src/tool-registry.ts` (`definitionsFor`, `invoke`),
`packages/adonis/docs/governance/authorization.mdx` ("The double check").

### LOW — asserting on the in-memory sink's frames as if they were SSE text

```ts
// Wrong — frames are typed objects, not an SSE byte stream.
const raw = await res.text() // 'data: {"delta":"..."}\n\n'
expect(raw).toContain('delta')
```

```ts
// Correct — narrow on t and assert the payload.
for await (const frame of sink.subscribe(runId)) {
  if (frame.t === 'text') expect(frame.v).toBeDefined()
}
```

Mechanism: `InMemoryTokenStreamSink.subscribe` yields `StreamFrame` objects; the SSE
envelope (`event: meta` / `data: {"delta":...}` / `event: done`) is produced by the
provider's route handler via `frameToSse`, a layer tests never cross.
Source: `packages/adonis/docs/testing.mdx` (StreamFrame note),
`packages/adonis/src/sse.ts` (`frameToSse`).

See also: `agent-tools/SKILL.md` — registering real tools into the test registry;
`agent-setup/SKILL.md` — why `day` is a required, runner-stamped loop dep.
