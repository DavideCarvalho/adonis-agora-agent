# @adonis-agora/agent

## 0.68.0

### Minor Changes

- [#333](https://github.com/DavideCarvalho/adonis-agora-agent/pull/333) [`2e4756a`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/2e4756a4e6f00556a5a44b68af0d1fb1a480fce8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Cost works out of the box for OpenRouter, and an unpriced model can no longer go silently NULL.
  
  - **OpenRouter cost is read.** The AI SDK adapter read `total_cost`, which `@openrouter/ai-sdk-provider` never emits, so every OpenRouter turn recorded `cost_usd = NULL`. It now reads `providerMetadata.openrouter.usage.cost` — the real, per-call routed cost — onto the usage row, the message and the run, where the quota's `usd` windows and the governance read-model pick it up. `total_cost` is kept as a fallback.
  - **Usage accounting is requested.** `aiSdkModel` / `aiSdkModels` add `providerOptions.openrouter.usage = { include: true }` to OpenRouter calls (your own `openrouter.usage` wins), and warn once per model when an OpenRouter call still returns no cost. `AiSdkModelOptions` gains a typed `providerOptions`.
  - **Boot seeds missing prices from models.dev.** At start the provider asks the model provider which models it runs (new optional `ModelProvider.describeModels()`, implemented by `aiSdkModel` / `aiSdkModels`) and writes the models.dev list price for any that has no price row — never overwriting one. New `priceCatalog` config (`{ url, fetch }` or `false`); skipped under `NODE_ENV=test` unless set. New `ensureModelPricing`, `lookupModelsDevPrices`, `modelsDevRefsFor`.
  - **Boot warns about a model that would record no cost**: no gateway cost and no price row, in one line naming it.

## 0.67.0

### Minor Changes

- [#331](https://github.com/DavideCarvalho/adonis-agora-agent/pull/331) [`f015961`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/f01596182ec7f3ee1e0ef35cdcf994cf9289fdda) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Text channels: `channels.handle(adapter, { onTurnEnded })` is called always, once this process is done with a message (or with a run resumed after its question), whatever it came to — `outcome` is `replied` (possibly having sent nothing), `failed` (with `error` when the job failed after its retries), `timeout`, `blocked`, `parked`, `stopped` (unknown sender or `beforeTurn`, no turn), `handled` (an answer, a press, a decision) or `interrupted` (a durable engine took the job away). It gets `channel`, `conversation`, `actor`, `message` (`null` for a resumed run), `runId` and `threadId`. For stopping what the app started for the message — a "typing…" presence begun in the adapter's `acknowledge`, which before had no hook when a turn ended without an outbound message or a durable step moved to another process. Per attempt under a durable engine; what it throws is logged and ignored. New exported types: `ChannelTurnEnded`, `ChannelTurnOutcome`.

## 0.66.1

### Patch Changes

- [#329](https://github.com/DavideCarvalho/adonis-agora-agent/pull/329) [`610351a`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/610351a87e6cbe2d7a008ec078295c9a6cd474d8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The native genui tree renderer (`@adonis-agora/agent/react/genui`) re-renders only the nodes that changed. The transcript keeps a pushed component's block, and the tree renderer keeps each node, the same object while it is structurally equal to the previous frame's, and tree nodes are memoized on that identity. Before, every node rendered again on each chat update (every token, every partial frame), and a renderer that set state in a layout effect (a chart that measures itself) could drive a fast stream into "Maximum update depth exceeded". A node whose props grew, or whose `incomplete`/`held` flag flipped, still renders.

- [#329](https://github.com/DavideCarvalho/adonis-agora-agent/pull/329) [`610351a`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/610351a87e6cbe2d7a008ec078295c9a6cd474d8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `useAgentChat` stops reading action proposals from a server that does not serve them. The first `404`, `405` or `501` from `GET threads/:id/action-proposals` (other than the library's own "unknown thread") marks proposals unsupported for that client: no more polling or refetching, and `chat.proposals.unsupported` is `true`. Transient failures keep polling, with a wait that doubles per failure up to 30 s.

## 0.66.0

### Minor Changes

- [#322](https://github.com/DavideCarvalho/adonis-agora-agent/pull/322) [`5c651c6`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/5c651c6c14247e9652390711119abcee5ff1c727) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fixes found while building the frontends comparison example:
  
  - **Hidden tools no longer run.** A tool whose `describe()` answers `available: false` for the turn (a genui `ui__render` or `ui__show_*` tool that `uiCapabilities` rule out) was left out of the tools offered to the model, but still ran when the model called it anyway. `ToolRegistry.invoke` now asks `describe()` again with the call's actor, thread, agent and `uiCapabilities`, and refuses the call as an unknown tool (`ToolNotFoundError`). The other offer filters (allow-list, `isEnabled`, roles, `canUse`) were already checked again on invoke.
  - **No 501 from the proposals list in blocking mode.** `GET <path>/threads/:id/action-proposals` (and `AgentService.listActionProposals` / `listActionProposalsPage`) answer an empty list when `actionApprovalMode` is not `'independent'`, instead of `501`. `useAgentChat` reads that list by default, so every chat logged a failed request unless it passed `proposals: false`. Approving or rejecting a proposal still answers `501` there.
  - **AG-UI approval interrupt wording.** The `tool_approval` interrupt's `message` is now the tool's `confirmation.title` when the call has one, the same wording the `agora.approval-requested` event carries. Before, it was always `Approve <tool>?`.
  - **Config stub.** `config/agent.stub` (and the JSDoc on `defineConfig`, `retrievers`, `tokenSinks` and `AuthzToolAuthorizer`) showed `aiSdkModel({ model: … })`. The function takes the model itself: `aiSdkModel(openai('gpt-4o-mini'))`.
  - **`FakeModelProvider` tool call ids are unique.** Ids were `call-<turnIndex>-<name>`, so the same tool on the same turn of two threads got the same id. On the Lucid store, where `agent_tool_call.id` is the primary key, the second run failed. The first call still gets `call-<turnIndex>-<name>`. A repeat from the same provider instance gets the first free `-2`, `-3`… suffix.
  - **A Stop aborts what the run is in.** Under the inline runner, cancelling a run aborts the in-flight model call (`ModelTurnArgs.abortSignal`, which `aiSdkModel` passes to the AI SDK) and hands tools the signal as the new `AiToolCtx.abortSignal`. Before, the model kept streaming to the end of the step. The run still ends `cancelled`, and the step the Stop cut short is still not persisted. Custom runners can pass the signal through the new `AgentLoopHooks.abortSignal`. The durable runner is unchanged.

- [#323](https://github.com/DavideCarvalho/adonis-agora-agent/pull/323) [`cbc1f78`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/cbc1f78cd72cdc37bc78723bdfbf8ce7c29aef48) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Generative UI: draw a `ui__render` tree while the model writes it.
  
  - **`genui({ streaming: 'partial' })`** (tree mode). The server parses the streaming `ui__render` arguments and pushes the tree so far as `ui` frames marked `partial: true`, under the id the final push replaces (`<toolCallId>:ui:0`). Previews are throttled (`streamingThrottleMs`, default 100 ms, and only when changed), never validated, never persisted, carry no `fallbackText` and are skipped by text channels; they only hold components the client declared, and stop at the first node it cannot draw. Only the final tree goes through the catalog; a preview the call does not replace (an invalid tree, a text fallback) is withdrawn with a partial frame whose `props` are `{}`. AG-UI sends the previews as repeated `agora.ui` events with the same id. The default stays `streaming: 'complete'` (today's behaviour), since renderers written for validated props would otherwise receive half-written ones.
  - **Per component:** `defineComponent({ …, streaming: 'complete' })` holds a component back while its subtree is written — the node is a `{ held: true, props: {} }` placeholder until it closes — and `streaming: 'partial'` opts one in.
  - **Stable nodes:** every node of a partial tree carries its position as `id` (`root`, `root.0`, …), the same rule that names the final tree's nodes, and `incomplete: true` while it is being written.
  - **React:** `<GenerativeUI>` renders partial trees without remounting nodes, skips prop validation for incomplete nodes, exposes `useGenuiNode()` (`{ id, type, incomplete, held }`) for skeletons, and draws `placeholder` (new prop on `<GenerativeUI>` / `<GenuiProvider>`, default `loading`) for held nodes. The transcript drops withdrawn previews and those whose call settled without replacing them.
  - **Framework-free client:** component parts carry `partial`; `foldPart` removes a withdrawn preview, and a finished stream drops leftovers (`settleParts`, exported).
  - **Tool SPI:** `ToolHandler.previewInput(scope)` lets any tool preview its streaming input; `parsePartialJson` is exported.

- [#323](https://github.com/DavideCarvalho/adonis-agora-agent/pull/323) [`cbc1f78`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/cbc1f78cd72cdc37bc78723bdfbf8ce7c29aef48) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Generative UI: tree mode is the default, with an exact `ui__render` schema.
  
  **BREAKING:** `genui({ catalog })` (and `genuiTools`) now default to `mode: 'tree'`. An app that relied on the default gets ONE model tool, `ui__render`, instead of a `ui__show_<component>` tool per component:
  
  - the model-facing tool names change (prompts, allow-lists, evals or approval policies naming `ui__show_*` must follow);
  - the client needs a renderer for every layout component it lets the model use (`Stack`, `Card`, … from `LAYOUT_COMPONENTS`), since composed layouts now arrive as `genui:tree` frames;
  - threads persisted before the upgrade keep rendering: their stored per-component `ui` parts are drawn by the same registry as before.
  
  **Migration:** to keep the old behaviour, pass `mode: 'per-component'` — still fully supported, and the better fit for small models or when each tool should carry its own exact schema.
  
  - **Exact schema.** `ui__render`'s input schema is now a recursive union by `type` (through `$defs` / `$ref`): each node variant carries its component's own props schema, and only components that take children have `children`. The root stays a plain object (OpenAI and Anthropic refuse a top-level union in tool parameters) listing every type and props schema. It follows the negotiated and per-request catalogs. A props schema that is not self-contained (a recursive Zod schema) is described as a plain object. `treeSchema: 'loose'` restores the previous generic node shape for a provider that refuses `$ref`. `validateTree` remains the check every call goes through.
  - **Single-node trees.** `{ type: 'DataTable', props }` is a valid tree and is pushed exactly as `ui__show_data_table` would push it (same component frame, version and `fallbackText`), so tree mode covers the one-component case.
  - The `node ace configure` config stub suggests `genui({ catalog: defineCatalog([...BUILTIN_COMPONENTS, ...LAYOUT_COMPONENTS]) })`.

### Patch Changes

- [#326](https://github.com/DavideCarvalho/adonis-agora-agent/pull/326) [`d052013`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/d052013dd13b462a25586d04610b92b5fd5094e3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - An empty assistant message no longer poisons a thread. When the model ended a step with no text (Claude does this right after a tool whose result is the answer, such as `renderResult`), the loop stored an assistant message with empty content and replayed it on the next turn. Anthropic and Bedrock refuse the whole request for it ("The content field in the Message object at messages.N is empty"), so every later message on that thread failed.
  
  - The loop no longer stores a step that has no text and nothing else on it (no tool call, pushed UI or reasoning). A tool-call-only assistant message is still stored and replayed as before. The `persist:assistant:<step>` checkpoint stays (it records `null`) and still ends the step on the stream, so runs in flight replay unchanged.
  - History building drops every assistant message whose text is empty or whitespace-only and that has no tool calls or results, so a thread that already stored one heals on its next turn.
  - `aiSdkModel` never sends an empty assistant message or a whitespace-only text part next to tool calls.
  - A detached run that ended on a blank step delivers no empty message to the delegating thread.

## 0.65.1

### Patch Changes

- [#325](https://github.com/DavideCarvalho/adonis-agora-agent/pull/325) [`da1a108`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/da1a108d0b9daa4e017c36c056c8fb62c3a2ad40) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Text channels: a message is answered under a single `durable:work` worker. A durable channel job runs inside the worker's tick, which ends only when the job does; with a dispatcher that only persists a started run, the turn the job started (and any delegate it spawned) waited for the next tick while the job waited for the turn — until `timeoutMs`, when the turn was cancelled and the person got the "something went wrong" text. While it reads a turn, a durable channel job now executes in its own process whatever of that turn is still `pending` (taking the run's lease, so a run another worker holds is left to it). New optional `AgentRunner.drive(runId)` (implemented by the durable runners) and `AgentService.drive(runId)`.

## 0.65.0

### Minor Changes

- [#320](https://github.com/DavideCarvalho/adonis-agora-agent/pull/320) [`c514e98`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/c514e987df62ae44f4d59529a9ecd27fba1254c5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Text channels: durable processing, scoped decisions and hooks.
  
  - **Durable processing.** With the agent on `@adonis-agora/durable` (`durable: true`), each inbound message is persisted as an `agora.channel.job` run before the webhook's `200`, handled one at a time per conversation (a singleton per channel conversation), in checkpointed, retried phases, and resumed after a crash — the turn is never started twice and the reply of a turn that finished while the process was down is still sent, once. Every outgoing message takes a slot in the channel store, so nothing is sent twice when work runs again. Without an engine the same pipeline runs in-process (ordered per conversation, retried, nothing survives a restart). New options `durable` and `retry`; `handler.handleRequest(request)`.
  - **Scoped text decisions.** "yes", "no #ID" and button labels only decide proposals whose card was delivered to that channel conversation; anything else gets `texts.noPendingConfirmation`. The channel starts turns with the new `AgentService.send(params, { textDecisions: false })`.
  - **Hooks:** `unknownSender`, `beforeTurn`, `canDeliver`, `texts` as a function of the actor/message, `onTurnStarted`, `uiCapabilities` + `renderComponent` (components as files), `mediaLimits` / `prepareMedia` / `transformInbound`, `formatOutcome` (outcome plus raw follow-ups, relayed once, in order), `texts.footer` for cards, `allowRemember: false`, and `onWebhook` (accepted / duplicate / ignored / unauthorized / failed).
  - **Outbound files** (`OutboundMessage.media`, `capabilities.media`) in `evolutionApi` / `whatsmiau` (`sendMedia`), `whatsappCloud` (link or upload) and `telegram` (`sendPhoto` / `sendDocument` / …), and card footers on the providers that have them.

## 0.64.1

### Patch Changes

- [#318](https://github.com/DavideCarvalho/adonis-agora-agent/pull/318) [`b7592bc`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/b7592bcb48e07b10241ac78a4860bc08ac16bc09) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - channels: `whatsmiau()` / `evolutionApi()` read Whatsmiau's incoming messages, which carry no `fromMe` (Go `omitempty`) — a message without `fromMe` counts as incoming only with `status: 'received'`; `fromMe: true` and any other status stay ignored. `key.remoteLid` is recognized as the chat's LID alias. The handler now logs a webhook that parsed to no message (event and reason, no content; `warn` when it looked like a person's message, else `debug`), with the reason from the new optional `ChannelAdapter.ignored(body)`.
  
  `whatsmiau()` no longer appends the text reply instruction to the buttons message (its buttons render); `evolutionApi({ buttons: true })` still does, and the text fallback (a 4xx, or buttons off) keeps the full instruction.
  
  A Whatsmiau button press arrives without its id (`buttonsResponseMessage` with only the label): the adapter marks it `buttonWithoutId`, and the handler maps the label to the one still-pending proposal card it sent to that conversation (remembered in the channel store); with several, it falls back to the text decision. The outcome message admitted to the thread leads with the tool's presentation text and no longer includes the proposal id (`Action "x" completed. Result: …`). Warmer pt-BR replies in `ptBrActionProposalText` ("Confirmado! Já estou cuidando disso.", "Tudo bem, cancelado. Nada foi feito.", "Esse pedido expirou; nada foi feito.").

## 0.64.0

### Minor Changes

- [#316](https://github.com/DavideCarvalho/adonis-agora-agent/pull/316) [`4f75931`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/4f75931ad3cc531be5bced67d8a5ea3b6a12db08) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Text channels: Brazilian Portuguese texts, self-sufficient buttons, and LID chats replied to by phone.
  
  - `ptBrChannelTexts` (and `ptBrChannelQuestionTexts`) ship next to `DEFAULT_CHANNEL_TEXTS`. When the agent's `actionProposalText` is `ptBrActionProposalText` (its vocabulary now carries `language: 'pt-BR'`), `channels.handle` starts from the Portuguese texts, so the reply words ("sim"/"não") and what the channel says agree; `texts` overrides that base part by part. `channelTextsFor(vocabulary)` returns the set picked.
  - A buttons message now carries the text reply instruction (`OutboundMessage.instruction`); `evolutionApi` puts it in the buttons description, so a phone that shows no buttons can still answer by text.
  - New `whatsmiau()` adapter, exported next to `evolutionApi`: the same Evolution-format implementation for [Whatsmiau](https://github.com/verbeux-ai/whatsmiau) (built on whatsmeow), with reply buttons on by default (they render; Evolution's Baileys `nativeFlow` buttons were not shown at all on the phone in testing with 2.3.7) and the `/v1` route prefix added to a host-only `url` (a url already ending in `/v1`, `/v2`… is kept). `evolutionApi` keeps buttons off by default.
  - `evolutionApi` LID chats: with `key.remoteJidAlt` (or `senderPn`) present, `conversation` is now the phone jid instead of the `@lid` jid, so replies are sent to the phone number and a chat keeps one conversation id whether it arrives addressed by phone or by LID. Conversation → thread mappings stored under a `@lid` jid start a new thread.

## 0.63.0

### Minor Changes

- [#314](https://github.com/DavideCarvalho/adonis-agora-agent/pull/314) [`ab09bbd`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/ab09bbdc9093fc07442b69a46d0560e582e2c89b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fixes to generative UI, the React AG-UI client and `AuthActorResolver`:
  
  - **GenUI text:** a `fallbackText` that returns an empty string renders nothing: a bare `Stack`, or a `Card` without a title, sent a JSON block of its props (`{}`) to text channels. In a tree, a layout's children still render.
  - **GenUI tools:** outside tree mode, layout components (`children: true`, like `Stack` and `Card`) get no `ui__show_*` tool, and the generic show tool (`showTool`) no longer offers them. They could only push an empty container. **Behavior change:** compose layouts with `mode: 'tree'`.
  - **`Chart` text:** the fallback draws every series instead of only the first. A bar chart gets one bar per series at each point, all on one scale. A line chart gets a sparkline per series (first → last, min/max) and the points as a table.
  - **React over AG-UI (`agUiBackend()` / `agUiChatStream`):**
    - Files the composer uploaded are now sent with the turn, as media parts by `file` handle (`{ type: 'file', provider: 'agora', value: <mediaId> }`). Before, they were dropped.
    - Regenerate now sends `forwardedProps.regenerate`, so the answer is regenerated. Before, the question was posted again as a new turn.
    - Question sets (`agora.elicitation`) render as the normal question block.
    - Per-step usage, cost and model (`agora.step-usage`) reach `step-finish`.
    - A tool call keeps its kind (`read`/`action`).
    - An interrupt the stream already carried as an approval or a question set no longer also renders as `AgUiInterrupt`.
    - After an approval or a question set the chat shows, the rest of the run streams into the same message. The AG-UI run ends on the interrupt, but the stream now ends without `done`, and the transport re-attaches to the parked run on `GET <path>/chat/:runId/stream?after=`. Before, a decision made through the native `tool-call` routes ran the rest of the run with nothing listening.
    - The re-attach cursor is the run's own sequence number (from the producer's SSE `id:`). The re-framed frames no longer carry an `id:` that counts them, which matched nothing on the native route. A producer that writes no `id:` is not re-attached to.
    - A text decision on a proposal (`agora.action-proposal-decision`) produces the same transient `data-proposal-decision` part as a native text decision.
    - `ChatStreamRequest.files` describes the send's staged uploads, and `content(body, files)` receives them.
  - **AG-UI producer (`agUiAdapter()`):**
    - Accepts a `file` handle with `provider: 'agora'` that names an upload it staged. The upload is resolved for the caller, as the native `attachments` refs are (`403` when it is not theirs).
    - Reads `forwardedProps.regenerate`.
    - `TOOL_CALL_START` carries `metadata['agora.toolKind']`, `agora.elicitation` carries the call `id`, and `agora.step-usage` carries the step's `model`.
    - Each event of the run carries an SSE `id:`: the run's own sequence number, as on the native stream, so `chat/:runId/stream?after=<id>` continues where the AG-UI run ended. `agUiSse(event, id?)` writes it, and `agUiEvents` keeps it in a new `cursor` option.
  - **`AuthActorResolver`:** the agent routes run no auth middleware, so `ctx.auth.user` was never set and every request was refused with `401`. When no guard has tried the request yet, the resolver now calls `ctx.auth.check()` itself; with the new `guards` option it calls `checkUsing(guards)` instead. Neither throws for an anonymous request, and the resolver still answers `401` when there is no user. `resolve()` is now async.

- [#313](https://github.com/DavideCarvalho/adonis-agora-agent/pull/313) [`6479996`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/6479996ab621edce7726275b5db9878c951b7d9f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Text channels: `@adonis-agora/agent/channels`'s `channels.handle(adapter, { actor, thread, onThreadCreated?, pageContext?, store?, … })` is a webhook route handler that verifies the request (`401` otherwise), parses it, dedupes by the provider's message id, answers `200` at once and runs the turn in the background (`handler.drain()` awaits it). The turn is sent with text-only capabilities; text decisions are answered with their reply; the reply (prose and component `fallbackText`, in order) is converted to the channel's markdown (`toChannelMarkdown`: WhatsApp, Telegram MarkdownV2, none) and split at its length limit on paragraph/line/sentence boundaries (`splitMessage`). Media (images, voice notes, video, documents) is downloaded through the adapter within the attachment store's limits, staged with the new `AgentService.stageAttachment(actor, file)` and attached to the turn; what cannot be attached is answered with `texts.mediaRefused`. A question set (`ask`, intakes) is sent as text one question at a time with numbered options, and the next messages answer it (`parseChannelAnswer`; `skip` keeps the defaults; unanswered after `questionTimeoutMs` it is skipped). A proposal the turn left pending is sent with Confirm/Cancel buttons whose press decides it (`via` = the adapter's name), or with a text instruction in the configured `actionProposalText` vocabulary; an approved proposal's outcome is relayed after the turn (`outcomeTimeoutMs`), and `actionProposalWorker: { onSettled: channels.onSettled }` relays outcomes that settle later through the adapter registered under the turn's recorded `pageContext.channel` — each outcome once. In blocking mode the handler sends what it has and says the approval must happen in the app. Built-in adapters: `evolutionApi({ url, instance, apiKey, webhookToken })` (Evolution API v2 `messages.upsert`; `sendText`, opt-in `sendButtons` with a text fallback; media from inline base64, `mediaUrl` or `getBase64FromMediaMessage`), `whatsappCloud({ phoneNumberId, accessToken, appSecret, verifyToken })` (`X-Hub-Signature-256`, `hub.challenge`, interactive reply buttons, Graph media download) and `telegram({ botToken, secretToken })` (secret-token header, MarkdownV2 with a plain-text retry, inline keyboards, `answerCallbackQuery`, `getFile`); any `ChannelAdapter` works. The channel's state (`ChannelStore`: message ids, questions in progress, relayed outcomes) defaults to `lucidChannelStore()` — the new `agent_channel_state` table, created by `createAgentTables`, the published migration or on first use — when the agent store is Lucid, else memory; `redisChannelStore(redis)` and custom stores plug in. `AgentService` also gains `actionApprovalMode()`, `actionProposalVocabulary()`, `attachmentLimits()` and `lucidDatabase()`.

## 0.62.0

### Minor Changes

- [#303](https://github.com/DavideCarvalho/adonis-agora-agent/pull/303) [`ee0a5c6`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/ee0a5c66f424f22deb4e1d904c64cb5e6701ae07) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Expose registered agents to personal agents (ChatGPT, Meta AI, a user's own assistant) over A2A 1.0 HTTP+JSON, following PACT (https://openpactprotocol.org). Register `@adonis-agora/agent/a2a_provider` and add `config/a2a.ts` (`defineA2aConfig`, from `@adonis-agora/agent/a2a`).
  
  - Per agent: an Agent Card, a synchronous `message:send`, and the task routes as PACT fixes them. Served as server middleware ahead of the router, so authentication happens before the body is read.
  - `authKitPersonalAgents()` authenticates with `@adonis-agora/authkit-server` 0.76+ personal agents: the agent's signed JWT and, when the user delegated, the delegation token. A delegated turn runs as the user's account, with each delegated scope as a `scope:<id>` role.
  - Conversations: `contextId` is bound to one agent and one (personal agent, user), and to the account once a delegated turn ran in it. A repeated `messageId` returns the stored reply. Conversation state lives in two tables created on first use (`store: 'lucid'`), or in memory.
  - `action` calls that park for approval are approved when the delegation grants one of the tool's roles, and rejected otherwise (`actions: 'reject'` rejects all of them). Independent proposals (`actionApprovalMode: 'independent'`) are decided the same way once the run ends, and the turn waits for an approved one to execute before answering; the reply carries what it did as a data part (`{ action: { tool, status, summary, result } }`). Question sets are skipped.
  - Step-up: a personal agent is offered the tools behind scopes it was not delegated but cannot run them. Calling one, or `request_permission`, makes the reply a `TASK_STATE_AUTH_REQUIRED` step-up with a consent link. `RolesPolicy` gains an optional `canOffer` (what the model is offered), separate from `can` (what runs).
  - Replies under delegation carry a signed receipt listing the tools that ran under a delegated scope.
  - `actor` maps the caller to the app's own actor (e.g. a profile instead of the account); turns carry `pageContext.channel = 'a2a'`.
  - `service` plugs in an app's own runtime (an `A2aTurnService` adapter) instead of the agent provider's `AgentService`.
  
  **Security:** the agent provider now wraps the configured authorizer with `personalAgentGate`. An actor with the `personal_agent` role reaches only tools that declare one of its roles; tools with no `roles` are out of its reach. Its memory and skill scopes resolve to none, so it never reads or writes what the assistant remembers about the user. Nothing changes for any other actor.
  - A `config/a2a.ts` that exports `undefined` (the surface flagged off) mounts nothing and logs nothing.

- [#306](https://github.com/DavideCarvalho/adonis-agora-agent/pull/306) [`2796edd`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/2796edd4b9f998b84cbc12cea779c21cfbe22c77) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Proposal and presentation hooks, and AG-UI fidelity:
  
  - **Text decisions are English by default** (`yes`, `confirm`, `approve`, `ok`, `no`, `cancel`, `reject`, `deny`, `always in this conversation`), and so are the replies. **Behavior change:** Portuguese commands (`sim`, `confirmar`, `cancelar`, …) and replies were the default; pass `actionProposalText: ptBrActionProposalText` to keep them. The new `actionProposalText: { vocabulary, replies }` config replaces the word lists and the reply texts for any other language. A command naming an `#ID` that is not a proposal of the thread (`sim #abc`) is now an ordinary message for the model instead of a `404`.
  - **`actionProposalWorker.onSettled(proposal)`**: called when a proposal's execution settles, so another channel (a WhatsApp bridge) gets the outcome pushed instead of polling. A throwing listener is logged and does not fail the worker.
  - **`onPresentationError(error, { toolName, toolCallId?, runId?, threadId? })`**: now wired for turns and proposal executions. Default: a warning on the app logger (was `console.warn`).
  - **No genui catalog + `uiCapabilities`**: `ctx.emitUi` no longer throws. A component the client declares is drawn; any other one degrades to its `fallbackText` (or is left out when it has none).
  - **AG-UI**: `agora.ui` carries `fallbackText` and `componentVersions`; `agora.approval-requested` carries the proposal `target` (and `confirmation`); a proposal's interrupt has `metadata['agora.target']` and resuming it decides the proposal through the proposal service (it used to hit the parked-call approve and fail with `400`).
  - **AG-UI event rename**: the proposal-decision custom event is now `agora.action-proposal-decision`, like every other `agora.*` event. The old `aviary.action-proposal-decision` is no longer sent — move listeners to the new name.
  - `AgentService.chat` lost an unreachable proposal-decision branch (`chat` never decides by text; `send` does).

- [#300](https://github.com/DavideCarvalho/adonis-agora-agent/pull/300) [`6db8d70`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/6db8d70189bb36ba6c4e4f77b585050da8f712d2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Support result presentation on functional tools and `@AiTool` classes through the existing journaled UI stream. Add the inferred object form of `defineTool`, preserve raw domain results, and report presentation failures separately so successful actions are not retried because rendering failed. Export Agora-owned optional React static HTML, paginated PNG and PDF renderers and Playwright capture adapter.
  
  Remove cross-ecosystem peers: Agora owns its GenUI contracts, React adapters, AG-UI codec, and resumable upload client. All entries build and publish independently of Aviary; compatible wire protocols remain supported.

- [#307](https://github.com/DavideCarvalho/adonis-agora-agent/pull/307) [`f3b8aa4`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/f3b8aa496d0b84f52811defd38b1f42ebcd5bf86) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Requires `@adonis-agora/durable` 0.43.3 or later (peer `>=0.43.3 <1.0.0`). Earlier versions could run one durable run twice at once in a process — a resume landing while the run was still executing — so a tool step could run twice after a very fast approval. 0.43.3 serializes a run's executions per process; the OpenCode durable engine relies on it instead of guarding its steps itself.

- [#304](https://github.com/DavideCarvalho/adonis-agora-agent/pull/304) [`5d263b0`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/5d263b0742d8f726c9a40561d2559d2032d16092) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - MCP server and OAuth, with `@adonis-agora/authkit-server`'s `mcp: true`:
  
  - The MCP server registers its URL with AuthKit at boot, so `claude mcp add <url>` logs users in with no URL in AuthKit's config.
  - `authKitAuth()` only accepts a token issued **for this server** (its RFC 8707 audience must be the endpoint's URL), as the MCP authorization spec requires. A token for another resource, or with no audience, is refused with `401`. **Behavior change:** clients that do not send `resource` need `authKitAuth({ audience: 'any' })`.
  - `McpAuth.verify(token, context?)` gets `{ resource }`; `anyOf()` passes it on.
  - Tool calls over MCP carry a `toolCallId` and an `idempotencyKey` per `tools/call` (tools that need one to write, ran refused before) and `pageContext.channel = 'mcp'`.
  - `middleware` in `config/mcp.ts`: route middleware for the MCP endpoint (a rate limiter, say); it runs before the bearer check.
  - `stateless: true` in `config/mcp.ts`: every `POST` gets its own transport (no in-memory sessions), for more than one instance behind a load balancer; `GET`/`DELETE` answer `405`.
  - `actions` in `config/mcp.ts` (`'refuse'` by default, or `'execute'`): the provider never passed it to the server, so action tools could not be exposed through `config/mcp.ts`.
  - `instructions` in `config/mcp.ts`: sent to the client in the `initialize` result.
  - `endpoints` in `config/mcp.ts`: more MCP servers in the same app, each a protected resource of its own (path, registry, auth, sessions, RFC 9728 metadata, OAuth registration), inheriting the top-level settings.
  - `tools/list` carries MCP `annotations` (`readOnlyHint` from the tool's kind by default); `describeTool` sets the `title` and the annotations per tool.
  - In stateless mode, `GET`/`DELETE` authenticate first (`401` with the login challenge), then answer `405`.
  - The RFC 9728 metadata route is named (`mcp.oauth_protected_resource`; `metadataRouteName` per endpoint).
  - Generative-UI tools (`ui__show_*`, `ui__render` — any tool whose result is shown elsewhere) are no longer exposed over MCP: there is no screen there, and the model got nothing back.

- [#307](https://github.com/DavideCarvalho/adonis-agora-agent/pull/307) [`f3b8aa4`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/f3b8aa496d0b84f52811defd38b1f42ebcd5bf86) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Engines: `defineConfig({ engine })` runs turns on something other than the library's loop — the routes, stream protocol, store, approvals, questions and queue stay the library's. `model` is optional under an engine, and `durable: true` is refused at boot unless the engine is durable itself. `@adonis-agora/agent/opencode`'s `openCode({ host })` runs turns on OpenCode 2 sessions, and `@adonis-agora/agent/opencode/durable`'s `openCodeDurable({ host })` checkpoints each step as the `agora.agent.opencode.run` workflow (decisions are durable signals; a parked turn survives restarts and catches up on what OpenCode asked meanwhile). OpenCode's events become the native frames and store rows (steps with usage, text, reasoning, nested code-mode calls, permissions as approval cards, forms as elicitations, cancel as `session.interrupt`); the agent's prompt and persona, `approvalPolicy`, skills, memory and regenerate reach the session; the app's tools are served to it over an internal MCP endpoint (`POST <path>/opencode/mcp`: signed per-actor tokens, calls only from a session running a turn of that actor, actions only against an approval the turn granted, `remember` at the actor's scope, `ctx.emitUi` into the turn). `AgentRunInput.hostContext` (and `ChatParams.hostContext`) carries the host's own JSON about a send through the queue (new nullable `host_context` column, healed on boot; never on the wire view) and the durable journal to the engine's host hooks: `onAsk`, `onUi`, `beforeSettle` and `onSettled`. `AgentRunner.runIdFor` lets a runner name its runs; `ToolCallRequest.parentId` records a call made inside another.

### Patch Changes

- [#306](https://github.com/DavideCarvalho/adonis-agora-agent/pull/306) [`2796edd`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/2796edd4b9f998b84cbc12cea779c21cfbe22c77) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fixes from a docs audit:
  
  - `@AiTool` / `static tool` classes keep their `replacementKey` (it only worked with `defineTool`).
  - `POST <path>/chat` answers malformed `uiCapabilities` with `400 invalid_ui_capabilities` instead of a `500`.
  - A refused proposal decision over AG-UI (text or resume) answers its status (`403`/`404`) instead of a `500`.
  - `UiCapabilities` / `validateUiCapabilities` have one definition; both the root and `/genui` entries still export them.
  - Corrected stale comments (`genui` needs no extra peer, the default authorizer and actor resolver are not fail-closed, the migrations `configure` publishes) and removed a committed `.orig` file.

## 0.61.0

### Minor Changes

- [#274](https://github.com/DavideCarvalho/adonis-agora-agent/pull/274) [`7e8c6b7`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/7e8c6b78db25e455be3d654e6784ae7938833122) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add optional action preflight before approval and execution, with denied and completed outcomes, resolved approval confirmation, durable replay persistence, and functional/class authoring support.

- [#275](https://github.com/DavideCarvalho/adonis-agora-agent/pull/275) [`c1fdeb6`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/c1fdeb65dd6210a8e8244f09bcbd4cf7bcd3990d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add the optional ActionProposalStore capability with scoped replay-safe snapshots, atomic decisions and queued execution work, and fenced recoverable leases in memory and Lucid. This is the persistence foundation; independent conversation execution is not enabled yet.
  
  Existing hosts using `autoCreateTables: false` must add a new migration that invokes `createAgentTables` on the chosen connection before using proposals. An already-recorded older migration will not run again.

- [#278](https://github.com/DavideCarvalho/adonis-agora-agent/pull/278) [`7f2ba63`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/7f2ba6306e742627084193042e0d6be52c37fab6) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add indexed worker-only proposal discovery to Lucid: claim queued or expired-lease work across
  scopes and expire due pending cards in bounded batches. Every proposal mutation keeps discovery
  metadata in the same fenced write. Mirror the shared worker-store conformance contract and add
  bounded, version-fenced backfill for existing proposals after additive schema migration.
  
  Stop old writers before applying the forward migration and repeating backfill batches, then start
  the new workers. This capability does not itself enable the independent conversation runtime.

- [#279](https://github.com/DavideCarvalho/adonis-agora-agent/pull/279) [`0f5a1c1`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/0f5a1c10a830e7de10b16ec0d31b461ce8b1aa10) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Match Aviary's opt-in independent approval runtime: pending cards release the chat turn, scoped
  channel/text decisions queue actions under fresh requester authorization, atomic replacement
  supersedes pending proposals, and fenced workers admit terminal facts/UI into history.
  Remembered grants derive from terminal proposal state; existing blocking journals retain their
  behavior. Include native SDK polling/decisions, component capability negotiation and text fallback.
  
  Ship additive Lucid runtime migration and configure inventory. Apply it and the proposal discovery
  backfill before enabling workers. External effects remain at least once and require the stable
  tool-context idempotency key. See docs/independent-approvals.md for setup and rollout.

- [#276](https://github.com/DavideCarvalho/adonis-agora-agent/pull/276) [`92450af`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/92450af57e8339e15630d7a70fccfee9b1e64b61) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add opt-in trusted preparation for independent action proposals. Preserve original JSON separately
  from the approved normalized input and immutable execution context, and reject schema or hook
  input drift before effects. Existing blocking preparation and invocation retain their behavior.
  Expose privileged worker discovery with a reference implementation in memory; SQL discovery and
  the independent conversation runtime are separate follow-up work.

## 0.60.1

### Patch Changes

- fix(deps): update dependency @modelcontextprotocol/sdk to v1.31.0 ([#277](https://github.com/DavideCarvalho/adonis-agora-agent/issues/277))

## 0.60.0

### Minor Changes

- [#271](https://github.com/DavideCarvalho/adonis-agora-agent/pull/271) [`f9e12b7`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/f9e12b7d5c69caa1bc884ad6d72a9d0c5e825491) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Personas, at parity with `@dudousxd/nestjs-agent` 1.20** — durable, pinned on the thread, enforced
  on every call, and able to take over an old agent's name. Same wire as Nest: `POST chat { persona }`,
  `forwardedProps.persona`, `persona` on every message and on the thread.
  
  - **Durable.** The service resolves the persona to an **id** before the run starts; only the id
    rides `AgentRunInput` (and a queued message). The loop looks the definition up once and freezes it
    — id, label, allow-list, resolved prompt — in a `persona:resolve` checkpoint, so a parked run
    resumes on the persona it started with even after the config rewrote or removed it. Only a run
    that names a persona spends that checkpoint. A run parked on 0.59 or earlier (which carried the
    whole `Persona` in its input) replays exactly as recorded, with no new checkpoint; a builder prompt
    its JSON input lost is looked up by id. `AgentRunInput.persona` is `string | Persona` (a whole
    persona is still applied as given, with no checkpoint).
  - **Thread pin.** A send runs under its own `persona` → the thread's pin (when this agent declares
    it) → the agent's `defaultPersona` → none. A persona a send names is pinned on the thread (it was
    stored at creation and then ignored); one it fell back to is not. `PATCH /agent/threads/:id
    { persona }` pins one (`null` clears); `ThreadSummary.persona` is now `string | null`.
  - **`400 persona_not_found`** (`PersonaNotFoundError`) for an id the agent does not declare — on a
    send before anything is created, on the AG-UI route, and on the patch. It used to fall back to no
    persona silently.
  - **Enforced on invoke.** `allowedTools` narrowed only the offer; a call the model named anyway now
    fails `ToolRegistry.invoke` (`InvokeOptions.allowedTools` → `ToolForbiddenError`), and handoffs
    are held to the same list. Tools see `ctx.persona` (the frozen definition).
  - **Queue.** A queued message stores the persona its send resolved (`agent_queued_message.persona`,
    added by `createAgentTables` on SQLite, Postgres and MySQL) and starts under it. One queued
    without it resolves one as it starts. `ChatQueueServiceOptions.resolveTarget` replaces
    `personaFor` (kept, deprecated).
  - **Catalog.** `GET /agent/agents` lists each agent's `personas` (`{ id, label, description? }`)
    and its `defaultPersona`. `GET /agent/threads/personas/catalog` stays.
  - **`Persona.aliases`.** Old agent names a persona took over resolve to that agent + persona
    everywhere an agent name is read — sends, a thread's `defaultAgent`, queued messages, and runs in
    flight under the old name (served with the persona applied as config). No data migration.
  - `Persona.systemPrompt` is optional (omit → the base prompt) and `Persona.description` is new.
    Stores: `CreateThreadInput.persona` is optional, `UpdateThreadInput.persona`, optional
    `AgentStore.personaForThread`, `persona` on queued messages. Exports: `findPersona`,
    `defaultPersonaOf`, `intersectAllowLists`, `personaCatalogEntry`, `resolvePersonaAlias`,
    `PersonaNotFoundError`, `TurnPersona`, `PersonaCatalogEntry`, `InvokeOptions`.

## 0.59.0

### Minor Changes

- [#268](https://github.com/DavideCarvalho/adonis-agora-agent/pull/268) [`9efc215`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/9efc2157cf5b7f3c32311d486fa42e50b4070807) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The Lucid stores work on **MySQL**, and every Lucid store suite now runs on SQLite, Postgres 16
  and MySQL 8.4 (`pnpm test:db`, testcontainers; required in CI). Fixed along the way:
  
  - **MySQL could not create the tables.** The schema DDL quoted identifiers `"like this"`, which MySQL
    reads as string literals, and used `CREATE INDEX IF NOT EXISTS`, which MySQL lacks, so
    `createAgentTables` — the published migration and `autoCreateTables` — failed on the first
    statement. The same quoting broke the Lucid token sink's insert and purge. The DDL is now rendered
    per dialect (`forDialect`): backticks, `LONGTEXT` instead of 64 KB `TEXT`, indexes looked up in
    `information_schema` first, and `ENGINE=InnoDB` with `utf8mb4_bin` so `actor_ref = 'alice'` does not
    match `'ALICE'`.
  - **Foreign keys are table constraints.** MySQL ignores a column-level `REFERENCES`, so deleting a
    thread never cascaded there. New tables get table-level `FOREIGN KEY … ON DELETE CASCADE` on every
    dialect (same behaviour on Postgres/SQLite).
  - **Message order.** A transcript was ordered by `created_at` alone, so two messages written in the
    same millisecond (a turn's assistant and tool messages) came back in whatever order the database
    chose. `agent_message` gains `seq BIGINT NOT NULL DEFAULT 0`, assigned on append and copied in order
    on fork; rows from before hold 0 and sort first. `autoCreateTables` adds it; with
    `autoCreateTables: false`, add a migration whose `up()` calls `createAgentTables` again.
  - **`claimActiveStream`** admits the holder re-claiming its own thread on a MySQL connection without
    `FOUND_ROWS`, which reports changed rather than matched rows.
  - **Concurrent provisioning on MySQL.** Several processes creating the schema at once could fail
    on `CREATE INDEX` with a deadlock (MySQL rolls one session back while the other's index is not
    yet in the catalog); a statement rolled back that way is now sent again.
  - **The Lucid token sink** retries a writer InnoDB rolled back as a deadlock victim — how MySQL
    settles two replicas appending to one run at once — like a duplicate key.

## 0.58.1

### Patch Changes

- [#264](https://github.com/DavideCarvalho/adonis-agora-agent/pull/264) [`a6f5488`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/a6f548875cce780e9fbcc9d4ba1785691432c88d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A detached delegation now survives a Stop on the turn that started it (durable runner). It used to
  be a `ctx.startChild` child, and the engine cascades a parent's cancel to every run it spawned — so
  stopping the visible turn after it had handed work off also cancelled the background run, and the
  delegating card could stay "started". It is now started as a run of its own from a journaled
  `detach:<toolCallId>` step (behind `ctx.patched('agent:detached-unlinked')`, deterministic id
  `<runId>.detached.<toolCallId>`, the parent's namespace); `parentRunId` stays on its input. A run
  that journaled its `spawn:` on 0.58.0 replays it unchanged, and when such a run's Stop still
  cascades, `DurableAgentRunner.cancel` settles the cascaded child's card `cancelled` (once).
  `DurableAgentContext` gained an optional `engine` (the provider sets it; otherwise the engine passed
  to `registerAgentWorkflow` is used). Parity with `@dudousxd/nestjs-agent` 1.19.3.

## 0.58.0

### Minor Changes

- [#262](https://github.com/DavideCarvalho/adonis-agora-agent/pull/262) [`0cd5f79`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/0cd5f79dd6bd81a2a5199c592544a4e09d4c4035) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Detached sub-agents — the chat stays free.** A `delegatesTo` edge can run its delegate in the background: `{ agent: 'researcher', detached: true }` synthesizes `start_researcher`, whose call returns a receipt (`{ detached: true, status: 'started', agent, runId, note }`) and lets the turn end. The delegate runs on its own stream and parks its approvals under its own run id; when it finishes, its answer is posted into the same thread as a message of its own, stamped `runId` and `agentName`, and the delegating tool call settles `delivered`. A failure or a Stop (cancel the receipt's `runId`) posts a message and settles `failed` / `cancelled`. Both runners: inline (a nested loop nobody awaits) and durable (`ctx.startChild`, one `spawn:` position from the workflow body). On the client, `useAgentChat({ background: true })` tracks them (`chat.background.runs`, polling while one runs).
  
  Replay-safe for runs already in flight: the detached branch is settled inside the call's `persist:toolcall` checkpoint and the delivery position exists only on a detached child's own run, so a run parked on an earlier release replays the shape it recorded (a spec parks runs on 0.56.0 and resumes them on this release, over SQLite and Postgres). Flip an edge to `detached` once every process runs this release.
  
  Messages carry an optional `agentName` (`StoredMessage`, `AppendMessageInput`); the Lucid store adds `agent_message.agent_name`, repaired in by `createAgentTables` on an existing database and written only when set.
  
  **Staged-attachment inventory.** `AttachmentStagingStore.list` (implemented by `attachmentStores.media()` and `.memory()`), `GET /agent/attachments` (the caller's own staged files, metadata only), and `AgentService.listAttachments` / `collectableAttachments(actor, { olderThan })` — the staged files no message references and old enough not to be in flight, for a sweep you run (the library never deletes). A message waiting in a thread's queue counts as a reference. Refuses with `AttachmentInventoryError` (`501`) rather than guessing when either half cannot be answered.

## 0.57.0

### Minor Changes

- [#260](https://github.com/DavideCarvalho/adonis-agora-agent/pull/260) [`64c887f`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/64c887f2cd403fbf2a1ff418cd5edb215641782e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - AG-UI: the encoder is now the shared one in `@dudousxd/nestjs-agent-core/ag-ui` — one implementation for both servers instead of a copy each. `@adonis-agora/agent/ag-ui` re-exports it unchanged (same events, same interrupt ids), with `AgUiEncoder` and `agUiEvents` still reading this package's `StreamFrame`s; `toAgUiFrame` / `agUiFrames` are the new mapping helpers.
  
  **Requires `@dudousxd/nestjs-agent-core` 0.35 or later** (an optional peer, raised from 0.26) for the `ag-ui` entry — install it if you serve AG-UI. A `approval-requested` or `elicitation` event a custom runner writes into the sink directly is now an interrupt too (the parked run defaults to the stream's own), rather than only a `CUSTOM` event.

## 0.56.0

### Minor Changes

- [#255](https://github.com/DavideCarvalho/adonis-agora-agent/pull/255) [`4a1d508`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/4a1d508f7fa9a54f083317b807ed90da12fbfa63) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `useAgentChat` over AG-UI from `@adonis-agora/agent/react` — `agUiBackend()`, and a CSRF-aware `agUiChatStream`
  
  `@dudousxd/nestjs-agent-react`'s AG-UI 1.0 consumer (`agUiChatStream`, `reframeAgUiStream`) was already reachable through the re-export, but sent only the headers it was handed once — so behind an Adonis session shield refused the first `POST`. Now:
  
  - `agUiBackend()` — `<AgentProvider backend={agUiBackend()}>` runs every chat turn over `POST <path>/ag-ui` (the `agUiAdapter()` route) and keeps threads, the queue, approvals and uploads on the REST routes, with the session cookie and the CSRF token read per request. `url` points it at any other AG-UI producer.
  - `agUiChatStream` from `@adonis-agora/agent/react` adds the CSRF header on every call.
  
  The `@dudousxd/nestjs-agent-react` peer floor moves to `>=0.30.0` (the release that has the consumer).

- [#256](https://github.com/DavideCarvalho/adonis-agora-agent/pull/256) [`38ea2f9`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/38ea2f93303eae4a3c7e30b3e10bff0913ee8236) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A file a message in your own thread already carries is yours to attach — `AgentStore.referencedMediaIds`
  
  `attachmentStores.media()` let only the uploader attach a file (unless `canAccess` widened it). Now the default also admits an actor whose OWN thread holds a surviving message carrying that file — a fork, a regenerate — matching `@dudousxd/nestjs-agent`. The verdict is handed to `canAccess` as `allowed`, so it can still be narrowed.
  
  It is derived on every send, not remembered: the new optional `AgentStore.referencedMediaIds(actorRef, mediaIds)` answers from the messages that still exist (so `truncateFrom` takes the access away again), scoped to one actor so it cannot probe anyone else's conversation. `LucidAgentStore` and `InMemoryAgentStore` implement it; a store without it keeps the uploader-only rule. The attachment-store factory context now carries the provider's `agentStore`.

- [#257](https://github.com/DavideCarvalho/adonis-agora-agent/pull/257) [`236c139`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/236c1396e1483e4bdca7cf4f7e717e4ad4914b8a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Resumable (tus) chat attachment uploads on `@adonis-agora/media` — and `@adonis-agora/agent/react/media`
  
  With `attachmentStores.media()` over a media library that has `uploads.resumable` in `config/media.ts`, the provider now mounts `POST <path>/attachments/uploads` (validate + open an owned tus session → `{ mediaId, uploadId, location }`), `POST <path>/attachments/uploads/:mediaId/complete` (`409` while bytes are missing, `422` and dropped on a size mismatch, `404` for another actor's id) and `DELETE <path>/attachments/uploads/:mediaId`. The bytes go to the media library's own tus routes (`tusBasePath`, default `/media/uploads/tus`). `GET <path>/config` reports `upload: 'resumable'`; the multipart route stays. A pending upload is not attachable until it completes.
  
  On the client: `<AgentProvider attachments={{ upload: mediaAttachments() }}>` from the new `@adonis-agora/agent/react/media` subpath (a re-export of `@dudousxd/nestjs-agent-react/media`; optional peer `@dudousxd/nestjs-media-client`).
  
  `MediaAttachmentStaging` gains `beginUpload` / `completeUpload` / `discard` (and `MediaUploadRefusedError`), and `remove` aborts an upload still in flight. `AttachmentStagingDescription.upload` is new. Matches `@dudousxd/nestjs-agent`'s `AgentMediaAttachmentsModule` routes.

- [#258](https://github.com/DavideCarvalho/adonis-agora-agent/pull/258) [`c8e8017`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/c8e8017cc2a203e2aa6c20e1cab54eb61ead8ba5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A thread can have its own default agent — `PATCH <path>/threads/:id { defaultAgent }`
  
  A send that names no `agent` now runs as the thread's `defaultAgent` when it has one, else the configured default (a send's own `agent` still wins). `null` clears it; a name no agent is registered under is a `400` (`UnknownAgentError`). Patching `model` in the same request checks the model against the agent the thread's next turn runs as. Thread summaries carry `defaultAgent`.
  
  Before, the key was silently ignored. Matches `@dudousxd/nestjs-agent`, whose React client already sends it.
  
  Stores: `UpdateThreadInput.defaultAgent`, and an optional `AgentStore.defaultAgentForThread(threadId)` (one scalar instead of the whole transcript on every send). `LucidAgentStore` stores it in a new nullable `agent_thread.default_agent` column — created by `createAgentTables` and added to an existing table by the same additive repair as earlier columns (no new migration to run). `InMemoryAgentStore` implements both. `AgentService.updateThreadSettings(actor, threadId, { defaultAgent?, model? })` is the service entry; `setThreadModel` delegates to it.

- [#254](https://github.com/DavideCarvalho/adonis-agora-agent/pull/254) [`942ba27`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/942ba273fcc21e25fa5b3d758f9a8d8dd528f1b8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A tool can say whether it exists here, and who may use it — `enabled`, `isEnabled()`, `canUse(actor)`
  
  `roles`/`ability` are checked by one app-wide `RolesPolicy`, and an agent's `tools` allow-list is fixed when the agent is declared. Neither could say "this capability is off in this deployment" or "only accounts on the paid plan get it", so the per-actor decision had to live inside `execute` — where a refusal has already cost the model a turn and told the user the capability exists.
  
  - **`enabled`** on `@AiTool({ … })`, `static tool = { … }`, `defineTool` and `defineConfirmedTool` — a boolean, or a predicate re-read every turn — and **`isEnabled()`** on a tool class (container-resolved, so it can read an `@inject`'d service).
  - **`canUse(actor)`** as a method on a tool class, or an option on `defineTool` / `defineConfirmedTool`.
  - **`mcpServers[].enabled` / `mcpServers[].canUse`** — the same two gates for every tool an MCP server exports.
  
  Both run when the turn's tool list is built (so `GET <path>/tools` and the MCP server's `tools/list` agree with it) and again on invoke, which is what stops a HITL action approved before a flag moved from running after it. Order: allow-list → `enabled` → `RolesPolicy` → `canUse`; every layer only removes tools. A disabled tool raises the new `ToolDisabledError`, distinct from `ToolForbiddenError` and `ToolNotFoundError`. `isToolEnabled`, `canActorUseTool`, `filterToolsByEnabled` and `filterToolsByCanUse` are exported.
  
  Also fixed on the way: a tool class's `describe()` was not forwarded by discovery, and `Guardrails.wrapTool` dropped `describe` — both now reach the registry.
  
  Matches `@dudousxd/nestjs-agent`'s `ToolSpec.enabled` / `ToolHandler.isEnabled` / `ToolHandler.canUse`. Purely additive: a tool that declares none of this behaves exactly as before.

## 0.55.0

### Minor Changes

- [#250](https://github.com/DavideCarvalho/adonis-agora-agent/pull/250) [`8588039`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/8588039a47510482483ca9cf3caa5a54308eee50) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Serve the agent over AG-UI 1.0. With `adapters: [agUiAdapter()]` in the config (`agUiAdapter` from `@adonis-agora/agent/ag-ui`), `POST <path>/ag-ui` takes a `RunAgentInput` and answers with the run as AG-UI events, so any AG-UI client (`@ag-ui/client`, CopilotKit) drives the agent as-is. The native stream is unchanged.
  
  - A run that stops for an approval or a question set ends with the interrupt outcome; a later request answers it in `resume` and continues the parked run. The interrupt id carries the whole address, so nothing is kept between the two requests and any replica serves the resume.
  - Multimodal input: a media part carried inline becomes an attachment through the configured attachment store.
  - `RUN_FINISHED.usage` reports tokens per model; a stopped run ends with the cancelled outcome; generative UI, title and the queue travel as `agora.*` custom events.
  - `adapters` takes any `ProtocolAdapter`: the provider hands it the service and the same gates the native routes pass through, so another protocol is an adapter, not a change to the provider.
  - New subpath `@adonis-agora/agent/ag-ui` (`AgUiEncoder`, `agUiEvents`, the input readers) for a host that mounts its own route.
  - `CreateThreadInput.id` (optional): a store may create a thread under an id the caller names. `step-finish` gains an optional `model`.

## 0.54.0

### Minor Changes

- [#246](https://github.com/DavideCarvalho/adonis-agora-agent/pull/246) [`efac7c7`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/efac7c798a5545aad35185403cb8179d07ea98e0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A tool is handed an idempotency key.
  
  `ctx.idempotencyKey` is `<runId>:<toolCallId>` — the same for every execution of one tool call, and
  for no other — and `ctx.toolCallId` names the call. A tool's side effect and the checkpoint that
  records it are two writes: under the durable runner a worker that dies between them leaves a call
  the journal does not know ran, and recovery runs it again (an in-step transient retry re-invokes it
  too). The library cannot make an application's write atomic with its journal, so it hands the tool
  the value that makes the second attempt recognisable — pass it on as the downstream idempotency key
  (a provider's `Idempotency-Key`, a unique column on the inserted row, the `id` of a workflow the
  tool starts). Both are absent where a tool runs outside a turn (the MCP server, a direct
  `registry.invoke`). Same wire as `@dudousxd/nestjs-agent-core`.

## 0.53.2

### Patch Changes

- [#244](https://github.com/DavideCarvalho/adonis-agora-agent/pull/244) [`60041da`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/60041daa39cafd4ef4e874f155b21beca4705100) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A run is attachable from the moment it holds its thread, not from the moment a worker starts it.
  
  A send, and a queue drain handing the thread to the next message, admit the run to its thread and only then start it. Under the durable runner the body runs in a worker, so for as long as the worker takes to pick it up the run had no row and no stream — and `GET <path>/chat/:runId/stream` and `POST <path>/chat/:runId/cancel` answered `404`. That is exactly when a client attaches: the settling turn's `queue` frame has just told it the queued message started. The React client reads that `404` as "already finished" and re-reads the thread, so the queued message vanished from the screen and its answer never streamed until a reload.
  
  Now a run with no row yet is owned by the thread it holds (`AgentStore.threadHeldByRun`, optional; the Lucid and in-memory stores implement it), and `hasStream` counts a run that holds its thread and that the runner reports alive as about to stream, so the attach waits for the first frame instead of being turned away. A claim left behind by a process that died is still nothing to resume.

## 0.53.1

### Patch Changes

- [#242](https://github.com/DavideCarvalho/adonis-agora-agent/pull/242) [`e97471d`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/e97471d18e99a0eb38935631f352e669af9f0b6f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A turn that dies mid-step no longer takes its thread with it.
  
  A turn writes its tool results onto the assistant message once the step's last tool has settled. A
  run that died before that — refused a checkpoint position, killed with its worker, failed while
  settling a tool — left an assistant message asking for tools and answered by nothing, a call still
  `pending_approval`, a run row still `running`. The next message on the same thread was then sent to
  the provider with a tool call and no result after it, and failed with the AI SDK's "No output
  generated. Check the stream for errors." — every time, for the rest of the conversation.
  
  - **History is settled before it is sent.** Reading the thread for a turn now answers every tool
    call its message holds no result for: with what the call's own row says where the store can read
    it (`AgentStore.toolCallOutcomes`, optional, implemented by the Lucid and in-memory stores) — a
    tool that DID run hands the model its real output, so it is not run a second time — and otherwise
    with a result saying the call was never completed. Done inside `load:thread`, so it takes no
    checkpoint position and a replay composes the same prompt. `settleDanglingToolCalls` /
    `danglingToolCallIds` are exported.
  - **A run that ends without settling leaves nothing waiting on it.** A failing run settles the calls
    it had put to a person as `failed` (`AgentStore.failUnsettledToolCalls`, optional). A run refused
    a checkpoint position — which cannot write a checkpoint — settles its row, its calls and its
    thread straight to the store. A send that finds its thread held by a run that is gone settles
    that run the same way (`settleDeadRun`).
  - **A decision for a run that is over is refused**, not swallowed: `approve` / `reject` / `answer` /
    `skip` throw `RunNotActiveError` (`409 { code: 'run_not_active' }` on the routes) instead of
    signalling a run that will never read it — the card no longer says "approved" for something that
    will not run.
  - **The error frame is written for the person reading the chat.** `streamErrorFrame` carries a
    stable `code` (`run_failed`, plus the new `replay_diverged` and `model_no_output`) and, in
    production, `RUN_FAILED_MESSAGE` instead of the error's own text; the error is logged with its
    run id and stays on the run row. Outside production the raw message still rides the frame;
    `exposeStreamErrorDetails(true | false)` decides it outright. Messages the library words itself
    (`quota_exceeded`, `output_rejected`, `structured_output_invalid`) are unchanged.
  - **`aiSdkModel` throws the provider's own error** when the stream carries one, instead of letting
    it surface as "No output generated".

## 0.53.0

### Minor Changes

- [#237](https://github.com/DavideCarvalho/adonis-agora-agent/pull/237) [`ea405b3`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/ea405b37f63527fbd89063610c497ec7e0e679e9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `emptyRoles: 'deny'` — a ready-made closed roles gate, for apps where an empty roles list means "no one". Closes [#235](https://github.com/DavideCarvalho/adonis-agora-agent/issues/235).
  
  **Upgrade note for 0.46, which did not say it outright:** since 0.46 `DefaultRolesPolicy` / `DefaultToolAuthorizer` treat an empty roles list as **open**. Before, `[]` denied everyone. So `roles: []` on a tool, `defaultRoles: []`, `registerFunctionalTool(registry, tool, [])` and any computed `roles` that can come out empty ("the roles holding permission X" when none does) went from reaching nobody to reaching every resolved actor, with no error and no warning. On a multi-tenant MCP server that is silent and serious.
  
  The default does not change — an empty list is still open, which is what makes `defineConfig({ model })` a working chat. What is new is the switch to keep it closed:
  
  ```ts
  // config/agent.ts and config/mcp.ts
  export default defineConfig({ emptyRoles: 'deny' })
  export default defineMcpConfig({ name, version, defaultRoles: [], emptyRoles: 'deny' })
  
  // or the policy itself
  new ClosedRolesPolicy(defaultRoles) // = new DefaultRolesPolicy(defaultRoles, { emptyRoles: 'deny' })
  new ClosedToolAuthorizer(defaultRoles) // = new DefaultToolAuthorizer(defaultRoles, { emptyRoles: 'deny' })
  ```
  
  Closed, the actor needs a role the tool declares (else one of `defaultRoles`): a tool with no `roles` and no default roles, or with an explicitly empty list, is neither offered nor invocable, and an actor with no roles reaches nothing.
  
  - `DefaultRolesPolicy` and `DefaultToolAuthorizer` take a second argument, `{ emptyRoles?: 'allow' | 'deny' }` (default `'allow'`); `ClosedRolesPolicy`, `ClosedToolAuthorizer` and the `EmptyRoles` / `RolesPolicyOptions` types are exported from the root entry.
  - `emptyRoles` on `defineConfig` and `defineMcpConfig`, passed to the default authorizer. It is ignored when you set your own `authorizer` / `rolesPolicy`.

- `defineConfirmedTool` — a write with a human gate that works over MCP: the first call validates everything, writes nothing and returns a preview plus a signed `confirmToken`; the same arguments with `confirm: true` and the token commit. Closes [#233](https://github.com/DavideCarvalho/adonis-agora-agent/issues/233).
  
  `createMcpServer` keeps `action` tools off the surface and Claude.ai / Claude Desktop have no elicitation, so every app exposing writes over MCP was rebuilding this gate inside a `read` tool. It is now one helper:
  
  ```ts
  import { defineConfirmedTool, LucidConfirmTokenStore } from '@adonis-agora/agent'
  
  export const refundOrder = defineConfirmedTool(
    { name: 'refund_order', description: '…', input: z.object({ orderId: z.string() }),
      secret: () => env.get('APP_KEY').release(), store: new LucidConfirmTokenStore(db) },
    {
      prepare: async ({ orderId }, ctx) => loadRefundableOrder(orderId, ctx.actor),
      preview: (order) => ({ summary: `Refund ${order.total}?`, data: order }),
   (order) => ({ summary: 'Refunded.', data: await refund(order) }),
    },
  )
  ```
  
  - The token is `<expiresAt>.<HMAC-SHA256>` over the tool, `ctx.actor.id`, `ctx.actor.tenantRef`, the expiry and the canonical arguments: stateless, and useless for another actor, tenant, tool or argument, or after `ttlMs` (default 15 minutes). `secret` is required — there is no default.
  - `confirm` / `confirmToken` are added around the app's own Standard Schema (`withConfirmFields`): validated by the helper, stripped before the app schema runs, and merged into the JSON Schema `tools/list` and the model see. `prepare` receives the arguments without them.
  - Results: `{ status: 'preview', summary, data, confirmToken, expiresAt, confirm }` and `{ status: 'done', summary, data }`. A refused confirmation throws `ConfirmTokenError` (`reason: 'invalid' | 'used'`) and writes nothing. `messages` overrides the English wording.
  - Single use through the new `ConfirmTokenStore` SPI (`claim` / `release` / `purgeExpired`): the token is claimed right before `commit` (a refusal in `prepare` does not spend it) and released if `commit` throws. `LucidConfirmTokenStore` keeps the marks — the token's SHA-256, the actor, the tool — in a new `agent_confirm_token` table and is safe across replicas; `InMemoryConfirmTokenStore` (also in `@adonis-agora/agent/testing`) is for tests and a single process. **Without a `store` a token is not single use.**
  - `createAgentTables` creates `agent_confirm_token` (`AGENT_TABLES.confirmTokens`). With `autoCreateTables: true` it appears as the app starts; with it off, add a migration that calls `createAgentTables` again.
  - `canonicalJson`, `signConfirmToken`, `verifyConfirmToken`, `confirmTokenExpiry` and `hashConfirmToken` are exported for a gate of your own.

- [#240](https://github.com/DavideCarvalho/adonis-agora-agent/pull/240) [`f071d8a`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/f071d8abe8f01c3eb135baba0cf39dd7707f2fa4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Several replicas without Redis: `tokenSinks.lucid()` keeps a run's stream in the app's SQL database, and `ask` / `intake` are now reachable from `config/agent.ts` ([#234](https://github.com/DavideCarvalho/adonis-agora-agent/issues/234)).
  
  A run parked on a person was already replica-safe under the durable runner (`durable: true` parks on a journaled signal, not a promise in one process). What a Redis-less deployment was missing is a stream every replica can read, and a way to turn the question surfaces on through the provider.
  
  ```ts
  export default defineConfig({
    // …
    durable: true,
    sink: tokenSinks.lucid(),
    defaultAgent: { ask: true },
  })
  ```
  
  - `LucidTokenStreamSink` / `tokenSinks.lucid({ connection, tableName, pollIntervalMs, idlePollIntervalMs, flushMs, ttlSeconds, autoPurge, autoCreateTables, db })` — frames are rows of `agent_stream_frame` (`run_id`, `seq`, `frame`, `created_at`), numbered per run with no gaps; subscribers poll (250 ms, 1 s once a run goes quiet) and replay from the first row, so a subscriber on another replica, a late one and one arriving after the end all see the same stream. Consecutive `text` frames written within `flushMs` (50 ms) are stored as one frame, so a streamed answer is a handful of inserts rather than one per token; SSE event ids are counted from the stored frames and an `after` cursor resumes exactly on any replica. Rows lapse `ttlSeconds` (1 h) after a run's last write: `purgeExpired()` deletes them, and a replica calls it on its own after a run ends (`autoPurge`). Slower to deliver than Redis and it writes to your database on every answer — keep `tokenSinks.redis()` when Redis is there.
  - `agent_stream_frame` is one of the nine tables of `createAgentTables()` / `AGENT_TABLES.streamFrames` (dropped by `dropAgentTables()`); the sink also creates it for itself at startup. `streamFrameTableStatement()` and `ensureStreamFrameTable()` are exported. With `autoCreateTables: false`, add a migration that calls `createAgentTables` again.
  - `AgentDefinition.ask` and `AgentDefinition.intake` (`defaultAgent`, `agents[]`) are threaded through `AgentDepsFactory.forAgent()` into the loop, for the inline and the durable runner alike. They were only settable on `AgentLoopDeps`, so an app using the provider could not offer the `ask` tool at all.
  - `SinkWriter.flush?()` — optional; `childSinkWriter`'s `end()` now calls it, so a delegated run's gathered text is written before its parent's next frame. Sinks that hold nothing back need no change.

## 0.52.1

### Patch Changes

- [#236](https://github.com/DavideCarvalho/adonis-agora-agent/pull/236) [`d87eb40`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/d87eb402a2dc7e294e0fd3cedb41add91e79c481) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A tool that starts a workflow no longer breaks the durable run it was called from.
  
  Under the durable runner a tool's `execute` runs inside the agent run's `tool:<callId>` step, and
  `@adonis-agora/durable` routes a `BaseWorkflow` static by the ambient workflow ctx. So a tool that
  called `SomeWorkflow.dispatch(...)` — directly, or through a service of the app's — had it turned
  into `ctx.startChild`, which wrote a `spawn:<id>` checkpoint into the AGENT run's journal from
  inside the step. A replay skips a completed step's body, so the next resume offered that position
  to `persist:toolexec:<callId>` and the runtime failed the run:
  
  ```
  non-determinism at <run>[#41](https://github.com/DavideCarvalho/adonis-agora-agent/issues/41): code expects "persist:toolexec:call_…" but history recorded
  "spawn:…". The workflow changed under an in-flight run — register a new workflow version.
  ```
  
  Nothing had changed under the run. It took a resume AFTER such a tool to get there — two actions
  awaiting approval in the same step (the run parks again between them), or an approval in any later
  step — which is why a turn with a single approval never showed it.
  
  Every checkpoint body of the agent workflow now runs outside the ambient workflow ctx. A workflow
  started from a tool, a processor, a store or a quota provider goes to the engine, as it does from a
  controller: it is a run of its own (no longer a child of the chat's run, so a failed or cancelled
  turn does not take it down), and the step's memoized result keeps a replay from starting it twice.
  
  A run that is ALREADY suspended with such a `spawn:` in its journal still fails on its next resume
  — the position is in its history. Settle it as failed and ask again.
  
  Also: `foldPart` (`@adonis-agora/agent/client`) closes the text of a model step with a paragraph
  break when the next step starts, so two steps no longer run into each other in one message
  ("…before answering.Let me compare…"). `STEP_SEPARATOR` is exported.

## 0.52.0

### Minor Changes

- [#231](https://github.com/DavideCarvalho/adonis-agora-agent/pull/231) [`a12108f`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/a12108fd597298e4f82bfe4905e01c46292a094e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `@adonis-agora/agent/react` is now the full React layer: `<AgentProvider>` + `useAgentChat()` with history, resume, the message queue, approvals, questions, attachments, threads, models and quota.
  
  It re-exports `@dudousxd/nestjs-agent-react` (a new optional peer — install it with `@ai-sdk/react` and `ai`) rather than carrying a second client: this package's routes speak the same wire contract as `@dudousxd/nestjs-agent`, so one React client serves both. What is added here is the AdonisJS connection — `AgentProvider` and `createAgentClient()` send the session cookie and `@adonisjs/shield`'s CSRF token (the `XSRF-TOKEN` cookie as `X-XSRF-TOKEN`, else `<meta name="csrf-token">` as `X-CSRF-TOKEN`), read per request. `@adonis-agora/agent/react/genui`, `/react/genui/json-render` and `/react/markdown` re-export the matching subpaths.
  
  ```tsx
  import { AgentProvider, useAgentChat } from '@adonis-agora/agent/react'
  
  <AgentProvider><Chat /></AgentProvider>
  
  const { transcript, composer, queue } = useAgentChat()
  ```
  
  **Breaking:** the previous minimal `useAgentChat` of this entry (`{ messages, status, error, send, cancel }` over `createAgentChatClient`) is gone — the name now resolves to the shared hook, whose shape is different (`sendMessage`, `transcript`, `composer`, `queue`, …). The framework-free stream client at `@adonis-agora/agent/client` is unchanged.
  
  Server pieces the React client calls, ported from `@dudousxd/nestjs-agent`:
  
  - `POST <path>/queue/:messageId/interrupt` — run a waiting message now (`chat.queue.interrupt(id)`): it moves to the head as an interrupt, any pause is lifted and the running turn is cancelled for it; with nothing running it starts at once. `QueuedMessagePatch.interrupt` on the `ChatQueueStore` SPI (Lucid and in-memory stores implement it; `CHAT_QUEUE_STORE_CONTRACT` has the case), `AgentService.interruptQueuedMessage`.
  - `POST <path>/chat { transient: true }` and `POST <path>/threads/:id/promote` — a scratch thread left out of the list until kept (`AgentStore.promoteThread`, optional; `501` without it).
  - `DELETE <path>/threads/:id/from/:messageId` — drop a message and everything after it (edit and resend).
  - `GET <path>/skills?threadId=` — the skills the caller can invoke, the same list the model is offered.

## 0.51.1

### Patch Changes

- [#229](https://github.com/DavideCarvalho/adonis-agora-agent/pull/229) [`6625647`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/66256474c19d27248ee0630451e21c7484dfd56a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The index probe that keeps provisioning lock-free on Postgres now looks in every schema on the `search_path` (`current_schemas(false)`), not only the first. With the agent tables in a later schema (`search_path = app, public`, tables in `public`), the probe found no indexes and re-issued every `CREATE INDEX IF NOT EXISTS` — the statement that waits for an open transaction.

## 0.51.0

### Minor Changes

- [#226](https://github.com/DavideCarvalho/adonis-agora-agent/pull/226) [`6e4731d`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/6e4731dc2b0919d330cfd916ecb4331f70c1ce05) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The agent tables are provisioned as the app starts, on a connection of their own — an app never needs a migration for them, and a test suite's global transaction no longer hangs on them.
  
  `autoCreateTables` (default `true`) used to run on the first agent call, inside whatever that caller had open. On Postgres `CREATE INDEX IF NOT EXISTS` takes the table lock before it checks for the index, and that lock waits for any open transaction that wrote to the table — so under a Japa global transaction (`testUtils.db().withGlobalTransaction()`) the "no-op" provisioning waited forever and the run hung. The way out was `autoCreateTables: false` plus a hand-written migration per upgrade.
  
  - **Runs at start.** The provider's new `start` hook calls `ensureSchema()` on the store, the pricing store and the governance read-model — before the HTTP server takes a request and before a test runner opens a transaction. Not for ace commands (`migration:run` must not find the tables already made; `list:routes` must not need a database): there, and for a store built by hand, first use still provisions. A failure at start is a warning; first use retries.
  - **Lock-free when current.** `createAgentTables` finds existing indexes in the catalog (`pg_indexes` / `sqlite_master`) instead of re-issuing them, so a schema that is up to date issues no DDL that locks a table.
  - **Outside a global transaction.** `ensureAgentTables` runs its DDL on a plain client (`schemaRunner(db)`, exported), not on the transaction `db.beginGlobalTransaction()` registered — the schema is not rolled back with the test, and a failed column probe cannot abort it. SQLite stays on the transaction's connection (one writer).
  - **Safe with several processes starting at once.** A `CREATE TABLE` / `ADD COLUMN` / `CREATE INDEX` that loses the race to another process is re-checked against the database and counted as done; any other failure still throws.
  - **`ensureSchema()`** on `LucidAgentStore`, `LucidPricingStore` and `LucidGovernanceQueries`. A custom store that exposes it is provisioned at start too.
  
  `autoCreateTables: false` with the published migration (`createAgentTables` / `dropAgentTables`) is unchanged, for teams that version the schema.
  
  **Upgrading.** If you turned `autoCreateTables` off only to avoid the hang, turn it back on and stop writing a migration per release. If your app still has a `create_agent_tables` migration with its own `this.schema.createTable(...)` (published before it delegated to the library), guard it or replace its body with `createAgentTables(...)`: a fresh test database is now provisioned before `testUtils.db().migrate()` runs, and an unguarded `createTable` throws on it.

## 0.50.0

### Minor Changes

- [#224](https://github.com/DavideCarvalho/adonis-agora-agent/pull/224) [`3ed6b2d`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ed6b2dbcdceef26ea7c262edec5cacffb5d6c05) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Message queue — sending while a turn is still running, ported from `@dudousxd/nestjs-agent` (its `docs/stream-protocol.md`, *Message queue*), so `chat.queue` in `@dudousxd/nestjs-agent-react` works against an Adonis server.
  
  - **A send on a busy thread is queued, not run concurrently (BREAKING behaviour).** `POST <path>/chat` on a thread whose turn is still running now answers `202 { queued: true, threadId, messageId, position, queue, runId?, interrupting? }` (JSON, no stream) and the message — stored server-side, per thread, FIFO — starts when that turn settles, under its own `messageId` as run id. `mode: 'auto' | 'queue' | 'interrupt'` (`interrupt: true` is the shorthand): `'queue'` always answers `202`, `'interrupt'` queues at the head and cancels the running turn. `regenerate` on a busy thread is `409 run_active`. Before, such a send started a second, concurrent turn on the same thread.
  - **Drain policy.** Completed → the head starts; failed → the queue pauses (`run_failed`); Stop → pauses (`cancelled`); an interrupt's cancel → its message starts; the head's actor over quota → pauses (`quota_exceeded`). The decision is the settling stream's last event before its terminal: `{ kind: 'queue', queue, started?: { messageId, runId } }`. Every queue change while a turn holds the thread is a `queue` event too.
  - **Routes.** `GET` / `DELETE <path>/threads/:id/queue`, `POST <path>/threads/:id/queue/resume`, `PATCH` / `DELETE <path>/queue/:messageId` (owner-scoped; `404` unknown, `403` another actor's, `410` already started or removed, `501` on a store without a queue). `GET <path>/threads/:id` carries `queue`.
  - **One turn per thread.** Admission is a compare-and-set on the thread's active run. New SPI `ChatQueueStore` (`enqueueMessage`, `listQueue`, …, `claimActiveStream`, `releaseActiveStream`, probed by `isChatQueueStore`), implemented by the Lucid store (new table `agent_queued_message`, new column `agent_thread.queue_pause` — both from `createAgentTables`; with `autoCreateTables: false`, add a migration that calls it again) and the in-memory store. `CHAT_QUEUE_STORE_CONTRACT` (`./testing`) checks a store of your own. A store without it keeps the old behaviour.
  - **`AgentService.send()`** queues; **`AgentService.chat()` stays start-or-refuse** and now throws `ChatQueueError` (`409 run_active`) on a busy thread. `ChatQueueService` (drain/kick/launch/publish) is exported; `getQueue`, `updateQueuedMessage`, `removeQueuedMessage`, `clearQueue`, `resumeQueue` on the service.
  - **Runners.** `AgentRunner.start(input, { runId? })` and optional `isRunActive(runId)`. Inline: drains before the stream ends; a cancelled loop now actually stops at its next safe point (new `AgentLoopHooks.cancelled`, `RunCancelledError`) instead of running on in the background, and a parked wait is unwound. Durable: the handoff is journaled (`queue:completed` / `queue:failed` behind `ctx.patched('agent:chat-queue')`, then `ctx.startChild` under the message id — a run in flight at upgrade replays the history it has); `cancel` now frees the thread, hands it to the queue and ends the stream with a `cancelled` frame; a thread turn stopped from outside no longer writes its late answer.
  - **Client.** `@adonis-agora/agent/client` `send` returns `{ queued }` for a `202` (`AgentChatQueued`), takes `mode`; `./react`'s hook follows a queued send that started at once.

## 0.49.0

### Minor Changes

- [#222](https://github.com/DavideCarvalho/adonis-agora-agent/pull/222) [`241bfdc`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/241bfdc298373052435890daa4513597e046377d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The chat contract `@dudousxd/nestjs-agent` settled (its `docs/stream-protocol.md`), ported:
  
  - **Refusals answer `{ message, code? }` (BREAKING for readers of `error`).** Every refused request on the agent routes (and the dashboard's asset route) answers its status with `{ message, code? }` instead of `{ error }` — `code` where there is a machine-readable reason (`unauthorized`, `model_not_allowed`, `thread_required`, `quota_exceeded`). `@adonis-agora/agent/client` now throws a refused send as `AgentChatHttpError` (`status`, `code`, `body`, and the server's `message` as its own message) instead of a bare `Error('Failed to start agent chat (HTTP n).')`.
  - **A send's `model` is that turn's only** — never stored on the thread; `PATCH threads/:id { model }` is the only pin (documented and tested; the service already behaved this way).
  - **Regenerate.** `POST chat { threadId, regenerate: true }` answers the thread's last user message again: `400 thread_required` without a thread, `message` ignored, no user message stored, the answer(s) after it dropped (a new `regenerate:truncate` durable step — normal turns journal exactly what they did), a new run. `AgentRunInput.regenerate` replaces the unused `isRegenerate`; `RegenerateNeedsThreadError` is exported.
  - **Model lock.** `ModelCatalogView.locked: { model, reason? }` runs every turn of that agent on `locked.model` and refuses a send naming another (`400 model_not_allowed`); `GET agents` entries carry `lockedModel` (`AgentCatalogEntry`). `listAgents(actor)` is now async.
  - **Quota soft limit and USD-only windows.** `QuotaWindow.usedTokens` is optional; `QuotaWindow.warnAt`, `QuotaReport.warning: { period, ratio, reason? }` (never while blocked), `quotaWarning(windows)`, `quotaUsedRatio(window)`; `quota: { limits, warnAt }` stamps it on the ledger windows (`LedgerQuotaProvider`'s new `options.warnAt`). `exhaustedWindow` reads a missing `usedTokens` as `0`.
  - **Who answered a question.** `POST tool-call/answer|skip` take `via?` (1–64 characters, `'web'` by default; `400` otherwise); the settled outcome carries `answeredBy` / `answeredVia` (`ElicitationReply.answeredVia`, `ElicitationOutcome.answeredBy|answeredVia`), streamed as the call's `tool-output` and persisted with its result.
  - **`GET tools?agent=*`** (`ALL_AGENTS`) answers the union across every agent, each tool once, under the same gates; an unknown name is still `404`.
  - **Frame ids.** `SseEvent.id` (the client parser now keeps the `id:` line). Ids stay strictly increasing within a run; readers must tolerate gaps.

## 0.48.0

### Minor Changes

- [#220](https://github.com/DavideCarvalho/adonis-agora-agent/pull/220) [`17ea478`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/17ea478a7531d15bf42b87335036ed04e319ccab) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **BREAKING — the agent stream protocol is the only wire.** `POST /agent/chat` and `GET /agent/chat/:runId/stream` always write the chat stream protocol shared with `@dudousxd/nestjs-agent`: `event: meta`, then one numbered `AgentStreamEvent` per `data:` frame (`{"kind":"text","text":…}`, `ui`, `elicitation`, `approval-requested`, reasoning, tool calls, steps, title, …), then `event: done` — or `event: error` `{ code, message }` for a failed run. `@dudousxd/nestjs-agent-react` and `@adonis-agora/agent/client` / `./react` read it unchanged.
  
  - **The `'legacy'` envelope is removed** — `data: {"delta":…}` text, the named `event: component` / `event: elicitation` / `event: approval` frames and the `[error]` text delta are no longer written, and `@adonis-agora/agent/client`'s `decodeFrame` no longer reads them (a `{"delta"}` payload decodes to `null`).
  - **The `streamProtocol` option is removed** from `defineConfig`, with no shim: delete `streamProtocol: 'agent'` from `config/agent.ts`; if you relied on the old `'legacy'` default, move the browser to `@adonis-agora/agent/client` (or `./react`, or `@dudousxd/nestjs-agent-react`) or read `{"kind":"text","text":…}` where you read `{"delta":…}`.
  - **`frameToSse` and the `StreamProtocol` type are no longer exported.** Use `AgentSseEncoder` (or the pure `frameToEvents`).
  
  `ChatFrame` / `ChatPart` / `foldPart` are unchanged, so code built on the package client needs no change beyond the server config.

## 0.47.0

### Minor Changes

- [#218](https://github.com/DavideCarvalho/adonis-agora-agent/pull/218) [`a27f79b`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/a27f79bc2f7a0d5dceb6b1ffa7b857ca467fab25) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Chat attachments by id, media-backed, bring-your-own storage — matching `@dudousxd/nestjs-agent`'s refs-only contract.
  
  - **One `attachments` option (BREAKING).** `attachments: attachmentStores.media()` stores uploads through `@adonis-agora/media` (an optional peer; any Drive disk — S3, GCS, R2, the filesystem): a media row per file in its own collection, owned by the actor, with signed short-lived urls by default (`visibility`, `urlExpiresInSeconds`, `resolveUrl`, `canAccess`, `maxBytes`, `allowedContentTypes`, `disk`, `collection`). `attachmentStores.memory({ maxBytes?, allowedContentTypes? })` for tests; or pass your own `AttachmentStagingStore`. Replaces `attachmentStaging`, `attachmentMaxBytes` and `attachmentAllowedContentTypes`; limits now come from the store's `describe()`. `@adonis-agora/agent/media` exports `MediaAttachmentStaging` to wire over a media setup of your own.
  - **Refs only (BREAKING).** `POST /agent/chat` takes `attachments: [{ mediaId }]` — anything else in an entry is `400`, at most 10 — and resolves each through the store for the calling actor (`403` for one it may not use, `501` when attachments are off). The url the model fetches is never taken from the request.
  - **`AttachmentStagingStore.resolve({ mediaId, actor })`** is now required (the store mints the url per request); `describe()` is optional. `GET /agent/threads/:id` re-mints each attachment's url by `mediaId`, so an old turn's signed link has not expired. `GET /agent/config` reports the store's limits.

- [#216](https://github.com/DavideCarvalho/adonis-agora-agent/pull/216) [`b032763`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/b03276346c6a7679b795a598da06f49c945a7f57) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - One way each, matching `@dudousxd/nestjs-agent`'s consolidation ([#230](https://github.com/DavideCarvalho/adonis-agora-agent/issues/230)):
  
  - **One `quota` option (BREAKING).** `quota: { limits: { day?: { tokens?, usd? }, month?: { tokens?, usd? } } }` or a `QuotaProvider`. The `quotas.*` factories (`ledger`, `memory`, `windows`), `LedgerQuotaStore` and `QuotaStore`-as-`quota` are removed; migrate `quota: quotas.ledger({ limitTokens: N })` to `quota: { limits: { day: { tokens: N } } }`. The check moved to the send (`429 quota_exceeded` before the turn starts). Drain in-flight durable runs started under the old option first — their journals hold the loop's quota checkpoints.
  - **`GET /agent/quota/today` removed** — read the day window of `GET /agent/quota`. The governance dashboard now does.
  - **`activeRunId` only.** Thread summaries and details carry `activeRunId` (the run streaming right now, `null` otherwise) instead of `ThreadDetail.activeStreamId`. The runners set it before a turn starts and clear it when it ends (`clearActiveStream`, optional on `AgentStore`, only clears a pointer still naming that run), so a reloading client resumes only a live run.
  - **`GET /agent/config`** — `{ attachments: { enabled, upload, maxBytes, allowedContentTypes, maxPerMessage }, models: { enabled }, quota: { enforced }, identity: { anonymous } }`, what the React `useAgentConfig` reads.

## 0.46.0

### Minor Changes

- [#215](https://github.com/DavideCarvalho/adonis-agora-agent/pull/215) [`1015903`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/1015903a40d9699a920de5dc85443986cfd9c8ab) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Zero-config by default, matching `@dudousxd/nestjs-agent`'s DX pass: `defineConfig({ model })` is a working public chat.
  
  - **Anonymous identity by default (BREAKING).** With no `actorResolver` the routes are public and each browser is its own anonymous actor (`AnonymousActorResolver`): the first response sets `agent_anon=<32 random bytes, base64url>; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax` (plus `Secure` over HTTPS) and the actor is `anon:` + a SHA-256 of it, so visitors never share threads, quota or attachments. A boot notice says the endpoints are public. One line requires login: `actorResolver: new AuthActorResolver()`. Before, an unset resolver answered `401` everywhere — set one explicitly if you relied on that.
  - **Tools open unless restricted (BREAKING).** `defaultRoles` defaults to `[]` — no restriction — and `DefaultRolesPolicy` / `DefaultToolAuthorizer` treat an empty list as open. `roles` on a tool still restricts it; `action` tools still wait for approval. `defaultRoles: ['ADMIN']` restores the old default. (The MCP server surface keeps its own `['ADMIN']` default.)
  - **`@AiTool` / `static tool` defaults.** `name` defaults to the class name camelCased minus a trailing `Tool` (`toolNameFromClass`), `kind` to `'read'`; `defineTool` still needs a `name`.
  - **`aiSdkModels({ id: model | { model, label, badges, … } }, { default, providerLabels })`** from `@adonis-agora/agent/ai-sdk`: several models behind one provider carrying its own catalog, served by `GET /agent/models` when `models` is not set. `aiSdkModel` now refuses a pick naming a model it does not serve. **`aiSdkModel`'s `resolveModel` option (added in 0.44.0) is removed** — use `aiSdkModels`.
  - The SSE routes now forward headers the request already set (the identity cookie, a session).

## 0.45.0

### Minor Changes

- [#212](https://github.com/DavideCarvalho/adonis-agora-agent/pull/212) [`bf09375`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/bf09375850a6faa3f8f91d6855e86c34fad3fbdb) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `ctx.emitUi(component, props, { id?, version? })` and terminal tools, matching `@dudousxd/nestjs-agent`. Every tool context now carries `emitUi` (always present; a no-op outside a conversation, e.g. over MCP — `createNoopEmitUi` is exported, also from `./testing`, for contexts a test builds by hand). A push streams at once (`ui` under the agent protocol, `event: component` under the legacy envelope), a repeat `id` replaces it, and every component a step's tools pushed is persisted on the assistant message once they settle (`StoredMessage.ui`; optional `AgentStore.setMessageUi`, implemented by the Lucid and in-memory stores). The pushes ride the tool step's journaled result, so a durable replay neither re-streams nor re-persists them. `ctx.emitComponent` keeps working through the same path. `terminal: true` on a tool ends the turn once a call to it succeeds. `AiToolCtx` gains `agentName`.
  
  **Breaking for hand-built contexts:** `AiToolCtx.emitUi` is required, so code that constructs an `AiToolCtx` literal (usually a test calling a handler directly) adds `emitUi: createNoopEmitUi()`.

- [#213](https://github.com/DavideCarvalho/adonis-agora-agent/pull/213) [`4757041`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/47570418418e8733400fd5ce9953bb39f3605014) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Generative UI from a component catalog, matching `@dudousxd/nestjs-agent`: `@adonis-agora/agent/genui` (and `/genui/builtins`) re-exports the isomorphic catalog of `@dudousxd/nestjs-agent-core/genui` — now an optional peer — so one catalog file serves this server, a NestJS one and the browser. `genui: genui({ catalog, mode?, showTool?, terminal?, resolver?, … })` in `config/agent.ts` registers the tools (`ui__show_<component>`, `ui__render` for a tree, the generic `ui__show`) that validate against the catalog and push through `ctx.emitUi`; the catalog is bound in the container as `AgentGenui`. A `resolver` (a `GenuiCatalogResolver` class built through the container, an instance, or a function) picks the catalog per request. `ToolHandler.describe(scope)` is new: any tool can vary its description and input schema per turn; `ToolRegistry.definitionsFor` takes the turn's `{ threadId, agentName }`, and `invoke` fills a no-op `emitUi` for a context without one.

## 0.44.0

### Minor Changes

- [#208](https://github.com/DavideCarvalho/adonis-agora-agent/pull/208) [`c945416`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/c9454165f33dc4989d9b0882ca940f5203e22e27) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Model catalog, per-thread and per-send model, matching `@dudousxd/nestjs-agent`: `models` in `config/agent.ts` (a literal `ModelCatalogView` or a `ModelCatalog` deciding per caller) is served by `GET /agent/models?agent=`; `POST /agent/chat { model }` runs a turn on a catalog model and `PATCH /agent/threads/:id { model }` pins one on a thread (`null` unpins) — anything the catalog does not offer as available is a `400`. The pick reaches the provider as `ModelTurnArgs.model` (`aiSdkModel` gains `resolveModel`, and passes the id through verbatim for a gateway string), rides the run's input so a durable replay makes the same choice, and labels usage when the provider reports no model id. `GET /agent/agents` lists the registered agents for a picker (`AgentDefinition.description` is new). `ThreadSummary.model`; Lucid adds a nullable `agent_thread.model` column; `AgentStore` gains optional `updateThread`.

- [#210](https://github.com/DavideCarvalho/adonis-agora-agent/pull/210) [`aedd216`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/aedd21614baea4b8f59511d159eda3116862459e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Quota v2, matching `@dudousxd/nestjs-agent`: `quota: quotas.windows({ day?: { tokens?, usd? }, month?: { tokens?, usd? } })` (or your own `QuotaProvider`) sets budget windows; `GET /agent/quota` reports `{ windows: [{ period, usedTokens, limitTokens?, usedUsd, limitUsd?, resetsAt }], blocked? }` and a send while a window is exhausted answers `429` `{ code: 'quota_exceeded', period, message }`. Without a budget the route still reports usage off the ledger and never gates; a daily `QuotaStore` keeps being enforced by the loop and lends the day window its ceiling. `AgentStore` gains optional `usageBetween` (Lucid, in-memory) for the month window and recorded spend.

## 0.43.0

### Minor Changes

- [#206](https://github.com/DavideCarvalho/adonis-agora-agent/pull/206) [`c276cc9`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/c276cc92fea786a82ae67280e623c434adcfd10f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Resumable streams, message feedback and thread rename, matching `@dudousxd/nestjs-agent`:
  
  - Under `streamProtocol: 'agent'` every event frame carries an SSE `id:` (its 1-based position in the run, the same on every attach). `GET /agent/chat/:runId/stream?after=<n>` — or `Last-Event-ID` — sends only the frames above `n`, and answers `404` when nothing is buffered under the run any more (new optional `TokenStreamSink.has`, implemented by the in-process, in-memory and Redis sinks), so the shared React client resumes a dropped stream instead of re-rendering it, and stops waiting on one nobody will write.
  - `POST /agent/messages/:id/feedback` `{ value: 'up' | 'down' | null, comment? }` rates a message (owner only; `StoredMessage.feedback`; not copied to forks). Lucid adds a nullable `agent_message.feedback` column; `AgentStore` gains optional `threadOfMessage` and `setMessageFeedback`.
  - `PATCH /agent/threads/:id` `{ title }` renames a thread.

## 0.42.0

### Minor Changes

- [#204](https://github.com/DavideCarvalho/adonis-agora-agent/pull/204) [`8567b5a`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/8567b5a17ea6eef947be4130db5efa30b679125d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Typed elicitation inputs, matching `@dudousxd/nestjs-agent`: a question can ask for a value with `input: { type: 'text' | 'textarea' | 'number' | 'boolean' | 'date' | 'email' | 'url' | 'select', placeholder?, required?, min?, max?, pattern? }` and a `description`; `options` is optional for a typed question and `defaults` only required when there is a sensible pre-pick. Answers stay `string[]` in one canonical form. `POST /agent/tool-call/answer` refuses a value a question's rules refuse, or a `required` question left empty, with `400` `answers["<id>"] <reason>` (via the new optional `AgentStore.toolCallInput`, implemented by the Lucid and in-memory stores); the loop drops the same values from whatever reaches it. `validateElicitationValue`, `validateElicitationAnswer`, `readElicitationQuestions` and friends are exported.

## 0.41.0

### Minor Changes

- [#202](https://github.com/DavideCarvalho/adonis-agora-agent/pull/202) [`5524b1e`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/5524b1e08a8df8efa6ec8f506088a36a0e0bae5b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Approvals v2, matching `@dudousxd/nestjs-agent`: an `approvalPolicy` in `config/agent.ts` decides who approves an `action` call and for how long — the shorthand `{ approver?, ttlMs?, tools: { <name>: { approver?, ttlMs?, required? } } }`, or a whole `ApprovalPolicy` (`requirementFor`, optional `canDecide`). Omitted, nothing changes: the requester approves, with no expiry.
  
  - A non-requester approver is enforced on `POST /agent/tool-call/approve|reject` (`403` for anyone `canDecide` refuses — by default, anyone without that role).
  - A `ttlMs` puts `expiresAt` on `approval-requested` and bounds the wait (an inline timer; the durable runner's signal-wait timeout). A lapsed request settles `expired` — `approval-settled { status: 'expired' }`, `tool-output-denied` with reason `approval expired`, a model narrative that says nobody approved in time — and a late decision answers `410`.
  - `remember: true` on an approval approves later calls of that tool in the thread (`decidedVia: 'remembered'`); `via` records the surface a decision came through (`'web'` by default).
  - `approval-settled` streams who decided, through what and why; `StoredMessage.approvals` returns it from `GET /agent/threads/:id`.
  
  The requirement is settled inside the call's `persist:toolcall` checkpoint, so no position moved and a parked durable run keeps the answer it got. The Lucid store adds nullable `agent_tool_call.approver`, `expires_at`, `remember`, `decided_via` (ALTERed in by `createAgentTables`); `AgentStore` gains optional `rememberedApprovals` and `toolCallApproval`. `Decision` gains `remember`, `decidedVia`, `expired`; `ToolCallStatus` gains `'expired'`.

## 0.40.0

### Minor Changes

- [#201](https://github.com/DavideCarvalho/adonis-agora-agent/pull/201) [`3e23238`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3e2323874f3bb0dbde25c31c3e466fc78fe662ba) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Tools can declare how a chat surface talks about them: `presentation` on `defineTool`, `@AiTool` and `static tool` (`label`, `running`/`done` templates over the call's input, `icon`, `tone`, `confirm` for the approval prompt, `result` for how the output reads) — the `ToolPresentation` shape of `@dudousxd/nestjs-agent`. It is never shown to the model. `GET <path>/tools?agent=` serves `{ name, kind, presentation? }[]` for the tools the caller can reach (the same list the model is offered, via the new `ToolRegistry.visibleSpecs`; `404` for an unknown agent), which `@dudousxd/nestjs-agent-react`'s `useToolCatalog` reads.

## 0.39.0

### Minor Changes

- [#198](https://github.com/DavideCarvalho/adonis-agora-agent/pull/198) [`8984e4e`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/8984e4e55969b13c1cfc11bb2e1f0658d6878e28) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Assistant messages now keep what their step streamed: `reasoning` (the model's thinking), `reasoningMs` (how long it thought) and `ui` (components the model turn pushed), on `StoredMessage`, `AppendMessageInput` and `ModelTurnResult`. The loop reads them off the frames inside the model call's own checkpoint (`observeTurnFrames` / `withTurnFrames`), so a durable replay persists the same values, and `step-finish` carries `reasoningMs` live — the same fields `@dudousxd/nestjs-agent` persists, so the shared React client replays a reloaded thread the way it streamed.
  
  The Lucid store adds three nullable `agent_message` columns (`reasoning`, `reasoning_ms`, `ui`), ALTERed in by `createAgentTables` on first use; with `autoCreateTables: false`, add a migration that calls `createAgentTables` again after upgrading. Forks copy them.

## 0.38.0

### Minor Changes

- [#197](https://github.com/DavideCarvalho/adonis-agora-agent/pull/197) [`e735c51`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/e735c51980fedcdad2d4ec05c068950fcf9674ac) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The chat routes can now stream the chat protocol shared with `@dudousxd/nestjs-agent`, so `@dudousxd/nestjs-agent-react` (transport, `useAgentChat`, transcript model) renders an Adonis run unchanged. Opt in with `streamProtocol: 'agent'` in `config/agent.ts`; the default stays `'legacy'`, so the `{"delta":…}` bytes an existing reader parses do not change.
  
  Under `'agent'` every frame is an `AgentStreamEvent`: `step-start`/`step-finish` (with `usage` and `costUsd`), `text`, `reasoning` (streamed by the AI SDK adapter), `tool-input-start`/`-delta`/`-available` (the loop announces a call itself when the provider streams none), `tool-output`/`tool-output-error`/`tool-output-denied`, `elicitation`, `approval-requested`, `ui` (for `ctx.emitComponent`, id `<toolCallId>:ui:<n>`), `title` and `cancelled`; a failed run ends with `event: error` `{ code, message }` (`quota_exceeded`, `output_rejected`, `structured_output_invalid`, `run_failed`). Every frame is written from inside a checkpoint the loop already had, so a durable replay never re-streams one and no checkpoint moved.
  
  `POST /agent/tool-call/approve|reject|answer|skip` accept a body naming the tool call alone (`{ toolCallId }`), reading the run off the call's row through the new optional `AgentStore.getToolCallRunId` (implemented by the Lucid and in-memory stores); an unknown call answers `404`. `@adonis-agora/agent/client` reads both envelopes and surfaces `event: error` as `AgentChatStreamError`. Runners now write a failure as a typed `{ t: 'error' }` frame, which the legacy envelope still spells as the `[error]` delta.

## 0.37.0

### Minor Changes

- [#194](https://github.com/DavideCarvalho/adonis-agora-agent/pull/194) [`b0e7284`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/b0e7284efa7a6d48f42038bd4a11f18fcc167ba9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - PageIndex-style tree navigation retrieval for long structured documents ("vectorless", reasoning-based: a table-of-contents tree per document, navigated by an LLM) — the port of the nestjs-agent feature. In a 149-question benchmark it beat hybrid dense+lexical search by +24 points on long GovCon regulations and +30 on FinanceBench 10-Ks, with no gain on short notes, so it is built to sit behind the existing search.
  
  - `buildDocumentTree` / `indexDocumentTree`: structure from the PDF outline, section titles or detected headings (markdown, `PART 52`, `Item 7.`, `52.236–5 …`; running headers and contents listings dropped) before any LLM; LLM structuring only for documents with no usable outline; page groups as the never-failing fallback. Hard per-document budget (calls, input/output tokens, timeout) checked before every call, no retries. Deterministic and fingerprinted: unchanged documents cost no LLM call, changed ones re-summarize only changed sections. `minUnits`/`minChars` threshold.
  - `DocumentTreeStore` SPI with `MemoryDocumentTreeStore` and `PgDocumentTreeStore` over the Lucid raw runner (filters with the vector stores' semantics), plus a published `create_agent_rag_trees` migration (`node ace configure` now publishes it; delete it if you don't use tree navigation).
  - `TreeNavigationRetriever` (single pass or bounded beam, auditable trail, `Retriever`), `TwoStageRetriever` (first stage picks documents, top long ones navigated), and `createNavigateDocumentTool` — the `navigate_document` tool as a `defineTool` functional tool.
  - `TreeLlm` adapters: `openAiChatTreeLlm`, `treeLlmFromModelProvider`, `cachedTreeLlm`, and the deterministic `keywordTreeLlm` for tests.
  
  Credits: PageIndex (Vectify AI, MIT) — see the package NOTICE.

### Patch Changes

- [#193](https://github.com/DavideCarvalho/adonis-agora-agent/pull/193) [`2893186`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/2893186bb289e94fb9c710b63b4c1c8bfb7173a1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `openAiEmbeddings`: a batch the server refuses as too large — HTTP 413, or TEI's `batch size 64 > maximum allowed batch size 32` (its `--max-client-batch-size` defaults to 32 while `batchSize` defaults to 64) — is split in halves and retried instead of failing the whole ingestion, and later requests to the same server and model start at the size that worked (remembered for the process). `embedWithUsage` sums the tokens of the accepted requests. Each split is reported through the new `onWarn` option. New export: `isBatchTooLarge(error)`.

## 0.36.0

### Minor Changes

- [#191](https://github.com/DavideCarvalho/adonis-agora-agent/pull/191) [`c70587d`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/c70587d52cb00235203539d5b4868d5055789788) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `PgLexicalVectorStore.searchText` (and `retrievers.pgvector({ fullText })`): natural-language questions are searched by their meaningful terms. The question's stop words are dropped (new `fullText.stopWords`, default `DEFAULT_STOP_WORDS`: English, Portuguese and Spanish, only the language(s) the question is written in; `false` keeps every word) and rows holding any remaining term are ranked by the sum of the matched terms' IDF among the matching rows (BM25 without term frequencies), `ts_rank_cd` breaking ties. Before, a question had to match every word and then fell back to any word including stop words, ranked by `ts_rank_cd`, so rows dense in "the/of/which" won: in a 149-question benchmark over 12k chunks this took the keyword-only evidence hit rate from 18% to 75% (hybrid 69% to 80%), and it is faster. Quoted phrases and `-word` still go through `websearch_to_tsquery` as written first; `anyTermFallback: false` keeps the old every-word-only behavior. New exports: `keywordTerms`, `hasSearchSyntax`, `anyTermTsquery`, `DEFAULT_STOP_WORDS`.

## 0.35.0

### Minor Changes

- [#186](https://github.com/DavideCarvalho/adonis-agora-agent/pull/186) [`e7d75e1`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/e7d75e1f1e931d5071de94d5f9d207eb83c76c42) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Guardrails, and processors you can actually configure
  
  - **`@adonis-agora/agent/guardrails`** — PII (Luhn-validated cards, CPF/CNPJ, SSN, IBAN, phones, emails, IPv4), secret (provider key formats, JWT, PEM, entropy-gated assignments), prompt-injection (EN / PT-BR / ES, hidden Unicode, encoded payloads) and tool-poisoning detectors; a rule engine with `allow`/`log`/`redact`/`approve`/`block`, fail modes and reversible redaction (`Vault`); and `createGuardrails(options)`, which runs it on the loop's processor seams — `guardrails.input` / `guardrails.output`, `wrapTool` for tool arguments, `screenTool` for tool definitions — with per-call rule resolution (per tenant) and an audit hook. A port of `@dudousxd/nestjs-agent-core/guardrails`.
  - **`inputProcessors` / `outputProcessors` in `config/agent.ts`.** The loop has taken processors since they were ported, but nothing between the config and the loop carried them, so an app using the provider could not register one. They now reach every agent's turn, inline and durable.
  - **`mcpServers[].screen`** — inspect each listed tool definition before it is imported, and skip the ones it refuses (a screen that throws skips the tool too).

- [#185](https://github.com/DavideCarvalho/adonis-agora-agent/pull/185) [`2f4fc8c`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/2f4fc8cf865e1b310280a40e2df91ed7f72caf93) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - First-party HTTP embedding and rerank adapters
  
  New `openAiEmbeddings` — an `EmbeddingProvider` over any OpenAI-compatible `/v1/embeddings` (OpenAI, gateways, TEI, Ollama, vLLM), with `embedWithUsage` so embedding spend reaches the ledger and quota — and `HttpReranker`, a `Reranker` over Cohere/Jina/Voyage/TEI-style `/rerank`. Both are dependency-free and throw `HttpModelError`. `@adonis-agora/agent/testing` adds `hashedEmbeddings(dimensions)`, a deterministic Unicode-aware hashed embedder.

- [#184](https://github.com/DavideCarvalho/adonis-agora-agent/pull/184) [`1b8cc02`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/1b8cc02fc447841e01bd58219e5c674413b46cc1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - pgvector: batched upserts, full-text hybrid search, mixed dimensions
  
  `PgVectorStore` now upserts in multi-row `INSERT … ON CONFLICT` statements (`upsertBatchSize`, default 100; duplicate ids in one call keep the last), and gains opt-in `nullableEmbeddings` (`embedding: []` → `NULL`), mixed-dimension tables (`dimension: [768, 1536]`, one partial HNSW index per width, searches compare like with like), and pgvector ≥ 0.8 `iterativeScan` / `efSearch` (`SET LOCAL` inside a Lucid transaction, skipped on older pgvector). New `PgLexicalVectorStore` (Postgres full-text `searchText`), `LexicalVectorStore` / `isLexicalVectorStore` and `LexicalRetriever`; `retrievers.pgvector({ fullText: {} })` returns a `HybridRetriever` of both legs. `HybridRetriever` gains `retrieveWithUsage`, so embedding spend from its legs still reaches the ledger. Everything is off by default.

## 0.34.1

### Patch Changes

- fix(deps): update dependency @modelcontextprotocol/sdk to v1.30.1 ([#180](https://github.com/DavideCarvalho/adonis-agora-agent/issues/180))

## 0.34.0

### Minor Changes

- [#160](https://github.com/DavideCarvalho/adonis-agora-agent/pull/160) [`7f43115`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/7f4311584268c37f88cb76aa2ebbfafb377735d2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The MCP server's auth works behind a proxy, sends clients to the login, and can take more than one kind of token
  
  Five things an app putting `/mcp` behind OAuth had to work around, now in the provider:
  
  - **Every refused request carries `WWW-Authenticate`.** The MCP Authorization spec has clients start the login from the `401` challenge, and the provider answered `401` without one. With OAuth metadata it is now `Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/<path>"`, with `error="invalid_token"` when a token was sent and refused; without OAuth — and on the fail-closed `401` of an endpoint with neither `auth` nor `actor` — it is a bare `Bearer`.
  - **`publicUrl` in `config/mcp.ts`.** The RFC 9728 `resource` (and now the challenge's `resource_metadata`) were built from the request's protocol and `Host`, so behind a TLS-terminating proxy the app does not trust they came out `http://`. `publicUrl: env.get('APP_URL')` names the public origin; omitted, the request is used as before. A value with a path, query, or fragment fails the boot. The metadata document also gains `bearer_methods_supported: ['header']` and `Access-Control-Allow-Origin: *`.
  - **`authKitAuth()` hands `toActor` the grant.** Besides `accountId`/`scopes`/`clientId`, the resolver now gets `grantId`, the `grant`, the `activeOrg` authkit bound to it at consent, and the token's `extra` claims — so a multi-tenant app resolves the tenant the user actually authorized. Existing resolvers keep working. The grant is loaded per request, and a token whose grant was revoked is refused (`401 authorization revoked`).
  - **`McpAuthError`, a typed refusal.** Throw it from `toActor` or `verify` to refuse a token you recognized — a client that must not reach MCP, a member who left the org. `new McpAuthError(msg)` is a `401` with `error="invalid_token"`, `{ status: 403 }` a `403` with `error="insufficient_scope"`. An expired authkit token is now one too.
  - **`anyOf(...strategies)`.** Accepts OAuth tokens and, say, personal access tokens on the same endpoint. Tried in order, first to verify wins; a plain `Error` passes to the next strategy, an `McpAuthError` stops the chain. OAuth metadata comes from the first strategy that exposes it.

## 0.33.1

### Patch Changes

- [#138](https://github.com/DavideCarvalho/adonis-agora-agent/pull/138) [`615b56f`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/615b56f5a2a09de2fa165448dbdb85a8890760a2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A memory provider written as a class keeps its receiver, so `remember` can actually write
  
  `writeMemory` read the method off the config and called it detached:
  
  ```ts
  const write = config.provider.write;
  …
  const record = await write({ … });
  ```
  
  A provider is normally a class — an Adonis service with its model or repository injected — and a detached method has lost its receiver, so the first `this.` inside it throws a `TypeError`. The loop reports that as a failed tool call, the model narrates the failure, and nothing is ever written down. Reads were unaffected: `list` and `forget` are called through the object.
  
  `offerMemories` detached `search` the same way, which breaks the same host on the RECALL path — and that one runs on every turn, so it breaks before anything is ever written. Both are bound now.
  
  Every provider in this repo's own tests is an object literal of arrow functions, which needs no receiver — which is exactly why it went unseen. The regression test is a provider written the way a host writes one, with both `search` and `write` reading its storage off `this`.

- [#139](https://github.com/DavideCarvalho/adonis-agora-agent/pull/139) [`6a6ff1f`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/6a6ff1f0369ced0eddca3940c2f1ad73081c75da) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A declined action reads as a decision, not as a malfunction
  
  When a person declines an action tool, the loop handed the model a tool result whose error text was the single word `rejected`. That names no actor and is indistinguishable from a tool that threw, so the answer that followed diagnosed the refusal — "the key may not exist", "there may be permission restrictions" — and offered to retry the same action, asking the person to say no twice.
  
  - `ToolResult` gains `denied?: true`. It is set instead of a failure and read by everything that has to tell the two apart; `error` still carries what the model is told, because that is the channel a model reads an outcome on.
  - That text now says who decided, that nothing ran, and what not to do next: not an error, no guessing at causes, no retry and no reaching for another way to do the same thing. A reason given when declining is included.
  
  Ported from the NestJS sibling, where the bad narration was seen in production.

- [#144](https://github.com/DavideCarvalho/adonis-agora-agent/pull/144) [`f22bd40`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/f22bd4094b95705ed285fa9b84f9b17df9cf59e4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `PgVectorStore` strips the NUL byte (0x00) before it reaches Postgres, on writes and on reads
  
  Postgres rejects the NUL byte in `text`/`jsonb` values outright (`invalid byte sequence for encoding "UTF8": 0x00`), but text extracted from PDFs sometimes carries one and upstream sources like Qdrant accept it fine — so a chunk that ingested cleanly elsewhere could fail `upsert` here with no way to write it. `upsert` (id, text, source, metadata — including nested metadata values, array items, and object keys) and `updateMetadata` (the patch, values and keys, plus the `documentId` lookup) now run every string through a new exported `stripNulBytes` helper first, so a stray NUL byte is dropped and the rest of the text is written unchanged. The same stripping now also applies on read: `remove`'s `documentId`, and the metadata filter (`search`, `listDocuments`, `listDocumentIds`, `removeWhere`) — keeping every lookup consistent with the already-stripped stored data.
  
  `stripNulBytes` also fixes two edge cases in how it walks a value: only plain objects are recursed into (checked via `Object.getPrototypeOf`), so a `Date`, class instance, `Buffer`, etc. inside metadata passes through unchanged instead of being flattened into `{}`; and the result is built with `Object.fromEntries` rather than assignment onto a fresh `{}`, so a metadata key literally named `__proto__` round-trips as a real own property instead of silently hitting the inherited prototype accessor and being dropped. The same `__proto__` drop was still reachable through two downstream accumulators that built their own object with plain assignment — `buildMetadataWhere`'s scalar filter object and `updateMetadata`'s merge-patch object — both now accumulate `[key, value]` pairs and build with `Object.fromEntries` too, so a `__proto__`-named filter or patch key survives all the way to the binding.

- [#140](https://github.com/DavideCarvalho/adonis-agora-agent/pull/140) [`53016f7`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/53016f7505598e4685209ae526a402e770a3f54e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A tool call's kind travels with the call, so the approval gate does not depend on which process replays the turn
  
  `claimToolCall` settles a call's kind inside `persist:toolcall` and journals it from there, which makes every replay agree. It does not make the first writer right: a resumed run is handed to whichever instance takes the lease, and an instance that never declared the tool reads `undefined` from its own registry, journals `read` for an action tool, and executes it with nobody's approval.
  
  The kind is now stamped where the tool was OFFERED — inside the `llm:<i>` checkpoint, by the process that built the definition list the model chose from — and `claimToolCall` writes that value rather than asking its own registry. A call that arrives unstamped still falls back to the local lookup, so a journal written before kinds travelled replays unchanged.
  
  No checkpoint name, position or count changes.

## 0.33.0

### Minor Changes

- [#129](https://github.com/DavideCarvalho/adonis-agora-agent/pull/129) [`0de5ab8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/0de5ab8f98095c8281147efdbf92c996e8a5a603) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `@adonis-agora/agent/mcp-client` — tools de um servidor MCP que você não controla.
  
  A direção contrária ao servidor MCP que este pacote já tinha: em vez de expor as tools DESTE
  deployment para um cliente externo, importa as tools de um servidor MCP externo para o
  `ToolRegistry` deste deployment. Elas entram no MESMO registry que a descoberta de `@aiTool`
  alimenta, então passam por todos os gates que uma tool escrita à mão passa — a `RolesPolicy`, o
  allow-list de persona/agente, e a validação de input.
  
  ```ts
  // config/agent.ts
  mcpServers: [{ name: 'github', transport: { type: 'stdio', command: 'mcp-github' } }]
  ```
  
  **Uma tool importada é `action` por padrão**, ou seja, com HITL: ela foi escrita fora deste código e
  os efeitos dela não são visíveis daqui. Alargar isso é uma decisão que o host toma em voz alta —
  `kind: 'read'` (só para um servidor que você audita), `kind: 'trust-annotations'` (acreditar no
  `readOnlyHint`, que é afirmado justamente por quem tem os efeitos que ele descreve, então é uma
  declaração de confiança e não uma verificação — e uma tool que declara `readOnlyHint` E
  `destructiveHint` está se descrevendo de forma incoerente e continua travada), ou um predicado por
  tool.
  
  **Um nome pertence a quem o reivindicou primeiro.** O registry é indexado por nome e nada mais, então
  uma importação sem namespace deixaria o `search` de um servidor remoto substituir o `search` do
  próprio app — uma troca invisível de todo lugar, porque o modelo continua chamando `search` e o
  `search` agora chega no servidor de outra pessoa. Os nomes importados são prefixados com o nome do
  servidor por padrão, e um segundo reivindicante é RECUSADO com um aviso nomeando os dois. Vale entre
  servidores também, e a resposta é estável: a listagem roda em paralelo porque os servidores são
  independentes, mas o registro reexecuta na ORDEM DE CONFIGURAÇÃO, então um nome disputado vai para o
  servidor configurado primeiro por mais rápido que o outro responda.
  
  **Duas coisas que um schema remoto pode fazer com este processo**, as duas terminando com a tool
  DESCARTADA em vez de importada com um schema permissivo — a alternativa deixaria o modelo mandar
  argumentos arbitrários para a tool remota com a aparência de uma chamada validada. Um schema que não
  compila. E um `pattern` que backtracka exponencialmente: todo validador do SDK do MCP compila
  `pattern` para um `RegExp` nativo, e `(a+)+$` contra 27 `a`s e um final que não casa leva ~1s, 30
  ~8s, 40 mais do que qualquer um vai esperar — de forma síncrona, na única thread que o processo tem.
  O pattern é escrito pelo servidor remoto e a string é escrita pelo modelo, cuja indução a descrição
  da mesma tool pode fornecer, então a coisa toda cabe dentro de uma definição de tool.
  
  **A conexão não é estado durável.** Um servidor remoto pode reiniciar, ser redeployado ou cortar uma
  conexão ociosa, e o primeiro sintoma é uma tool call que falha. Então uma chamada que falha de forma
  transiente descarta o client, e o retry reconecta na próxima tentativa. O retry é o
  `invokeWithTransientRetry` que o loop já usa, no lugar e não como novo checkpoint. Uma tool que
  respondeu `isError` falhou por mérito próprio e NUNCA é retentada: a mensagem dela é texto que o
  servidor remoto escreveu, e casar isso contra marcadores de transiência deixaria a prosa de uma tool
  decidir se este lado retenta.
  
  Um servidor fora do ar custa as tools dele e nada mais — o modelo simplesmente nunca é oferecido a
  elas — a menos que ele declare `required: true`. E `refresh(name)` é o caminho de volta para um
  servidor que estava fora no boot.
  
  Duas coisas do porte de referência ficaram de fora porque o SPI de tools daqui não tem as costuras:
  `ToolSpec.enabled` (um servidor dizer se as tools dele existem neste deployment) e
  `ToolHandler.canUse` (um gate por ator). As duas são capacidades do SPI de tools, não do cliente MCP.

- [#129](https://github.com/DavideCarvalho/adonis-agora-agent/pull/129) [`0de5ab8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/0de5ab8f98095c8281147efdbf92c996e8a5a603) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Um ciclo de delegação é detectado como ciclo — e nada antes disso parava um handoff mútuo.
  
  `delegatesTo` é um grafo, e o modelo não o vê. Num handoff mútuo (alpha entrega pra beta, beta entrega
  de volta pra alpha) cada agente faz uma chamada razoável e a recursão é da fiação. O
  `delegationDepth` que o runner durável já carregava tinha um comentário dizendo "carregado para um
  guard futuro" — ou seja, **não existia guard algum**: o runner inline nem contava, e a única coisa que
  terminava uma cadeia cíclica era o `maxSteps` de cada turno somado ao acaso.
  
  Entra `AgentRunInput.delegationPath`, a cadeia de nomes de agente que chegou até este run, com os DOIS
  runners acrescentando o próprio agente para cada filho que começam. O loop compara o alvo da
  delegação contra essa cadeia mais o próprio agente: uma repetição É o ciclo, nomeada na recusa com
  quantas vezes aquele agente já esteve nela.
  
  ```
  delegation cycle: alpha → beta → alpha — alpha 2 times on one chain
  ```
  
  `maxAgentAppearances` (padrão 1) conta APARIÇÕES, então 2 admite exatamente um retorno deliberado — o
  que um supervisor que de fato devolve trabalho precisa. `maxDelegationDepth` (padrão 5) entra como
  backstop para uma cadeia que é longa sem repetir, e é reportado só quando nada é circular. Os dois são
  declarados por agente, ao lado do `maxSteps`.
  
  **Por que não bastava contar.** Uma contagem só sabe dizer que a cadeia é LONGA. Ela não sabe dizer
  que está andando em círculo, e confundir as duas coisas errava os dois casos: um handoff mútuo
  queimava o teto inteiro em turnos de agente antes de reportar uma profundidade que o leitor ainda
  tinha que interpretar, e uma cadeia legítima de seis agentes DISTINTOS era recusada por parecer um
  ciclo que não era. A cadeia de nomes custa exatamente o que o contador custava para carregar.
  
  A recusa é resolvida dentro do mesmo checkpoint que assenta o kind da call (`persist:toolcall:<id>`),
  então o veredito é o que um replay relê — e não algo que cada processo re-deriva a partir de config
  local.
  
  Uma diferença deliberada em relação ao porte de referência: a ancestralidade inclui o agente do
  PRÓPRIO run. Sem isso, um handoff mútuo de verdade é recusado com `alpha → alpha`, uma aresta que
  nenhum deployment declara, porque o salto que fechou o círculo fica de fora da mensagem. Com isso,
  uma auto-delegação também passa a ser ciclo na hora, em vez de um salto depois.

- [#129](https://github.com/DavideCarvalho/adonis-agora-agent/pull/129) [`0de5ab8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/0de5ab8f98095c8281147efdbf92c996e8a5a603) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Um run filho grava qual run o delegou.
  
  A aresta pai→filho de uma delegação existia no journal do runtime durável e em nenhum outro lugar.
  Toda superfície de confiabilidade e de custo — e todas elas leem LINHAS de run — via o gasto de uma
  delegação como um turno órfão: ninguém conseguia somar o que um turno custou de verdade, porque a
  parte que ele pediu a outro agente aparecia como um run que ninguém começou. E o journal durável não
  é joinable com a tabela de runs, então não havia como recompor a árvore depois.
  
  Entra `RecordRunStartInput.parentRunId` e `AgentRunInput.parentRunId`, preenchido pelos DOIS runners
  (o inline em `runNested`, o durável no `ctx.child`), persistido como `agent_run.parent_run_id` pelo
  `LucidAgentStore` e pelo store em memória, e devolvido como `RunSummaryRow.parentRunId` —
  `null` para um turno que uma pessoa começou.
  
  `createAgentTables` repara a coluna aditivamente num banco que já tem `agent_run`: um
  `CREATE TABLE IF NOT EXISTS` não alcança coluna nova em tabela que já existe, e o `ALTER` entra pelo
  mesmo caminho que já conserta as colunas `run_id`, com o reparo reportado por nome.
  
  O teste que pega a classe de bug que isto é: a fixture é tipada `Required<RecordRunStartInput>`, então
  um campo novo no input FALHA A COMPILAR até que a linha de cada adapter saiba nomeá-lo. E o
  threading — a metade que pode estar morta sem falhar nada, porque um store com a coluna e um runner
  que nunca a preenche é indistinguível de um deployment em que ninguém delega — é coberto por uma
  delegação de verdade pelo `InlineAgentRunner`, perguntando ao read-model qual turno pagou pelo filho.

- [#129](https://github.com/DavideCarvalho/adonis-agora-agent/pull/129) [`0de5ab8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/0de5ab8f98095c8281147efdbf92c996e8a5a603) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Um turno lê a JANELA que ele vai mandar, não a transcrição da thread.
  
  Um turno precisa das últimas mensagens, do título, e de saber se a thread já foi respondida alguma
  vez. O `getThread` entregava a transcrição inteira — toda linha de mensagem, todo anexo e toda saída
  de tool que a thread já gravou — e o `load:thread` então journalava o que carregou. Numa thread de 50
  turnos em que cada turno rodou uma tool de 50 KB isso é ~2,6 MB lidos e gravados para mandar quatro
  mensagens, 99% deles saída de tool que nenhuma chamada ao modelo ia ver. E o preço é pago de novo em
  todo replay, porque o payload do checkpoint é relido e reparseado por todo processo que retoma o run.
  
  Entra `ThreadTurnReader.loadThreadForTurn({ threadId, messageLimit })` no SPI, implementado pelo
  `LucidAgentStore`: as `messageLimit` linhas mais novas, com o limite sendo o do BANCO
  (`order by created_at desc limit ?`), projetadas nas colunas que um turno de modelo lê — `usage`,
  `follow_ups` e `run_id` ficam na tabela.
  
  **O probe é estrutural**, então um store que não oferece a janela continua respondendo pelo
  `getThread`, com o mesmo limite aplicado em processo. E ele mora DENTRO do `load:thread`, não em
  volta: não acrescenta posição nenhuma, e o payload gravado é idêntico nos dois caminhos — a escolha
  de store de um deployment não pode decidir os checkpoints de um run. Nenhum marcador de patch,
  nenhuma posição mexida.
  
  **Dois tetos de propósito não nomeiam limite.** Um que RESUME, porque o `summarize` recebe o que o
  `select` DESCARTOU: uma leitura limitada ao que o `select` guarda não descarta nada, e o turno
  dobraria um resumo vazio dentro de um prompt que está sem as mensagens que ele substitui — calado.
  E um teto que não é contagem de linhas, porque de um orçamento de tokens não sai contagem alguma: uma
  mensagem pode custar quatro tokens ou quarenta mil. `HistoryWindow.maxMessages` é o campo que declara
  o limite, e declarar é uma PROMESSA sobre o `select` — que ele guarda no máximo essa quantidade, e que
  são as mais NOVAS.
  
  **`hasAssistantMessage` é respondido sobre a thread INTEIRA, nunca sobre a página.** Ele decide um
  intake `thread-start`, e uma janela que por acaso só tem as últimas perguntas do usuário pertence a
  uma conversa que já foi respondida — lido da página, um thread longo se reapresentaria a cada turno.

- [#129](https://github.com/DavideCarvalho/adonis-agora-agent/pull/129) [`0de5ab8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/0de5ab8f98095c8281147efdbf92c996e8a5a603) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Uma aprovação humana vale UM efeito, e uma rejeição registrada foi alguém que a fez.
  
  Quatro defeitos no mesmo eixo: o que a biblioteca grava como decisão de uma pessoa, e quantas vezes
  um efeito remoto acontece por causa dela. Os dois primeiros **fabricam ou duplicam** uma decisão
  humana, que é a classe de falha que nada na frente denuncia.
  
  ## Um retry não re-emite uma ação aprovada
  
  `McpToolSource.callTool` envolvia TODA chamada em `invokeWithTransientRetry`. Um timeout, uma conexão
  derrubada, um reset no meio do voo, um 500/502/503 — cada um deles é também exatamente como um tool
  remoto que **rodou** aparece quando a resposta se perde. Re-emitir em cima disso gasta uma única
  aprovação humana em dois efeitos remotos, e nada deste lado fica sabendo: os efeitos de um tool
  importado acontecem na máquina de outra pessoa, que é justamente o motivo de ele ser `action` por
  padrão.
  
  Agora o classificador depende do `kind`:
  
  | `kind` | Tenta de novo em |
  | --- | --- |
  | `read` | `isTransientMcpError` — conexão derrubada, timeout, status HTTP retentável, erro de socket |
  | `action` | `isPreExecutionMcpError` — só falhas que **provam** que nada rodou: conexão recusada, host nunca resolvido ou alcançado, ou nenhum transporte para enviar |
  
  Passar o próprio `classify` assume esse juízo para todo `kind`, `action` incluído. `isPreExecutionMcpError`
  é exportado de `@adonis-agora/agent/mcp-client`.
  
  ## Respostas não se tornam uma rejeição
  
  Um conjunto de perguntas estaciona como uma call `action` em `pending_approval` — é o que o põe na
  caixa de aprovações que o deployment já tem. O custo é que um canal carrega duas formas, então um
  cliente consegue endereçar `POST /agent/tool-call/answer` a uma call que na verdade espera um
  approve/reject. `ElicitationReply` não carrega `approved`, e `!undefined` é `true`: a linha virava
  `rejected`, uma decisão que o operador nunca tomou e que nada depois distingue de uma que ele tomou.
  
  A redução vale em UM sentido só. Um sim/não pode ser lido como "confirmou as respostas pré-marcadas";
  um conjunto de respostas não diz nada sobre se o trabalho proposto deve seguir. Então é **recusado**,
  nunca registrado:
  
  - o runner inline sabe em qual espera o run está parado e responde `409` (`HumanReplyMismatchError`);
  - sob o runner durável um sinal não carrega essa pista, então o loop descarta a resposta e o run
    continua parado na aprovação que sempre esperou. Esperar de novo gasta outra posição, e um replay
    se alinha porque a resposta descartada está ela mesma no journal na posição em que chegou.
  
  De qualquer um dos lados a linha segue `pending_approval`, e a aprovação de verdade ainda a assenta.
  
  ## Um run delegado pode ser respondido
  
  Um sub-agente estaciona numa espera real — `tool:<childRunId>:<callId>` — e a linha pendente que ele
  escreve carrega esse runId, então a caixa de aprovações sempre soube respondê-la. O que faltava não
  era o caminho de volta: era o **id**. Quem olha assiste ao stream de TOPO, porque é o único stream a
  que alguém assina; o filho encaminha os frames pra lá (é para isso que `sinkRunId` existe), e um
  formulário sem run id é um formulário que quem olha vê e não consegue responder.
  
  Então o id passa a viajar NO frame. Os dois frames de trabalho estacionado o carregam:
  
  | Evento SSE | Payload | Responde com |
  | --- | --- | --- |
  | `event: approval` | `{runId, id, toolName, input}` | `POST /agent/tool-call/approve` \| `/reject` |
  | `event: elicitation` | `{runId, id, request}` | `POST /agent/tool-call/answer` \| `/skip` |
  
  `event: approval` é novo: uma `action` estacionada não tinha frame nenhum, só a linha
  `pending_approval`. É escrito de DENTRO do checkpoint `persist:toolcall:<callId>`, então não gasta
  posição própria e um replay — que devolve aquele checkpoint memoizado — nunca re-posta um formulário
  para uma decisão já tomada. E `runId` é o run ESTACIONADO, não o stream em que o frame chegou: ler o
  run do frame `meta` sinalizaria o ancestral e deixaria o filho suspenso. `decodeFrame` no cliente
  aprendeu os dois eventos — antes ele descartava `elicitation` inteiro — e descarta um frame sem
  `runId` em vez de entregar um que não dá para acionar.
  
  O runner inline passa a espelhar isso: o loop aninhado escreve no sink do ancestral via
  `childSinkWriter` e estaciona em `${childRunId}:${toolCallId}`, em vez de auto-declinar. Um
  comportamento, nos dois runners — e um sub-agente cujas aprovações ninguém vai responder **fica
  pendurado**, exatamente como um agente de topo. Se um job delega, mantenha tools de aprovação fora do
  sub-agente (`tools:` na definição dele).
  
  Os docs afirmavam o auto-declínio em três lugares (`docs/programmatic-api.mdx`,
  `docs/concepts/agent-loop.mdx`, `docs/authoring/personas-and-agents.mdx`) — era essa afirmação que
  estava errada, não o comportamento do durável. Nenhum marcador `patched` é gasto: a forma do journal
  do filho não muda.
  
  ## Um refresh de MCP remove, não só acrescenta
  
  `McpToolImporter.refresh` só somava. Um servidor que remove ou renomeia um tool deixava o spec e o
  handler antigos registrados, e o modelo seguia recebendo a oferta de um tool cuja próxima chamada
  falha remotamente — segundos depois, na máquina de outra pessoa.
  
  `refresh()` passa a ser a resposta ATUAL do servidor a `tools/list`: o que desapareceu é desregistrado
  via o novo `ToolRegistry.unregister(name)`, então chamar aquilo é um `ToolNotFoundError` aqui. Só
  nomes que este importer registrou para AQUELE servidor entram — nunca os do app, nunca de outro
  servidor — e um nome liberado é reivindicável pelo próximo servidor em ordem de configuração no mesmo
  refresh. Um servidor que não pôde ser **alcançado** não poda nada: seus tools são desconhecidos, não
  desaparecidos, e uma oscilação de rede não é motivo para retirar do modelo um tool que funciona.
  
  `refresh(name)` para um nome que nenhum servidor aberto casa avisa e retorna `0`, em vez de deixar um
  `0` que se lê igual a um servidor que respondeu sem tools.

### Patch Changes

- [`0af6194`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/0af6194cd4f0d53652938fa0d408f59b212eff5e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - O docblock de `AgentRunner` descreve a fiação deste pacote, não a da referência Nest.
  
  Três nomes que não existem aqui: `AGENT_RUNNER`, que não é chave de binding nenhuma — o
  `agent_provider` constrói o runner direto e registra só o `AgentService`; `@dudousxd/nestjs-durable`,
  sendo que o peer durável deste pacote é `@adonis-agora/durable`; e o decorator `@Workflow`, que esta
  porta não tem — o turno durável é `class AgentRunWorkflow extends BaseWorkflow`, registrada por
  `registerWorkflowClass`.

## 0.32.0

### Minor Changes

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `@adonis-agora/agent/evals` — nota de qualidade sobre os runs que já estão gravados.
  
  A biblioteca já sabia dizer quanto um turno custou e se ele terminou; não sabia dizer se ele prestou.
  Entra um SPI `Scorer` (um run gravado entra, um `0..1` mais a frase que o justifica sai), um runner em
  lote retomável, um `ScoreStore` para os vereditos, e os agregadores puros (`summarizeByScorer` /
  `summarizeByAgent` / `bucketScoreTrend` / `worstScoredRuns`) que espelham a aritmética do read-model de
  governança — assim um painel e um gate de CI nunca discordam sobre se a qualidade mexeu.
  
  **Offline por construção.** A leitura é do que o agente já persistiu — a linha do run, a transcrição, as
  tool calls e os desfechos — através do `AgentGovernanceQueries` e de mais nada, então funciona igual nos
  stores Lucid e em memória e **não acrescenta nenhuma tabela de leitura**. Nada roda dentro de um turno:
  um juiz inline dobraria a latência e a conta de toda mensagem que um usuário manda. `runEvaluation` pula
  um par `(run, scorer)` que o store já cobriu, então um backfill interrompido e reiniciado com a mesma
  query não cobra nada de novo.
  
  **Quatro scorers embutidos, um por coisa que esta biblioteca de fato sabe:**
  
  - `RunCompletionScorer` (`rule`) — o turno entregou? Um run que assenta `completed` sem ter respondido
    nada tira 0, que é exatamente o que a taxa de sucesso da governança chama de sucesso; uma resposta
    escrita com uma tool falhando tira 0,5; um run `cancelled` tira 0 com o motivo dizendo isso.
  - `ApprovalOutcomeScorer` (`rule`) — **toda rejeição de HITL é um rótulo negativo de qualidade que um
    humano produziu de graça.** A biblioteca já para uma tool `action` e pergunta a uma pessoa se aquilo
    deve rodar; essa resposta fica gravada na tool call e é a única verdade de referência do sistema que
    ninguém precisou pagar para coletar. A nota é a fração das actions DECIDIDAS do run que um humano
    aprovou. Uma action aprovada que depois explodiu conta como aprovada — a pessoa disse sim.
  - `ApprovalRiskScorer` (`statistical`) — o mesmo corpus virado previsão: taxa de aprovação por tool
    suavizada por um Beta(1,1), então uma tool inédita fica exatamente em 0,5 e um 1-de-1 rejeitado nunca
    lê como certeza. O run vale pela action MAIS arriscada que propôs, não pela média, para que uma caixa
    de aprovações seja drenada da pior para a melhor.
  - `AnswerRelevancyScorer` (`model`) — LLM como juiz sobre qualquer `ModelProvider`, com `discardingSink()`
    e `parseJudgeVerdict()` exportados para escrever o seu.
  
  Um scorer devolve `null` — e não `1` — para um run sobre o qual não tem o que dizer. A maioria dos runs é
  só leitura e não carrega veredito humano nenhum; contar esses como perfeitos enterraria os que carregam
  sob uma média de ~1. Um scorer que LANÇA é coletado como falha daquele run e o lote segue: um juiz que
  respondeu em prosa é uma avaliação quebrada, e gravar isso como 0 poria a culpa no agente.
  
  **Duas coisas ficaram diferentes do porte de referência, e as duas por causa deste read-model.** O
  `runDetail` daqui já devolve as mensagens carimbadas com o `run_id` do próprio run, então
  `GovernanceRunSampleSource` lê pergunta e resposta direto dele — sem juntar a transcrição da thread, sem
  heurística de janela de tempo, e sem depender do `AgentStore`. E como não existe um feed de tool calls
  paginado por tipo, o prior de aprovação vem de `priorFromRuns` (dobra as actions dos runs que o lote já
  carregou, custo zero de leitura) ou de `loadApprovalPrior` sobre o feed de atividade recente, limitado
  por `limit`.
  
  **Scoring ao vivo é opt-in e não consegue derrubar um turno.** `attachLiveScoring` assina
  `agora:agent:run.finished` e pontua DEPOIS que o run assentou e o stream dele fechou, numa promise
  destacada, com assinante protegido e toda falha roteada para `onError`. Não existe caminho de código de
  um scorer de volta para dentro de um turno. Ainda custa trabalho de verdade por run, então o lote segue
  sendo o default e `sampleRate` alivia a carga de qualquer coisa que cobre.

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `HistoryWindow` ganha orçamento de tokens e um caminho de sumarização embutido.
  
  `SlidingWindowHistory` só sabia contar mensagens, e resumir era explicitamente problema do consumidor.
  Agora ela aceita `maxMessages`, `maxTokens` ou os dois (vence quem corta mais), com `estimate` para
  trocar a heurística de ~4 caracteres por token por um tokenizer de verdade, e `summarize` para dobrar
  o que a janela deixou de fora numa mensagem `system` inicial. `summarizeWithModel(model)` é o
  sumarizador embutido: uma chamada extra, não-streamada (escreve num sink que descarta, então os
  tokens do resumo nunca chegam ao stream do usuário), registrada como uma linha de uso `summary` — a
  cota soma o ledger inteiro sem filtrar propósito, então limitar o custo de contexto não vira gasto
  que ninguém contabiliza. `estimateMessageTokens` e `DEFAULT_HISTORY_SUMMARY_INSTRUCTION` são
  exportados para compor a sua própria.
  
  O seam mudou de forma, e a razão é determinismo. `apply(messages, ctx) => ModelMessage[]`, rodado
  inteiro dentro de um checkpoint `history:window`, virou duas metades que rodam em lugares
  deliberadamente diferentes:
  
  - `select(messages, ctx) => { keep, drop }` é PURA e roda FORA de qualquer checkpoint. Seguro porque
    a entrada dela já É um checkpoint (o resultado cacheado de `load:thread`), então um replay chega ao
    mesmo corte sem gastar posição nenhuma — é isso que permite existir uma janela sem mexer em uma
    única posição do loop.
  - `summarize(dropped, ctx)` chama um modelo, então roda DENTRO de `history:summarize`: um run
    retomado lê de volta o resumo que a tentativa suspensa produziu, em vez de gerar outro (e de pagar
    duas vezes por ele).
  
  Para quem não configura janela nenhuma, o loop grava exatamente os mesmos checkpoints de sempre: o
  bloco inteiro é pulado. Para quem configura, um run já em voo continua replayando contra o
  `history:window` que o histórico dele guarda — a decisão de qual forma seguir sai do journal
  (`ctx.patched('agent:history-select')`), nunca da versão do código do processo que está replayando.

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - O servidor MCP deixava de fora os dois portões que o loop aplica.
  
  `tools/call` chamava `registry.invoke` direto, e `invoke` não conhece nem a `allowedTools` deste
  servidor nem o `kind` da tool. Três consequências, a primeira séria:
  
  - **Uma tool `action` executava sem aprovação humana.** No loop ela é HITL-gated: alguém aprova
    antes de rodar. Via MCP não há humano nenhum, e o handler rodava assim mesmo. Como o default de
    `roles` é ADMIN-only, a política de papéis era o único gate entre um chamador remoto e qualquer
    efeito colateral registrado.
  - **Tools servidas pelo loop** (`agent`, `ask`, `skill`, `memory`) apareciam na listagem. Uma tool de
    handoff é registrada com handler-stub porque quem delega é o `AgentLoop` — chamá-la responderia
    `{}` e não delegaria a ninguém.
  - **A `allowedTools` só valia na listagem.** Quem adivinhasse um nome alcançava uma tool que a
    implantação tirou da superfície de propósito.
  
  Agora `isExposable` decide igual na listagem e na chamada: `action` fora por default, com
  `actions: 'execute'` como opt-in nomeado — uma implantação dizendo que aceita um ator não aprovado
  rodando toda `action` que os papéis dele alcançam. Kinds servidos pelo loop nunca são expostos, nem
  sob o opt-in. E a allow-list é re-checada na chamada.
  
  `createMcpServer` não tinha teste nenhum, que é como isso passou. Tem agora, contra um `Client` MCP
  real, e cada portão foi revertido para ver o buraco reabrir.

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Memória de trabalho: o que o assistente concluiu sobre uma pessoa e sobre a organização dela,
  atravessando turnos e threads.
  
  Retrieval responde "o que os documentos dizem"; memória responde "o que eu decidi sobre você". Uma
  passagem é conteúdo que alguém escreveu e pode corrigir na fonte, e vai citada. Uma memória não tem
  fonte para consertar: é inferência do próprio agente. Por isso todo registro carrega um
  `MemoryOrigin`, por isso o bloco diz ao modelo que aquilo pode estar errado, e por isso `forget` é
  OBRIGATÓRIO no provider enquanto `write` é opcional — um deployment pode razoavelmente popular
  memória pelo próprio pipeline e não dar tool de escrita ao agente; nenhum pode razoavelmente guardar
  conclusões sobre uma pessoa que a pessoa não consiga apagar.
  
  **Os mesmos tokens de escopo e o MESMO `ScopeResolver` das skills**, para um deployment ter UMA
  resposta a "quais escopos este ator tem". Onde memória difere de skill de verdade, a diferença fica:
  a entrada carrega o VALOR derrotado e não só o escopo dele (um agente que soubesse apenas que existe
  um valor mais amplo não consegue dizer ao usuário qual é a diferença — só escolher, em silêncio, que
  é exatamente o que isto previne), e existe superfície HTTP de leitura e delete: `GET <path>/memories`
  e `DELETE <path>/memories/:id`. O autor de uma skill sabe que ela existe; o sujeito de uma memória
  não sabe. A leitura ignora `maxMemories` de propósito — aquele teto é orçamento de UM turno, e
  aplicá-lo ali significaria que alguém não consegue ver, e portanto apagar, uma crença que o
  assistente está a uma escrita de usar de novo.
  
  **Seleção por relevância (`MemoryProvider.search`).** O orçamento do prompt é limitado; o store não
  é. Escolher o bloco por ESCOPO mata os escopos mais amplos primeiro: a vigésima anotação de uma
  pessoa acaba com toda chance que os fatos da organização dela tinham — em silêncio, atrás de um
  `omitted` diferente de zero. O escopo continua sendo filtro duro que corta ANTES do ranking, e deixa
  de ser o ranking. O host é dono do índice (omita `search` e todo turno é a leitura escopada de
  sempre, sem mudança nenhuma); a lib é dona de resolução, precedência, orçamento e journal. A busca
  roda DENTRO de `memory:digest`, então todo replay lê de volta a seleção que a primeira tentativa fez.
  
  **`pinned` é categórico, não prioridade numérica.** Um número infla, não carrega significado
  revisável e compete com relevância, que já é uma ordenação contínua. Categoria vira orçamento: o
  pinned sai de `maxMemories` primeiro, e o que transborda é reportado como `pinnedOmitted` — porque
  essa omissão é erro de configuração, não o orçamento fazendo o trabalho dele. Um agente não consegue
  pinar as próprias escritas: `StoreMemoryInput` não tem esse campo, a mesma imposição por forma que
  mantém `scope` fora da tool `remember`.
  
  **O bloco é enquadrado por `origin.author`, em duas seções.** Uma memória de escopo amplo
  normalmente foi PUBLICADA por um administrador, não concluída pelo agente. Um enquadramento único
  sobre o bloco inteiro mandava o modelo tratar uma decisão organizacional como palpite próprio e
  "preferir o que o usuário diz agora" a respeito dela — o que entrega a qualquer usuário um override
  da política da empresa por simples afirmação. O que uma pessoa afirmou é instrução; o que o agente
  concluiu é hipótese.
  
  A tool `remember` não é registrada, gasta os checkpoints de um `read` e é autorizada contra os
  escopos que `memory:digest` gravou — nunca contra uma resolução nova. A escrita acontece DENTRO do
  `tool:<callId>`, o que a torna idempotente sob replay e põe no journal o que o modelo foi informado
  sobre ela. Um turno sem `memory` configurado tem sequência de checkpoints idêntica à de um que nunca
  teve a opção.

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `StoredMessage` passa a carregar o `runId` (e a `persona`) que a mensagem foi gravada com.
  
  `AppendMessageInput.runId` já existia e os dois stores já gravavam a coluna `run_id`, mas nada
  devolvia o valor: `getThread` não trazia o campo e o store em memória guardava a correlação num mapa
  lateral `messageId → runId`. Ou seja, quem lê uma thread só conseguia adivinhar a que turno cada
  mensagem pertence comparando timestamps contra o `startedAt` do run — e essa comparação quebra no
  momento em que um turno é regerado: a regeneração trunca a resposta substituída e responde de novo à
  mensagem de usuário SOBREVIVENTE, sem acrescentar uma nova, então andar para a frente no tempo
  entrega ao run antigo o texto da substituição.
  
  Junto veio uma auditoria do contrato inteiro: **tudo que `appendMessage` aceita tem que voltar em
  `getThread`**. Um campo que o adapter aceita e nunca devolve é invisível até alguém reabrir a thread e
  não achar mais o anexo — nada falha, nada é logado. `attachments` já fazia o round-trip nos dois
  stores daqui; `persona` não fazia em nenhum dos dois, e agora faz. O teste novo é tipado
  `Required<Omit<AppendMessageInput, …>>`, então um campo opcional novo no input não compila até ser
  listado ali.
  
  Nenhuma mudança de schema: as colunas `run_id` e `persona` de `agent_message` já existiam.

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Deixar o agente fazer uma pergunta estruturada ao usuário — e esperar.
  
  A única forma de um run parar por causa de uma pessoa era `awaitApproval`: um sim/não sobre uma tool
  call já proposta, no meio do trabalho. A direção contrária não existia — coletar o ESCOPO, antes do
  trabalho, enquanto mudar de rumo ainda é barato. Agora duas superfícies fazem isso, e foram construídas
  para serem indistinguíveis lá na frente.
  
  **Um intake configurado.** `AgentLoopDeps.intake` declara as perguntas; o turno passa por elas antes da
  primeira chamada de modelo. Como as perguntas são AUTORADAS, o intake não custa chamada de modelo
  nenhuma e não grava linha de uso — e `questions.length` é conhecido antes do formulário aparecer, que é
  a única forma honesta de um cliente renderizar "Pergunta 1 de 3" em vez de descobrir uma quarta no meio
  do caminho. `when: 'thread-start'` (default) pergunta uma vez por thread; `'every-turn'`, antes de cada
  turno.
  
  **Um `ask` chamável pelo modelo.** `ask: true` oferece ao modelo uma tool embutida `ask` para o caso que
  um intake não consegue antecipar. O input schema dela EXIGE um `defaults` já escolhido em toda pergunta:
  "eu já escolhi o que eu escolheria, então confirmar basta" é a afirmação em que essa superfície inteira
  se apoia, e um schema é o único lugar onde isso vira obrigatório em vez de aspiração. Um conjunto de
  perguntas malformado volta como falha de tool comum carregando as issues de validação, então o modelo
  conserta o próprio erro em vez de derrubar o run ou estacionar uma pessoa.
  
  **Uma forma só, um caminho de retomada só.** As duas gravam UMA linha de tool call pendente chamada
  `ask` (`toolType: 'action'`, `status: 'pending_approval'`, então ela aparece na caixa de aprovações que
  já existe), as duas emitem o mesmo frame novo de stream `elicitation`, e as duas estacionam no mesmo
  sinal `tool:<runId>:<callId>` em que uma aprovação HITL já espera. `POST /agent/tool-call/answer` e
  `/skip` espelham `approve`/`reject`, com a mesma checagem de dono. `AgentLoopHooks` ganha um
  `awaitAnswers` opcional; um host que só implementou `awaitApproval` ainda conclui uma elicitation, lendo
  approve como "confirmou as respostas pré-escolhidas" e reject como "pulou".
  
  **Uma pergunta omitida assume o próprio default**, resolvido no servidor contra o request que o run já
  tem em mãos e não no cliente — então "só apertou enter" e "escolheu exatamente os defaults" persistem
  igual, e um cliente que nunca renderizou os defaults não consegue submeter em branco. Um array PRESENTE e
  vazio é um "nenhuma dessas" explícito e não cai no default. A linha assentada grava `defaulted: string[]`,
  então um auditor ainda enxerga quais perguntas um humano tocou. **Pular não é confirmar:** cai nos mesmos
  valores e persiste como `rejected` em vez de `executed`, porque seguir com uma suposição que a pessoa se
  recusou a confirmar é um fato diferente de seguir com uma que ela escolheu. Ninguém responder estaciona o
  run indefinidamente, exatamente como uma aprovação — não existe timeout de intake, porque um timeout que
  aplicasse os defaults fabricaria consentimento a partir do silêncio.
  
  `ToolKind` ganha um quarto membro, `'ask'`. Nenhum `ToolSpec` o carrega: `ask` nunca é registrada, não tem
  handler, e é oferecida ao modelo direto da config do módulo — então o branch que decide se uma call
  estaciona numa pessoa nunca pode ser resolvido por um lookup de registry local do processo. Como nos
  outros kinds, o valor é resolvido DENTRO do checkpoint `persist:toolcall:<callId>` que já existia e é
  lido de volta dali em todo replay.
  
  **Checkpoints.** Um intake gasta uma posição para o veredito (`intake:ask`) mais uma nos turnos em que
  pergunta (`intake:answers`); um `ask` reusa os nomes do caminho de aprovação e acrescenta um
  (`stream:elicitation:<id>`). O veredito do intake é DEVOLVIDO por `intake:ask` em vez de recalculado,
  porque quando uma retomada replaya o turno a primeira tentativa já anexou a mensagem do próprio intake na
  thread — recalcular "esta thread já foi perguntada?" responderia não na ida e sim na volta, e poria a
  chamada de modelo onde o histórico guarda a espera. Nenhum marcador `patched` é gasto por nenhuma das
  duas: um intake só é alcançável por config nova e um `ask` só por um kind gravado que nenhum run
  existente registrou. Não declarar nenhuma das duas e a sequência de checkpoints do turno fica idêntica.
  
  **Uma diferença estrutural em relação ao porte de referência:** este store não tem
  `setMessageToolResults`, então as respostas assentadas ficam na linha da tool call — que é onde este repo
  já guarda todo resultado de tool — em vez de também serem anexadas na mensagem. A transcrição que o modelo
  lê carrega o round-trip completo de qualquer jeito. `StreamFrame` ganhou uma variante tipada
  (`{ t: 'elicitation', id, request }`) e `frameToSse` a serializa como `event: elicitation`; o envelope de
  um frame de texto continua byte-idêntico.

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Processadores de entrada e de saída — um seam de cada lado da chamada de modelo, com custo proporcional.
  
  O `PromptBuilder` conseguia acrescentar ao system prompt e nada conseguia olhar a resposta. Para uma
  aplicação que roda SQL gerado sobre dados sensíveis isso é um buraco no controle, não uma conveniência
  faltando: o único lugar onde a saída do modelo ainda pode ser barrada é entre o provider e o leitor, e
  esse lugar não existia.
  
  `AgentLoopDeps.inputProcessors` / `outputProcessors` criam os dois. Um `InputProcessor` reescreve
  `{ system, messages }` antes de TODA chamada de modelo do turno — toda chamada, não uma por run, porque
  a transcrição cresce entre os passos e um redator que só viu o prompt de abertura deixaria passar o que
  um resultado de tool trouxe de volta. Um `OutputProcessor` vê a resposta de cada passo e devolve `pass`,
  `replace` (uma redação é uma substituição) ou `reject`, que encerra o run com `OutputRejectedError` em vez
  de uma resposta. Os dois são globais do módulo e valem para todo agente e persona: um controle do qual
  uma persona pode sair não é um controle.
  
  **Não são um segundo `HistoryWindow`.** Seleção — quais mensagens da thread entram no turno — continua
  sendo do `historyWindow`, que é puro e roda FORA de qualquer checkpoint. Processadores transformam o que a
  seleção produziu e rodam DENTRO de um, então podem chamar um modelo. A transcrição canônica do loop não é
  tocada: uma redação é o que sai do processo, nunca a memória da thread sobre o que foi dito — e dois
  passos de um mesmo turno nunca compõem a reescrita um do outro.
  
  **Registrar um processador de saída tira a chamada de modelo do sink ao vivo, e o preço disso é
  proporcional ao que a cadeia declara.** Um gate que precisa ler a resposta inteira não pode rodar depois
  que ela já chegou ao leitor, então o turno escreve num buffer e o loop solta o conteúdo — como UM frame
  `text` — quando a cadeia passa. Isso é a resposta certa para uma passada de moderação e caro demais para um
  redator de regex que não precisa da resposta toda:
  
  ```ts
  const redactEmails: OutputProcessor = {
    name: 'redact-emails',
    incremental: { lookbackChars: 320 },
    process: (answer) => ({ action: 'replace', text: answer.text.replace(EMAIL, '[email]') }),
  }
  ```
  
  **Não declarar continua significando resposta inteira**, e uma cadeia só é incremental quando TODO membro
  declara. Quem escreveu `process` contra o texto completo nunca é rebaixado porque um vizinho aderiu.
  Declarar `incremental` é uma promessa sobre todo prefixo: a cadeia vê o PREFIXO que cresce (nunca cada
  frame novo), então sempre recebe texto bem formado; fora dos últimos `lookbackChars` caracteres da própria
  saída, um `replace` não muda mais conforme o prefixo cresce; e uma recusa promete ser decidível a partir de
  um prefixo. `lookbackChars` é por processador (default 64) e o gate usa o maior da cadeia.
  
  A passada de resposta inteira continua AUTORITATIVA para o stream e para o store — a liberação incremental
  só adianta o prefixo. O gate depois confere que a resposta assentada `startsWith` o que já foi liberado e
  levanta `ProcessorFailedError` se não for, de modo que a concordância entre o que foi transmitido e o que
  foi gravado é estrutural, e uma janela curta demais para um padrão falha alto em vez de transmitir
  justamente o texto que ela existia para redigir.
  
  **Determinismo.** `process:input:<step>` e `process:output:<step>` só existem quando configurados, então
  quem não registra nada grava exatamente os mesmos checkpoints de sempre. O buffer, o prefixo já liberado e
  uma recusa vinda de prefixo viajam no CHECKPOINT `llm:<step>`, não numa variável local: um run que suspende
  entre a chamada de modelo e o gate retoma num processo que nunca viu aquele stream, e a liberação é
  calculada a partir do `releasedText` gravado — então a retomada emite só a cauda que ainda deve, em vez de
  despejar a mesma resposta uma segunda vez, mesmo que a cadeia tenha sido redeclarada no meio. Uma recusa só
  é levantada DEPOIS de `persist:usage:<step>` e `quota:bump:<step>`: aqueles tokens foram gastos de verdade, e
  um gate que escondesse o próprio custo deixaria uma cadeia mal calibrada queimar um orçamento invisivelmente.
  
  **Uma diferença estrutural em relação ao porte de referência:** o sink daqui carrega `StreamFrame` tipado,
  não bytes, então não há frame que o gate não consiga classificar — e o buffer viaja num checkpoint como
  está. Em compensação, as tool calls de um passo só são reportadas quando `runTurn` RETORNA, então no caminho
  incremental `ModelAnswer.toolCalls` fica vazio até a passada autoritativa, que sempre as vê.

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Restringir a resposta de um turno a um schema.
  
  Toda resposta que esta biblioteca produzia era texto livre, então a única forma de tirar um valor
  tipado de um turno era declarar uma TOOL cujo trabalho inteiro era receber esse valor.
  
  `AgentLoopDeps.outputSchema` aceita qualquer [Standard Schema](https://standardschema.dev) (Zod,
  Valibot, ArkType). O valor validado volta como `object` no resultado do run, tipado quando o loop é
  chamado direto (`runAgentLoop<T>`), e é gravado na mensagem do assistente como uma tool call sintética
  `structured_output` — o mesmo dispositivo que o retrieval em modo inject já usa, então ele persiste e
  renderiza sem nenhum store ganhar coluna. É declarado no AGENTE e não por requisição porque um schema é
  um objeto vivo e `AgentRunInput` atravessa uma fronteira JSON a caminho de um workflow durable.
  
  **Como compõe com tool calling: como uma passada de formatação separada, sempre.** O turno roda a
  iteração modelo→tools exatamente como rodaria sem schema; quando um passo volta sem tool calls, uma
  chamada extra não-streamada (`structured:<step>:<attempt>`, `tools: []`, `outputSchema` setado)
  reescreve aquela resposta no formato do schema. A maioria dos providers não serve response format e
  tool set no mesmo request. Pular a passada para um agente que por acaso não tem tools seria mais barato
  e deliberadamente NÃO é feito: essa decisão leria o registry de tools de qualquer processo que estivesse
  replayando, que é exatamente como um run retomado acaba pedindo uma posição de checkpoint que o
  histórico dele não tem. Então a passada é incondicional, e custa uma chamada de modelo por turno,
  faturada na própria linha de uso `structured_output`.
  
  **A passada é uma tradução, então ela recebe o que uma tradução precisa:** a pergunta e a resposta que
  sobreviveu ao gate de saída — nunca a transcrição inteira do turno, que seria o prompt do turno de novo
  e sem desconto nenhum (a passada troca o bloco `system` pela instrução do schema, e o bloco `system` é o
  prefixo do cache). A pergunta sai do prompt PROCESSADO, não de `AgentRunInput.userText`: esta é uma
  segunda saída do modelo e tem que ficar atrás da mesma cadeia de `inputProcessors` que o turno
  transmitido ficou. `outputFromTranscript` devolve o comportamento antigo para o agente cuja resposta
  genuinamente não pode ser reescrita a partir das próprias palavras.
  
  **Uma resposta que falha o schema é um desfecho DEFINIDO.** Até `outputRepairAttempts` chamadas a mais
  (default 1) repetem o pedido com as issues de validação da tentativa anterior anexadas; depois disso o
  run falha com `StructuredOutputError` carregando as issues, o texto que as violou e a contagem de
  tentativas. Limitado porque um modelo que não consegue satisfazer um schema normalmente também não
  consegue na quarta tentativa, e toda tentativa é cobrada. `outputRepairAttempts: 0` falha na primeira
  resposta inválida.
  
  `ModelTurnArgs` ganha `outputSchema` e `ModelTurnResult` ganha `object`. O adaptador do AI SDK mapeia o
  schema em `output: Output.object(...)` do `streamText` para o provider restringir a geração, e devolve o
  valor que ele mesmo parseou — mas o loop valida de qualquer jeito. "O provider disse que bate" não é a
  mesma afirmação que "bate", e um provider que ignorou o schema tem que falhar onde a falha é reparável,
  não lá na frente. Um adaptador que não consegue restringir a geração continua funcionando: o loop lê o
  JSON do texto da resposta, cercas e prosa de abertura incluídas.
  
  `UsagePurpose` ganha `'structured_output'`; os dois stores já gravam `purpose` como texto, então não há
  mudança de schema. Quem não declara `outputSchema` não vê checkpoint novo, chamada extra nem mudança
  nenhuma na sequência de checkpoints do loop.
  
  **Uma diferença estrutural em relação ao porte de referência:** o loop daqui devolve os resultados de
  tool ao modelo como uma mensagem `user` VAZIA carregando `toolResults`, então "a última mensagem do
  usuário" não serve para achar a pergunta — a passada receberia uma pergunta em branco em todo turno que
  chamou uma tool. `restatementPrompt` procura a última mensagem de usuário que de fato diz alguma coisa.

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - O resultado de uma tool passa a chegar em quem reabre a thread.
  
  O loop escrevia a saída de cada tool só na tabela de tool calls. Quem lê uma thread pareia uma call
  com o resultado dela pela MENSAGEM em que a call foi feita — então toda tool de todo turno já
  encerrado aparecia como uma tool ainda rodando, para sempre, nos dois stores. Nada falhava, nada era
  logado: a transcrição simplesmente mentia sobre o estado de um turno que terminou.
  
  `AgentStore.setMessageToolResults(messageId, results)` anexa os resultados já liquidados à mensagem
  que fez as calls, substituindo o que ela tinha. É **obrigatório** na SPI, não opcional: um store que
  silenciosamente não implementasse isso renderizaria um turno terminado como um turno eternamente em
  voo, e um método faltando tem que quebrar a compilação em vez de quebrar a tela. `LucidAgentStore` e
  `InMemoryAgentStore` implementam os dois.
  
  Uma escrita, um comportamento, os dois adapters — não duas implementações que por acaso concordam.
  
  O loop escreve num checkpoint próprio (`persist:toolresults:<step>`), depois da última tool do turno.
  Isso é uma posição nova no journal, então ela é guardada por `ctx.patched('agent:message-tool-results')`:
  um run que suspendeu no meio de um turno sob a forma anterior não tem espaço entre o último
  `persist:toolexec` e o `llm:` seguinte, lê o marcador como ausente e continua replayando a forma que o
  histórico dele guarda. Todo valor escrito ali já vem de um checkpoint acima, então um replay grava a
  mesma lista.
  
  O intake configurado ganha o mesmo tratamento dentro de `intake:answers`: o checkpoint `intake:ask`
  agora devolve o id da mensagem que perguntou, e a resposta liquidada (ou o skip) pousa nela. Um
  checkpoint que gravou apenas SE o intake rodou não traz id, e só nesse caso a linha de tool call
  continua sendo o único registro.

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Retrieval em modo inject e a resposta estruturada passam a ser entregues como tool calls comuns.
  
  As duas já eram gravadas como tool calls sintéticas, mas só como LINHA na tabela de tool calls: a
  call não estava na mensagem e o resultado não estava em lugar nenhum dela. Como um leitor de thread
  pareia call e resultado pela mensagem, nenhuma das duas aparecia para nenhum cliente — nem ao vivo,
  nem ao reabrir a conversa. Citações de um retrieval injetado e o valor validado de um `outputSchema`
  existiam no banco e não existiam na tela.
  
  Agora as duas sobem na mensagem do assistente a que pertencem, com a call em `toolCalls` e o
  resultado em `toolResults`, exatamente como uma tool `read` que o modelo tivesse pedido. Um cliente
  que já renderiza tool call renderiza essas duas sem mudança nenhuma.
  
  O id de cada uma sai do RUN (`retrieve-<runId>`, `structured-<runId>`) e não da mensagem: a mensagem
  ainda não existe quando o par é montado, e as duas precisam estar no append — uma call anexada
  depois renderiza como tool ainda rodando, que é o problema que isto resolve. Os checkpoints
  (`persist:retrieval:<messageId>`, `persist:structured:<messageId>`) mantêm nome e posição, e todo
  valor gravado ali já vem de um checkpoint anterior do mesmo turno, então um replay remonta o mesmo
  par em vez de cunhar um novo.

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Skills: procedimentos autorais que o modelo busca quando a tarefa pede, escopados por tokens que o
  host define.
  
  Uma skill NÃO é um agente. Um agente é QUEM responde — prompt, tools, janela de histórico, schema de
  saída. Uma skill é COMO uma tarefa específica é feita, e qualquer agente pode puxar uma. Por isso uma
  skill não carrega modelo, nem lista de tools, nem schema: no instante em que carregasse, as duas
  seriam a mesma coisa com nomes diferentes e o consumidor teria que escolher entre elas por razões que
  ninguém saberia enunciar.
  
  **O escopo é um token OPACO, nunca um enum.** `actor:u1`, `tenant:base-7`, `global`, ou o
  `sector:logistics` do próprio host. Um `ScopeResolver` fornecido pelo host diz quais se aplicam, do
  mais específico para o mais amplo, e essa ORDEM é a precedência. Um enum aqui faria de cada eixo novo
  (setor, esquadrão, base, turno) uma migração numa biblioteca que não tem por que saber que eles
  existem; um token é uma string que o host cunha sozinho. Esta biblioteca é dona do contrato (o que um
  escopo significa, como a precedência funciona, o que é journalado); o host é dono das linhas.
  
  **O que custa ao prompt: uma linha por skill.** O bloco `<skills>` carrega nome, escopo e descrição —
  nunca o corpo. O CORPO chega como resultado de tool, na transcrição, onde o `HistoryWindow` já
  governa. Então skills não viram um quarto competidor pelo bloco `system`, e um deployment com
  cinquenta skills paga cinquenta linhas mais os corpos que o turno de fato pediu para ler.
  
  **Os dois valores saem do journal.** Os escopos resolvidos e o catálogo que sobreviveu à precedência
  são UM checkpoint (`skills:catalog`); o corpo carregado sai de dentro do `tool:<callId>`. Um replay
  que relesse o provider comporia um prompt DIFERENTE a partir de uma skill editada no meio, numa
  posição de transcrição que o histórico já guarda. O catálogo journalado também é a fronteira de
  autorização: um nome que o turno não foi oferecido é recusado ali, então um modelo que inventa um
  nome não alcança um corpo por um provider que serviria de bom grado.
  
  A tool `skill` não é registrada — não tem handler, exatamente como `ask` — e gasta os checkpoints de
  um `read`, exatamente: `persist:toolcall`, `tool:<id>`, `persist:toolexec`/`persist:toolfail`. Um
  turno sem `skills` configurado tem sequência de checkpoints idêntica à de um que nunca teve a opção.
  
  `withAskTool` virou `withBuiltInTools({ tools, ask, skills })`, que é onde as duas built-ins entram na
  lista do turno.

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - As tool calls `read` de um mesmo turno passam a rodar em paralelo.
  
  Um modelo rotineiramente pede várias tools de uma vez, e o loop executava uma depois da outra — duas
  leituras independentes de três segundos custavam seis. Agora elas se sobrepõem, e o turno custa a
  chamada mais lenta em vez da soma.
  
  O que fez disso um problema de determinismo, e não um `Promise.all`, é que o corpo do loop é
  replayado pelo engine durable, que distribui posições de checkpoint por um contador monotônico
  conforme o corpo roda. Intercalar blocos inteiros por chamada ordenaria essas posições por quem
  terminasse primeiro, o que difere entre um run e seu replay.
  
  Então só as INVOCAÇÕES se sobrepõem. Os `persist:toolcall` antes delas e os
  `persist:toolexec`/`persist:toolfail` depois continuam estritamente sequenciais, em ordem de
  chamada, e as invocações são todas lançadas no mesmo tick — `ctx.localStep` pega sua posição na
  CHAMADA, antes do primeiro `await`, então o bloco fica fixado em ordem de chamada independentemente
  de como as tools terminem. Um turno só é elegível quando o kind journalado de TODA chamada é `read`:
  uma `action` suspende numa aprovação humana (paralelismo não compra nada, e reservar uma posição de
  invocação para uma chamada que pode ser REJEITADA gasta uma posição que o branch rejeitado nunca
  preenche), e uma delegação `agent` é `ctx.child`, cuja forma paralela é o `ctx.all` do próprio
  runtime.
  
  Dois `AgentLoopHooks` opcionais novos:
  
  - `parallel(tasks)` — roda as tasks concorrentemente e resolve quando TODAS assentaram, resultados em
    ordem de entrada. Ausente, o loop segue sequencial, que é a resposta honesta para um runner que
    atribui posições em qualquer outro momento que não a chamada. `settleAll` é a implementação que os
    dois runners embarcados passam. Esperar todas é carga estrutural: um runner durable desenrola um
    turno lançando, e uma irmã abandonada no meio do próprio step é uma tool que ninguém roda.
  - `patched(id)` — o portão de versão do runner (`ctx.patched`). O batching move os `persist:toolcall`
    para antes da primeira execução, então um run que suspendeu no meio de um turno sob a forma antiga
    continua replayando contra ela.
  
  Um turno com menos de duas chamadas, ou de um runner que não optou por isso, grava exatamente a
  sequência de checkpoints que sempre gravou.
  
  Uma falha de controle de fluxo do runner (`hooks.isControlFlowError`) também deixou de virar
  `persist:toolfail`: como uma recusa de integridade de replay, ela sobe intacta, antes de qualquer
  persistência.

### Patch Changes

- [#117](https://github.com/DavideCarvalho/adonis-agora-agent/pull/117) [`3ba0ea8`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3ba0ea8c2cfc289af8ce38d70a452177c3b93eb8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - O `kind` de uma tool call passa a ser resolvido dentro do checkpoint `persist:toolcall`, não no corpo do loop.
  
  O kind decide o fluxo da call — uma `action` suspende o run num sinal de aprovação
  (`tool:<runId>:<callId>`), uma `agent` delega, o resto grava um step — e era lido de
  `deps.registry` no corpo do workflow, ou seja, o branch dependia do registry do processo que por
  acaso rodasse aquele corpo. Um processo cujo registry não tem a tool (um módulo que nunca a
  declarou, uma superfície que não monta tools, uma instância ainda subindo) lia `undefined`, caía
  no default `'read'` e pedia um checkpoint `tool:` onde o histórico guardava o sinal de aprovação —
  recusa de não-determinismo no resume, e uma action gated rodando sem a aprovação de ninguém.
  
  A resolução — e os gates de delegação que dependem dela — agora acontece dentro do step
  `persist:toolcall:<callId>` e é retornada dele, então o replay lê o kind gravado em vez de
  perguntar ao próprio registry. Mesmo nome de step na mesma posição do journal, então runs em voo
  continuam replayando; um checkpoint anterior ao valor retornado não traz nada, e só nesse caso o
  registry local volta a ser consultado.
  
  Recusas de integridade de replay agora sobem intactas pelo loop e pelo workflow `agora.agent.run`.
  Os dois `catch` reagiam a uma delas escrevendo MAIS checkpoints — um `persist:toolfail`, um
  `persist:run:fail` — e num journal que já divergiu cada um deles pede uma posição que o histórico
  não tem, então a tentativa de recuperação levantava a própria recusa e era ESSA que aparecia: uma
  mensagem apontando o seq errado e nomeando checkpoints do caminho de recuperação, não os dois que
  de fato discordaram. O workflow ainda fecha o stream, para o subscriber não ficar pendurado num run
  que o engine está prestes a falhar. `isReplayIntegrityError` é exportado do pacote.

## 0.31.0

### Minor Changes

- [#111](https://github.com/DavideCarvalho/adonis-agora-agent/pull/111) [`4c9bfe2`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/4c9bfe2cae0e750d778dfaffd95118df122b6afc) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **BREAKING** — pagination agora fala a MESMA interface de cursor de `@adonis-agora/filter`, em todo o ecossistema Agora
  
  Cada `@adonis-agora/*` paginava do seu jeito. Agora todos falam o `CursorParams`/`CursorPage` do
  `@adonis-agora/filter`: `{ after?, first? }` entra, `{ items, nextCursor, prevCursor, hasNext, hasPrev }`
  sai. Um consumidor que aprende a paginar uma lib paginou todas.
  
  Os tipos vivem em `@adonis-agora/agent` (`CursorPage`, `CursorParams`, exportados da raiz) e espelham os do
  `@adonis-agora/filter` **estruturalmente** — sem dependência entre os pacotes, por convenção do
  ecossistema. O `-dashboard` carrega a mesma declaração no seu `client/types.ts`, como já fazia com todas as
  outras wire shapes.
  
  **Forward-only, e isso está no tipo.** Os dois backends aqui só sabem avançar — o `scroll` do Qdrant
  devolve um `next_page_offset` opaco e nenhum token de volta, e o read-model de runs pagina com um cursor
  opaco pra frente. Então `CursorParams` NÃO tem `before`/`last` (um parâmetro que compila e não faz nada é
  pior que um que não existe), e todo `CursorPage` daqui sai com `prevCursor: null` / `hasPrev: false`. Esses
  dois campos ficam porque o ponto é ser a MESMA forma do `@adonis-agora/filter`: quem escreveu contra um
  renderiza o outro sem condicional, e uma superfície que ganhar paginação pra trás preenche os campos sem
  quebrar ninguém. São constantes, não bug.
  
  Como é 0.x, o breaking sai como **minor** (convenção semver de 0.x).
  
  ### 1. `QdrantStore.scrollChunks` — uma PÁGINA por chamada, não a coleção inteira
  
  `scrollChunks` drenava o cursor até o fim e devolvia um array. Agora é uma superfície paginada de verdade:
  uma ida de rede, `first` é o `limit` do scroll, `nextCursor` embrulha o `next_page_offset` do Qdrant em
  base64url — **opaco**, justamente pra ninguém passar a depender de ele ser um id de ponto. Devolver esse
  cursor adulterado agora falha com erro nomeado em vez de rebobinar em silêncio pra primeira página (um
  scroll que rebobina reprocessa chunks que um painel de deleção já tratou).
  
  `pageSize` virou `first` (mesmo default, 256) e `maxPages` sumiu: com uma página por chamada, o teto de
  páginas é o laço de quem chama. O `MAX_SCROLL_PAGES` interno segue guardando os scrolls que a store ainda
  drena sozinha (`listDocuments`, `listDocumentIds`, `updateMetadata`).
  
  ```ts
  // antes — drenava tudo, guardado por maxPages
  const payloads = await store.scrollChunks({ filter, payloadKeys: ['id'], pageSize: 256 });
  
  // depois — uma página; drenar é um laço seu sobre nextCursor
  const page = await store.scrollChunks({ filter, payloadKeys: ['id'], first: 256 });
  page.items; // Record<string, unknown>[]
  
  const all: Record<string, unknown>[] = [];
  let after: string | undefined;
  do {
    const p = await store.scrollChunks({ filter, ...(after ? { after } : {}) });
    all.push(...p.items);
    after = p.nextCursor ?? undefined;
  } while (after !== undefined);
  ```
  
  `facetValues(field, { limit })` virou `facetValues(field, { first })` — mesmo default (200), só o nome do
  tamanho de página alinhado ao `CursorParams`. Ele **não** virou `CursorPage`, de propósito: o endpoint
  `/facet` do Qdrant devolve os top-`first` valores de uma vez e não emite token de continuação nenhum, então
  um envelope de página aqui anunciaria um `nextCursor` que só poderia ser `null` pra sempre. Facet é
  agregado com teto; `scrollChunks` é a superfície paginada. `countChunks` (um número) segue igual.
  
  `PgVectorStore`/`MemoryVectorStore` não precisaram mudar: `scrollChunks`/`facetValues`/`countChunks` são
  capacidades do Qdrant, não estão na interface `VectorStore` que as três stores implementam, então não há
  como as duas formas divergirem.
  
  ### 2. `AgentGovernanceQueries.listRuns` — mesmos cursores, nomes do ecossistema
  
  Já era baseado em cursor, só com nomes próprios. `ListRunsResult` agora é literalmente
  `CursorPage<RunSummaryRow>`: as linhas saem em **`items`** (não `runs`), com `prevCursor`/`hasPrev`
  constantes.
  
  ```ts
  // antes
  const page = await gov.listRuns({ status: 'failed', limit: 50, cursor: prev });
  page.runs;
  page.nextCursor;
  
  // depois
  const page = await gov.listRuns({ status: 'failed', first: 50, after: prev });
  page.items;
  page.nextCursor; // + prevCursor: null, hasNext, hasPrev: false
  ```
  
  Quem implementa `AgentGovernanceQueries` por fora precisa renomear `runs` → `items` e devolver os três
  campos novos. As duas implementações que este pacote traz (`LucidGovernanceQueries` e a
  `InMemoryGovernanceQueries` de teste) já vieram atualizadas.
  
  **Rota HTTP** — `GET /agent/governance/runs` troca a query string e o corpo:
  
  ```diff
  - GET /agent/governance/runs?limit=50&cursor=<opaco>
  - { "runs": [...], "nextCursor": "<opaco>" }
  + GET /agent/governance/runs?first=50&after=<opaco>
  + { "items": [...], "nextCursor": "<opaco>", "prevCursor": null, "hasNext": true, "hasPrev": false }
  ```
  
  O `?limit=` continua existindo — só nas listas com TETO, que não são paginadas por cursor
  (`recentToolCalls`, `recentThreads`, a caixa de aprovações). A regra é essa: superfície com cursor fala
  `after`/`first`; top-N com teto fala `limit`.
  
  **Cliente do console** — `AgentClient.listRuns({ cursor, limit })` virou `listRuns({ after, first })` e
  devolve `CursorPage`. O provider do Telescope (`agent.runs.recent`) e o hook `useRuns` da SPA já
  acompanham; a UI do console não muda.

- [#112](https://github.com/DavideCarvalho/adonis-agora-agent/pull/112) [`3b7c240`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3b7c2403d6ee37555e40e18d02c0114962f90e95) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Require zod 4: the optional `zod` peer narrows from `^3.23.0 || ^4.0.0` to `^4.0.0`.
  
  The zod 3 half was a promise this package could not keep. `@adonis-agora/durable` — which agent
  peers on — types its public step API with zod 4 (`import type { z } from 'zod'`), and a zod 3 schema
  does **not** satisfy zod 4's `ZodType`: an app on zod 3 was already broken against the published
  ecosystem, it just failed later and less clearly. Narrowing makes the manifest honest.
  
  The peer stays **optional** — nothing changes for an app that never passes a zod schema. If you are
  still on zod 3, upgrade to zod 4 (`z.object`/`z.string()`/`z.infer`, the surface agent uses, is
  unchanged across the major).

## 0.30.2

### Patch Changes

- [#108](https://github.com/DavideCarvalho/adonis-agora-agent/pull/108) [`a99256b`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/a99256b185ce1f4d653476d5b5d0fc675ad25c57) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Corrige `AuthzActorResolver` para ler `userRef`/`tenantId` do `@agora/context` como MÉTODOS, não como valores — bug que derrubava com 401 toda rota do agente atrás de authz
  
  `@adonis-agora/context@0.6.1` publica no slot global `Symbol.for('@agora/context:accessor')` um accessor cujos campos são funções (`packages/core/src/accessor.ts`): `{ traceId(), tenantId(), userRef(), get() }`. `packages/adonis/src/authz/agora-context.ts` declarava `userRef`/`tenantId` como propriedades diretas, e `AuthzActorResolver.resolve()` lia `accessor?.userRef` como VALOR — contra o accessor real, isso é a própria função, `ref.id` é sempre `undefined`, e o resolver caía no ramo fail-closed ("no authenticated identity in @agora/context") em toda chamada. `tenantId` errava do outro lado, mais silenciosamente: uma função é truthy, então o escopo passado ao authz virava `{ tenantId: <function> }`.
  
  Isso passou despercebido porque o spec do resolver montava um dublê com `userRef`/`tenantId` como valor — a forma que o resolver assumia, não a que `@adonis-agora/context` produz. Um dublê que não respeita o contrato do original testa uma fantasia.
  
  **O que muda:**
  
  - `AgoraContextAccessor` (em `agora-context.ts`) agora tipa `tenantId`/`userRef` como métodos (`() => T | undefined`), espelhando o contrato real do accessor.
  - Duas novas funções, `userRefFromContext()` e `tenantIdFromContext()`, chamam esses métodos com segurança: toleram o campo não ser uma função (accessor parcial/mockado) e toleram o método lançar (fora de um contexto ativo) — em qualquer um dos dois casos degradam para `undefined` em vez de propagar, mantendo a postura fail-closed do chamador (`AuthzActorResolver` nunca fabrica identidade).
  - `AuthzActorResolver.resolve()` passa a usar essas duas funções em vez de ler `accessor.userRef`/`accessor.tenantId` como propriedade.
  - Specs de `authz-actor-resolver.spec.ts` e `agora-context.spec.ts` reescritos para mockar o accessor na forma real (métodos), com casos novos cobrindo: método ausente, método que lança, e `userRef()`/`tenantId()` retornando `undefined` fora de um contexto ativo.
  
  Não há mudança de assinatura pública — `AuthzActorResolverConfig`, `authzActorResolver()` e o formato do `Actor` resolvido continuam os mesmos. Consumidores que hoje contornam este bug manualmente (lendo o accessor tolerando as duas formas) podem remover o contorno depois de atualizar.

## 0.30.1

### Patch Changes

- [#104](https://github.com/DavideCarvalho/adonis-agora-agent/pull/104) [`0b7fe31`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/0b7fe3146ec33502bb09340cfa45002d002bd7e3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `facetValues`/`countChunks` param de enviar `exact: true` — a contagem exata era o hang que restou
  
  Medido contra o corpus real de produção (572 mil pontos, índices keyword já provisionados): um `facet` **exato** custou **23,5s** no server; o mesmo facet no default aproximado, **0,05s** (470× mais rápido) e o total veio idêntico. Como a agregação de um painel faz um facet por campo × tipo (~10 chamadas), `exact: true` como default somava minutos de request — exatamente o sintoma do painel "carregando para sempre" que a capacidade veio curar.
  
  Agora `exact` é **opt-in** nas duas capacidades ( `{ exact: true } ` quando a contagem exata for o objetivo — reconciliação, diff), e o default herda o default rápido do server. `removeWhere` mantém contagem exata de propósito: lá ela é a afirmação "quantos chunks este delete removeu", atada ao retorno da escrita, não um número de painel.

## 0.30.0

### Minor Changes

- [#102](https://github.com/DavideCarvalho/adonis-agora-agent/pull/102) [`4e95eeb`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/4e95eeb730feb944198a42d29bfc168b511868f4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Nova seam `HistoryWindow` para compactar o histórico de uma thread antes de cada turno
  
  Sem isso, `runAgentLoop` mapeia a thread PERSISTIDA inteira em `ModelMessage[]` a cada turno — uma thread de vida longa acumula mensagens e o custo/latência de input cresce sem limite, até eventualmente estourar a janela de contexto do modelo.
  
  `AgentConfig.historyWindow` (e o equivalente em `AgentLoopDeps`/`AgentDepsFactoryConfig`) aceita qualquer impl de `HistoryWindow` — mesmo padrão seam do `Retriever` já existente. O pacote traz `SlidingWindowHistory`, um truncador simples que mantém só as últimas N mensagens (padrão 40), sem resumo. Quem quiser sumarização (condensar as mensagens descartadas via um modelo) implementa a interface diretamente.
  
  Aplicado dentro de `hooks.step`, então uma retomada durable reaproveita o MESMO resultado — necessário para uma impl que gasta tokens num modelo não pagar duas vezes no replay.
  
  **Não-quebrante**: sem `historyWindow` configurado, o comportamento é idêntico a antes — histórico completo em todo turno.

- [#102](https://github.com/DavideCarvalho/adonis-agora-agent/pull/102) [`4e95eeb`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/4e95eeb730feb944198a42d29bfc168b511868f4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Painéis de inspeção do RAG ganham agregação server-side: `facetValues`, `countChunks` e `scrollChunks` no `QdrantStore`
  
  Quem constrói um admin sobre a coleção (`quantos chunks por documento? por tipo? quais chunks deste documento?`) esbarrava num muro: a store só sabia `search` (vetor) e `listDocuments` (colapsado por `documentId`). A alternativa honesta era um scroll da coleção inteira por request — em corpus de dezenas de milhares de pontos isso não é uma listagem, é um hang (foi exatamente o que um painel em produção fez: centenas de round-trips sequenciais de scroll e o browser girando para sempre).
  
  **O que entra:**
  
  - O filtro estrutural cresce para a linguagem que o GROUP BY de cadeia de prioridade precisa: `QdrantCondition` vira união com `is_empty` (campo AUSENTE/null/empty — os buckets de fallback), `QdrantFilter` ganha `must_not` (com `is_empty`, "campo PRESENTE") e `should` (OR — o fallback que é ausente OU o literal).
  - `facetValues(field, {filter?, limit?})` — o `POST /facet` do Qdrant: GROUP BY + contagem exata por valor, uma ida de rede. Qdrant exige índice de payload no campo; no primeiro erro o store PROVISIONA o índice `keyword` e repete o facet exatamente uma vez — a primeira chamada numa coleção nova paga o índice, as demais são facet puro. Sem `facet` no client injetado, o erro diz isso nominalmente; sem `createPayloadIndex`, o erro original do server propaga (nada de degradação silenciosa).
  - `countChunks({filter?})` — o agregado por trás de linhas como "chunks sem chave nenhuma", sem enumeration.
  - `scrollChunks({filter?, payloadKeys?, pageSize?, maxPages?})` — pagina os CHUNKS com o mesmo filtro raw do facet, vetor nunca atravessa o fio. Diferente de `listDocuments`: é por chunk e fala o filtro cru — existe para inspeção/deleção, onde o chamador conhece o payload que ele mesmo gravou.
  - `delete` no shim aceita `points` (lista de ids de ponto), como o client real já aceita — apagar "o que a agregação contou" sem reapresentar filtro.
  
  **Não-quebrante por construção:** nada disso toca o `VectorStore` SPI — são capacidades concretas do `QdrantStore` (como `ensureCollection`), e os dois métodos novos do client shim são `OPTIONAL` (o mesmo padrão de `setPayload?`/`count?`), então host com client escrito à mão continua compilando.
  
  **Validado contra Qdrant vivo** (`rag-qdrant-live.spec.ts`, gate `AGENT_QDRANT_URL`): o auto-provisionamento do índice acontece de verdade no server, `is_empty` cobre ausente e null, `must_not: [is_empty]` é presença, e o facet com `filter` honra a prioridade da cadeia (chunk com `numeroProcesso` E `examId` só conta no primeiro). O fake grava as chamadas e cobre as paths de erro (client sem capacidade, erro persistente sem retry infinito, cursor com `maxPages`).

- [#102](https://github.com/DavideCarvalho/adonis-agora-agent/pull/102) [`4e95eeb`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/4e95eeb730feb944198a42d29bfc168b511868f4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Alarga o peer `@adonisjs/redis` para aceitar `^11.0.0`
  
  `@adonisjs/redis` era um peer opcional em `^9.2.0 || ^10.0.0`. O sink Redis (`tokenSinks.redis()`) nunca importou tipos do driver — ele resolve `redis` pelo container do Adonis e duck-tipa a conexão (`RedisManagerLike`/`IoRedisLike`), então não há superfície de tipos ou API própria deste pacote presa à versão do driver.
  
  **Nota**: `@adonis-agora/durable` e `@adonis-agora/diagnostics` (peers próprios deste pacote, usados quando o durable/telescope estão habilitados) ainda declaram `^9.2.0 || ^10.0.0` nas suas versões publicadas atuais — um consumidor rodando `@adonisjs/redis@11` com esses dois habilitados verá um aviso de peer não satisfeito do gerenciador de pacotes até esses pacotes alargarem o próprio range. É só aviso; não é erro de instalação nem quebra em runtime.

## 0.29.0

### Minor Changes

- [#100](https://github.com/DavideCarvalho/adonis-agora-agent/pull/100) [`a4088f0`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/a4088f0cff6320e5ca86a4eb09c595b587df7f91) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Painéis de inspeção do RAG ganham agregação server-side: `facetValues`, `countChunks` e `scrollChunks` no `QdrantStore`
  
  Quem constrói um admin sobre a coleção (`quantos chunks por documento? por tipo? quais chunks deste documento?`) esbarrava num muro: a store só sabia `search` (vetor) e `listDocuments` (colapsado por `documentId`). A alternativa honesta era um scroll da coleção inteira por request — em corpus de dezenas de milhares de pontos isso não é uma listagem, é um hang (foi exatamente o que um painel em produção fez: centenas de round-trips sequenciais de scroll e o browser girando para sempre).
  
  **O que entra:**
  
  - O filtro estrutural cresce para a linguagem que o GROUP BY de cadeia de prioridade precisa: `QdrantCondition` vira união com `is_empty` (campo AUSENTE/null/empty — os buckets de fallback), `QdrantFilter` ganha `must_not` (com `is_empty`, "campo PRESENTE") e `should` (OR — o fallback que é ausente OU o literal).
  - `facetValues(field, {filter?, limit?})` — o `POST /facet` do Qdrant: GROUP BY + contagem exata por valor, uma ida de rede. Qdrant exige índice de payload no campo; no primeiro erro o store PROVISIONA o índice `keyword` e repete o facet exatamente uma vez — a primeira chamada numa coleção nova paga o índice, as demais são facet puro. Sem `facet` no client injetado, o erro diz isso nominalmente; sem `createPayloadIndex`, o erro original do server propaga (nada de degradação silenciosa).
  - `countChunks({filter?})` — o agregado por trás de linhas como "chunks sem chave nenhuma", sem enumeration.
  - `scrollChunks({filter?, payloadKeys?, pageSize?, maxPages?})` — pagina os CHUNKS com o mesmo filtro raw do facet, vetor nunca atravessa o fio. Diferente de `listDocuments`: é por chunk e fala o filtro cru — existe para inspeção/deleção, onde o chamador conhece o payload que ele mesmo gravou.
  - `delete` no shim aceita `points` (lista de ids de ponto), como o client real já aceita — apagar "o que a agregação contou" sem reapresentar filtro.
  
  **Não-quebrante por construção:** nada disso toca o `VectorStore` SPI — são capacidades concretas do `QdrantStore` (como `ensureCollection`), e os dois métodos novos do client shim são `OPTIONAL` (o mesmo padrão de `setPayload?`/`count?`), então host com client escrito à mão continua compilando.
  
  **Validado contra Qdrant vivo** (`rag-qdrant-live.spec.ts`, gate `AGENT_QDRANT_URL`): o auto-provisionamento do índice acontece de verdade no server, `is_empty` cobre ausente e null, `must_not: [is_empty]` é presença, e o facet com `filter` honra a prioridade da cadeia (chunk com `numeroProcesso` E `examId` só conta no primeiro). O fake grava as chamadas e cobre as paths de erro (client sem capacidade, erro persistente sem retry infinito, cursor com `maxPages`).

## 0.28.0

### Minor Changes

- [#98](https://github.com/DavideCarvalho/adonis-agora-agent/pull/98) [`252527a`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/252527a930817dd29a811e240add144d71d0daf9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - O gasto de embedding (RAG) passa a chegar ao ledger e à cota
  
  Era o único gasto que este pacote não conseguia enxergar. `EmbeddingProvider.embed` devolvia só vetores — sem contagem de tokens, sem `recordUsage` —, então nada de RAG chegava ao ledger. E como a cota diária SOMA o ledger sem filtrar propósito, também não chegava à cota.
  
  O efeito prático: um agente com retrieval em modo inject embeda a pergunta do usuário em TODA pergunta, gastando tokens que o painel jurava não existir. Isso é pior do que não medir — é medir para baixo, justamente na conta que decide quando barrar alguém.
  
  Agora o loop grava uma linha com `purpose: 'embedding'` para o embedding da consulta, dentro de um `hooks.step` (uma retomada durable não pode cobrar duas vezes pelo mesmo embedding).
  
  **A capacidade é OPCIONAL nos dois níveis, e isso é o que mantém a mudança não-quebrante:**
  
  - `EmbeddingProvider` ganha `embedWithUsage?`, ao lado do `embed` de sempre;
  - `Retriever` ganha `retrieveWithUsage?`, que o loop prefere quando existe.
  
  Um provider ou retriever escrito antes disto continua funcionando sem mudar uma linha — simplesmente não produz linha de embedding. O runtime NUNCA inventa uma contagem que não recebeu, pelo mesmo motivo que não inventa custo: um número fabricado é pior que um ausente.
  
  **Ingestão é outro caso, e ficou de fora de propósito.** Indexação em lote não acontece dentro de conversa nenhuma, e `agent_token_usage.thread_id` é NOT NULL com FK para as threads — gravar exigiria afrouxar essa FK, que é decisão de esquema e não cabe num callback de ingestão. Então `ingestChunks` expõe o consumo do lote por um `onUsage`, para o host contabilizar como preferir. Observável em vez de invisível, que é o meio-passo honesto.
  
  **ATENÇÃO ao subir:** quem usa retrieval em modo inject vai ver os atores baterem na cota mais cedo. Nada ficou mais caro — o gasto sempre existiu e agora é contado. Se isso derrubar usuário real, o certo é subir o limite deliberadamente, e não tratar o número antigo (menor) como se fosse o verdadeiro.

## 0.27.0

### Minor Changes

- [#96](https://github.com/DavideCarvalho/adonis-agora-agent/pull/96) [`8974b25`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/8974b2526b19b1efe1b6d824d34d180bee1169cc) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - O custo volta a aparecer quando o provider reporta um snapshot datado, e os preços podem vir do models.dev
  
  O ledger guarda o modelo que o PROVIDER reporta e a tabela de preço guarda o que o OPERADOR digitou. A OpenAI responde um pedido de `gpt-4o-mini` com `gpt-4o-mini-2024-07-18`, e toda tabela de preço publicada — e todo exemplo desta doc — usa o alias. Casados por igualdade crua num `Map.get`, os dois nunca se encontravam: o fold errava nos DOIS lados (`agent-loop` gravando `costUsd: null`, e o read-model devolvendo `0`), e o dashboard imprimia `$0.00` ao lado de um consumo real de tokens.
  
  Pior num deploy sem gateway: `agent_token_usage.cost_usd` só é preenchido a partir de custo reportado por gateway, então quem fala direto com a OpenAI não tinha nenhum valor persistido de reserva — o casamento em tempo de leitura era a resposta inteira, e ele falhava para zero.
  
  `resolveModelPrice` resolve o id reportado até o alias: id exato primeiro, depois sem o prefixo de rota (`openai/`, `bedrock/us.anthropic.`), depois sem o sufixo de data (`-2024-07-18`, `-20241022`). Só sufixos com FORMA DE DATA são descascados — um `-002` pode ser outro modelo com outro preço, e precificar errado em silêncio é pior do que não precificar. O id exato sempre ganha, então quem precifica um snapshot de propósito mantém isso.
  
  `seedPricesFromModelsDev(store, ['openai/gpt-4o-mini'])` preenche a tabela a partir do catálogo aberto do [models.dev](https://models.dev), em vez de números copiados à mão de uma tabela de preços. O prefixo `<provider>/` é obrigatório: o mesmo nome de modelo existe em provedores diferentes com preços diferentes, e adivinhar ali seria adivinhar uma conta. Modelo ausente do catálogo, ou sem preço publicado, é ERRO — nada é gravado se algum não resolveu, porque um seed parcial deixaria metade da conta certa e metade zerada.
  
  Nenhuma mudança de comportamento para quem já casava exato.

## 0.26.1

### Patch Changes

- [#94](https://github.com/DavideCarvalho/adonis-agora-agent/pull/94) [`d44a94e`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/d44a94e9c6fc0221450649c56970a83306b8c78f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - As ferramentas de delegação (`ask_<agente>`) falhavam 100% das vezes.
  
  O `delegateInputSchema` é um Standard Schema escrito à mão, sem a extensão
  `jsonSchema`. O bridge do SDK só deriva a forma dos parâmetros de um Zod ou dessa
  extensão — qualquer outra coisa degrada para `{ type: 'object', properties: {} }`, que
  diz ao modelo que **a ferramenta não tem argumentos**.
  
  O laço era imperdível: o modelo via uma ferramenta sem parâmetros, mandava `{}`
  (corretamente, dado o que lhe informaram) e a chamada era recusada contra um `validate`
  que exige `{ task: string }`. Numa instalação real, quatro ferramentas de delegação com
  **121 chamadas e 121 falhas cada** — queimando a cota diária inteira do usuário em
  retentativas de algo que ele não tinha como acertar. O `QuotaExceededError` que aparecia
  no fim era a consequência, não a causa.
  
  Agora o schema publica `jsonSchema.input` com `task` obrigatório. O `validate` segue sendo
  a autoridade; a extensão é o mesmo contrato na única forma que o modelo enxerga.

## 0.26.0

### Minor Changes

- [#90](https://github.com/DavideCarvalho/adonis-agora-agent/pull/90) [`c540ed5`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/c540ed5884d8dc2ad4a22c0f29f9ec9c68ace6be) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Governance console: a refused request now gets a real page instead of `{"error":"forbidden"}`.
  
  Opening the console without permission used to answer the browser with JSON. Both providers
  (the embedded `@adonis-agora/agent/dashboard_provider` and the standalone
  `@adonis-agora/agent-dashboard`) now serve a built-in access-denied page in the console's own
  visual language — the status, a sentence explaining the refusal and a "Back to app" link.
  Statuses are unchanged (`401` when no actor resolves, `403` when `authorize` denies), and a
  redirect written by `onUnauthenticated`/`authorize` still wins.
  
  The page carries no inline `<script>`, so a nonce'd `script-src` CSP cannot break it; its inline
  `<style>` takes `@adonisjs/shield`'s request nonce when one exists.
  
  New `dashboard.accessDenied` option on `config/agent.ts` to customise it — an object (`brand`,
  `title`, `message`, `homeHref`, `accent`, labels) to tweak the built-in page, or a function
  `(info, ctx) => html | void` to render it yourself or redirect. `@adonis-agora/agent/dashboard`
  exports the shared `answerDashboardDenial` + `renderAccessDeniedPage`.

## 0.25.5

### Patch Changes

- [#86](https://github.com/DavideCarvalho/adonis-agora-agent/pull/86) [`98b9c4f`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/98b9c4f97c1a04dd58bde67346cc194ef07a8e5f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Dashboard: every API request 404 under a nonce CSP — fixed.
  
  The providers used to hand the SPA the agent API base as an inline `<script>` setting
  `window.__AGENT_DASHBOARD_BASE__`. A host with `script-src 'self' 'nonce-…'` (`@adonisjs/shield`'s
  `@nonce`, the recommended setup) drops that script silently; the SPA then derived a base from its
  own URL, which is right only for the default `<agent>/dashboard` mount, and on any other every
  request from a console that rendered perfectly well answered 404. `injectApiBase` now emits a
  `<script type="application/json">` data block, which is never executed and so cannot be refused,
  and `resolveApiBase` reads it first (the global is still honoured after it). Nothing to change on
  the host.

## 0.25.4

### Patch Changes

- [#84](https://github.com/DavideCarvalho/adonis-agora-agent/pull/84) [`1f71789`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/1f71789d1d6d6a0e15f6c67ca0b51dc375de79a0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Accept `@adonisjs/redis` 10 as a peer (`^9.2 || ^10`) for the redis stream client and token
  sink. Nothing narrows; the suite runs against the new major.

## 0.25.3

### Patch Changes

- [#82](https://github.com/DavideCarvalho/adonis-agora-agent/pull/82) [`59be4e9`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/59be4e9943b47d79ce5f006c1d24b9b39e052f84) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add TanStack Intent agent skills. Both packages now ship a `skills/` directory
  (five skills under @adonis-agora/agent: setup, tools, governance, personas &
  multi-agent delegation, offline testing; one under @adonis-agora/agent-dashboard:
  the governance console client) that coding agents can load as structured,
  verified documentation. The directories are included in each package's `files`
  allowlist, and `@tanstack/intent` is added as a devDependency so CI can enforce
  skill validity via `intent validate`.

## 0.25.2

### Patch Changes

- [#79](https://github.com/DavideCarvalho/adonis-agora-agent/pull/79) [`88018eb`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/88018ebfeef32be65c464b075d692b62a369d3fd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix `node ace configure @adonis-agora/agent`, which was broken in every published version.

  The configure codemod runs each stub through Tempura, which compiles the stub **body** into a JavaScript
  template literal. A bare backtick in the body closes that literal; a bare `${` opens an interpolation.
  All four published stubs were full of both, in ordinary JSDoc prose — `` `lucid` ``, `` `model` ``,
  `` `${documentId}#<n>` `` — so every one of them threw at render time.

  `configure` therefore aborted on the very first stub, _after_ `updateRcFile` had already succeeded. The
  result was worse than nothing happening: `adonisrc.ts` came out referencing the agent and dashboard
  providers while `config/agent.ts` was never written, leaving an app that could not boot.

  Both constructs are now backslash-escaped in the stub bodies (`` \` ``, `\${`). This is a render-time
  concern only — the generated files are **byte-identical** to what the stubs always intended, backticked
  prose and all, which was verified against the pre-fix sources.

  The reason no gate caught this: every stub harness here rendered by stripping the `{{{ }}}` header with a
  regex and using the remainder, which is not what the generator does. A gate that renders differently from
  the generator is not testing the generator. All of them now render through the real engine
  (`app.stubs.create().build().prepare()`), and a new `stub-render.spec.ts` asserts that every stub
  `configure.ts` publishes actually renders — including the two config stubs, which no test had touched.

  Users on an earlier version who ran `configure` and saw it fail should re-run it after upgrading; if
  `adonisrc.ts` already lists the providers, the codemod is idempotent and only the missing files are written.

## 0.25.1

### Patch Changes

- [#77](https://github.com/DavideCarvalho/adonis-agora-agent/pull/77) [`4647d45`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/4647d45db1e23416a96e971de5c7ce6eda239558) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix the published migration, which did not type-check in a consumer app.

  `create_agent_tables` passes `db.connection(this.db.connectionName)` — a `QueryClientContract` — into
  `createAgentTables`, whose parameter was typed `LucidDatabaseLike`. That interface declared
  `rawQuery(sql, bindings?: unknown[])`, and `unknown[]` is assignable in **neither** direction to
  Lucid's `RawQueryBindings` (`StrictValues[] | { [key: string]: StrictValues }`): not inward, because
  `unknown` is not a `StrictValues`; not outward, because the named-bindings object is not an array. A
  method parameter is checked bivariantly, so failing both directions failed the check outright. Only
  the `Database` manager satisfied the interface, since its own `bindings` is `any`.

  So `node ace configure @adonis-agora/agent` produced a migration that threw `TS2345` under an app's
  `tsc`. `create_agent_rag_chunks` broke identically.

  The bindings type is now `readonly unknown[] | Record<string, unknown>` — a supertype of
  `RawQueryBindings`, so every real Lucid client matches while the interface stays structural and
  `@adonisjs/lucid` stays an optional peer. The schema helpers, `PgVectorStore`, and the SQL data
  satellite now take a new, narrower `LucidRawRunner` (just `rawQuery`), which is all any of them
  actually use — asking for less is what lets a per-connection client qualify at all.

  This keeps `migration:run --connection=x` working. The workaround of passing the bare `Database`
  manager compiles but always provisions the default connection.

  New exported types: `LucidRawRunner`, `LucidRawBindings`. `LucidDatabaseLike` is unchanged in
  capability (it now extends `LucidRawRunner`) and still exported.

## 0.25.0

### Minor Changes

- [#74](https://github.com/DavideCarvalho/adonis-agora-agent/pull/74) [`9776fdc`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/9776fdce96ab283f76bb24c6a31610e9ea91e17d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix the published migration, which threw against any database the library had already provisioned.

  `node ace configure @adonis-agora/agent` published `create_agent_tables` as raw DDL —
  `this.schema.createTable('agent_thread', ...)` with no existence guard. But `autoCreateTables`
  defaults to `true`, and the first use of any of the three stores that share those tables (the agent
  store, the pricing store, the governance read-model) provisions them. So in any app that had run the
  agent even once before migrating, `node ace migration:run` died with `table "agent_thread" already
exists`. Reported from a real consumer upgrade.

  The stub now delegates to `createAgentTables` / `dropAgentTables` instead of reproducing the DDL, with
  `disableTransactions = true` (the helper takes its own pooled connection, which would otherwise
  deadlock against `pool: { max: 1 }`). Drift stops being something to test for and becomes impossible:
  the migration and the auto-created schema are the same code.

  The separate `create_agent_run_tracking` stub is gone — one schema, one migration. Its `run_id` columns
  were already inline in the table DDL for a fresh database, and `createAgentTables` now also ALTERs them
  into a database provisioned before run tracking shipped, so collapsing the two loses no upgrade path.
  That repair also fixes `autoCreateTables` on such a database, where the missing columns were previously
  never added at all.

  `create_agent_rag_chunks` had the same unguarded `createTable`; it now provisions through
  `PgVectorStore.ensureSchema()`.

  `createAgentTables` now resolves to the list of repairs it applied (it returned nothing before). Callers that only `await` it are unaffected.

  **No action needed.** Migrations you have already run stay applied; this only changes what `configure`
  generates from here on. If your `migration:run` was failing, re-run `node ace configure` and delete the
  old `create_agent_tables` / `create_agent_run_tracking` files it had published.

## 0.24.0

### Minor Changes

- [#71](https://github.com/DavideCarvalho/adonis-agora-agent/pull/71) [`24c8d6f`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/24c8d6f81da6fc335ec96e4154f36a22ad762a8a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Delegation is authorizable, the actor directory is consumed, and `dashboard` is part of the typed config.

  - **`delegatesTo` accepts an object edge.** A synthesized `ask_<target>` tool goes through the same
    `RolesPolicy` gate as any other tool, and a bare-string edge carries neither `roles` nor `ability` —
    which is ADMIN-only under `DefaultToolAuthorizer` and an outright deny under `authzToolAuthorizer`,
    so delegation was unreachable under authz with no way to open it. `delegatesTo` now also takes
    `{ agent, roles?, ability? }` (`DelegateEdge`), whose annotation lands on the synthesized spec. Bare
    strings keep their existing fail-closed behaviour.
  - **`ActorDirectory.resolveDisplay` is now called.** `actorDirectory` resolved into a provider field
    that was never read, so governance surfaces always rendered raw refs. Every governance route
    returning an `actorRef` now carries an optional `actorLabel`, filled from one batched directory
    lookup per page and omitted for unknown refs. Fail-soft: an unbound or throwing directory leaves the
    rows exactly as the read-model produced them.
  - **`AgentConfig.dashboard` is typed.** The console's config block was read through an untyped
    `config.get('agent.dashboard')` string path, so writing it inside `defineConfig({ ... })` was an
    excess-property error. It is now a declared `AgentConfig` field and the provider reads it off the
    typed config.
  - **`engines.node` is a range again.** Both packages published an exact version (`v22.23.2` /
    `v26.7.0`), which warns on install for every consumer on any other Node and hard-fails under
    `engine-strict`. Renovate's global `rangeStrategy: "pin"` had rewritten the ranges; `engines` is now
    excluded from pinning so it cannot happen again.
  - JSDoc: the published source carried Portuguese doc comments (`sse.ts`, `spi/tool.ts`, `base-tool.ts`,
    `stores/factory.ts`, `rag/qdrant-store.ts`, `ai-tool-ref.ts`) — translated to English. Corrected the
    stale cost formula on `AgentGovernanceQueries` (it omitted the cache-token split), the attachment
    allow-list default (an exact-match list of 7 types, not `text/*`), and two NestJS-era references.

## 0.23.0

### Minor Changes

- [`3504f37`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/3504f37de4e063b5839388b684c63a0ab2ff5efa) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The dashboard gate now honors a redirect the host already wrote to the response instead of always overwriting it with the default `401`/`403 { error }` JSON — mirrors `@adonis-agora/durable`'s dashboard guard, and `@adonis-agora/telescope`'s guard gains the same escape hatch in a companion release.

  - **`authorize` denies (403)**: redirect from inside `authorize` (e.g. `ctx.response.redirect('/acesso-negado')`) and return `false` — the gate detects the `location` header and skips its own JSON write. No API change; this always worked as a predicate, only the response-writing layer changed.
  - **The actor resolver itself rejects the caller (401)** — no resolver configured, or `resolve(ctx)` threw (e.g. `AuthActorResolver` on an anonymous request) — is a case `authorize` never sees, since there's no resolved actor to hand it. New optional `dashboard.onUnauthenticated?: (ctx) => void | Promise<void>` runs there instead, ctx-only (never a fabricated actor, preserving the resolver's "no identity is invented" contract): redirect inside it the same way to replace the default JSON, or leave the response untouched to keep it.

  ```ts
  // config/agent.ts
  dashboard: {
    authorize: (actor, ctx) => {
      if (isAdmin(actor)) return true
      ctx.response.redirect('/acesso-negado')
      return false
    },
    onUnauthenticated: (ctx) => {
      ctx.response.redirect('/login')
    },
  }
  ```

## 0.22.2

### Patch Changes

- [`a1fd42f`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/a1fd42f2cf6d4fd206ea99f195202a85618295f9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stops leaking internal exception messages (`AuthActorResolver`'s "no authenticated user on ctx.auth.user...", or whatever `authorize`/`governanceAuthorize` happens to throw) to the client on the dashboard's `401`/`403` responses and on the `/agent/governance/*` and per-actor route `401`s — they now reply with a generic `'unauthorized'`/`'forbidden'`, matching `@adonis-agora/durable`'s dashboard convention of a uniform message on every credential failure, instead of exposing detail meant for the developer wiring the config to an untrusted, possibly anonymous caller.

  The detail isn't gone — `evaluateDashboardGate`/`evaluateGovernanceGate` gained a `debug` parameter (default `false`), and the providers pass `!app.inProduction`, so local/dev boots keep seeing the real message while diagnosing a misconfiguration.

  `evaluateDashboardGate`'s "no actor resolver configured" `401` is unaffected — that's a static config error, identical for every caller and not per-request, so it stays visible even in production.

## 0.22.1

### Patch Changes

- [`f0a622a`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/f0a622aeadec938355f9b5f5f515e335b406e712) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Republishes with the updated `agent-dashboard` embed (`packages/adonis/dist/assets/spa`, copied at build time from `@adonis-agora/agent-dashboard`'s own `dist/spa`) — the console's visual-identity fix from `ce1d08f` (dark-by-default, Aviary token/font/radius parity) has no effect on hosts until this package is rebuilt and republished, since it embeds the dashboard's built assets rather than depending on it at runtime. No source change in `packages/adonis` itself.

## 0.22.0

### Minor Changes

- [`079da35`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/079da35e91f1eab93020212bb93686eaa8dd9bee) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ported the Nest ("Aviary") telescope extension's governance and RAG coverage onto `@adonis-agora/agent/telescope`, alongside the existing entry-backed providers:

  - **Governance-backed providers** (`agent-governance-providers.ts`): spend by model/actor, usage trend, run reliability (total/success-rate/failed/avg-duration/by-agent/trend), recent runs/tool-calls/threads, and the pending-approvals inbox — reading the SAME `AgentGovernanceQueries` read-model the `/agent/governance/*` routes and the standalone dashboard SPA already use, via a new package-internal registry `AgentProvider#boot()` populates (`src/telescope/governance-registry.ts`). Several Nest-reference panels have no equivalent on this SPI and are deliberately not ported — top-threads-by-cost, run retries, run duration percentiles, error-code breakdowns, and paged tool-calls/threads/runs tables — see that file's header for the full list and why.
  - **RAG providers** (`rag-data-providers.ts`): retrieval count, zero-hit rate, mean chunk count, and a retrievals/zero-hits trend, read off the `retrieved` diagnostic event `agent-loop.ts`'s inject-mode retrieval already publishes. Latency, score distribution, and store/collection breakdowns are NOT ported — the recorded event carries none of that data today; see that file's header for what widening the instrumentation would need.
  - **Host extensibility**: `agentTelescopeExtension({ providers, sections })` lets a host app append its own data providers and dashboard sections, mirroring the Nest reference (with the same `agent.`-prefix reservation on host providers).
  - The "Agent" dashboard gained four new sections (Spend & usage, Spend detail, Run reliability, Governance activity, RAG) binding to the above.

  No watcher and no dedicated `agent`/`agent-rag` entry types are contributed — confirmed against `@adonis-agora/telescope`'s current `TelescopeExtension` contract, which has no `watchers` hook and gives every `agora:agent:*` event the same generic `diagnostic` entry type. That's a real, documented SDK constraint (see `extension.ts`'s header), not an oversight: RAG and every other agent event share one capped `lib:agent` window as a result.

## 0.21.0

### Minor Changes

- [`58783fb`](https://github.com/DavideCarvalho/adonis-agora-agent/commit/58783fb433fd3c641dc9a42b80eaba09f2c9a62b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `@adonis-agora/agent` now ships its own governance dashboard — `node ace configure @adonis-agora/agent` registers an embedded `dashboard_provider` that serves the `@adonis-agora/agent-dashboard` SPA straight out of `@adonis-agora/agent`'s own build (`../dashboard/dist/spa` is copied into `dist/assets/spa` at build time), so a new app needs no separate install or provider registration to get the console. Configure it via the same optional `config('agent').dashboard` block as before.

  This is purely additive: the standalone `@adonis-agora/agent-dashboard` package and its own `agent_dashboard_provider` keep working exactly as before for apps that already install and register it directly — both providers now share one implementation (`@adonis-agora/agent/dashboard`, a new subpath export) so their behavior is byte-for-byte identical. Register only one of the two in a given app; mounting both at the same path throws AdonisJS's "duplicate route" error at boot.

  `@adonis-agora/agent-dashboard`'s peer dependency floor on `@adonis-agora/agent` moves to `>=0.21.0` (the version that introduces the shared `@adonis-agora/agent/dashboard` export its provider now imports from); already-published `agent-dashboard` versions are unaffected.

## 0.20.0

### Minor Changes

- [`4e3a372`](https://github.com/DavideCarvalho/adonis-agent/commit/4e3a372e9ecf53ec4c34bbe31ab6177262b0dcd5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `GET`/`POST /agent/governance/pricing` and a Pricing panel in the console.

  The `pricingStore` bound to the agent (default-mirrored from a Lucid `store`, or opt-in for other
  backends) was already driving cost accounting for runs, but had no read/write surface of its own —
  operators had to reach for the database directly to see or change a model's per-1M-token rates. The
  two new routes expose `AgentPricingStore.listCurrentPrices()`/`upsertModelPrice()` behind the same
  authenticated + authorized governance gate as every other `/agent/governance/*` route, mounted only
  when a pricing store is bound. The dashboard's new "Pricing" section reads and edits rates through
  them.

- [`4e3a372`](https://github.com/DavideCarvalho/adonis-agent/commit/4e3a372e9ecf53ec4c34bbe31ab6177262b0dcd5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add a thread governance drill-down: `GET /agent/governance/threads/:id` and a `ThreadDetailView` you
  reach by clicking a row in the console's Recent threads table.

  `AgentGovernanceQueries` gets a new optional `threadDetail(threadId)` method returning the thread's
  metadata plus a lifetime usage rollup (total tokens, cost, run/message counts) and its most recent
  runs/messages — implemented in both `LucidGovernanceQueries` and `InMemoryGovernanceQueries`. It's
  optional so a third-party or pre-existing adapter that predates it doesn't break: the route responds
  `501` instead of the dashboard hitting a missing endpoint.

  The Recent threads and Tool calls panels also gain "Load more" pagination instead of a fixed row cap.

- [`4e3a372`](https://github.com/DavideCarvalho/adonis-agent/commit/4e3a372e9ecf53ec4c34bbe31ab6177262b0dcd5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `RunReliability` (from `GET /agent/governance/reliability`) gains two optional fields: `byAgent` (run
  and failure counts per agent, highest call count first) and `trend` (daily run/failure counts over the
  same range, oldest first) — implemented in both `LucidGovernanceQueries` and
  `InMemoryGovernanceQueries`. Both are optional so an adapter that predates them can keep returning the
  existing shape; the dashboard's Reliability section renders a trend chart and a by-agent breakdown when
  present and stays as before when absent.

## 0.19.1

### Patch Changes

- [`3377419`](https://github.com/DavideCarvalho/adonis-agent/commit/3377419676511876522258d6156ccf79a7b302a0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Type the MCP actor on `AuthInfo.extra`: the `authKitAuth()`/`apiKeyAuth()` strategies now return a typed `McpAuthInfo` (`extra: { actor: Actor }`), and `actorFromAuthInfo`/`isActor` are exported from `@adonis-agora/agent/mcp` so consumers no longer hand-roll a runtime guard. The MCP provider reuses the promoted helpers instead of its module-local copies.

## 0.19.0

### Minor Changes

- [`9a91190`](https://github.com/DavideCarvalho/adonis-agent/commit/9a91190936f24f912ccb756c58f490381f2b13c7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add an MCP (Model Context Protocol) endpoint that exposes the agent's ToolRegistry over Streamable
  HTTP.

  - New `./mcp` subpath: `defineMcpConfig`, `createMcpServer`, and two auth strategies — `authKitAuth()`
    (OAuth OIDC via `@adonis-agora/authkit-server`, resolved lazily) and `apiKeyAuth()` (constant-time
    key compare). The acting `Actor` resolves from the verified auth and gates `tools/list` /
    `tools/call` through the same role-checked registry the agent loop uses (fail-closed).
  - New `./mcp_provider` subpath: an Adonis provider that mounts `POST|GET|DELETE /mcp` plus
    `GET /.well-known/oauth-protected-resource/mcp` (RFC 9728 metadata when OAuth is configured), with
    per-session Streamable HTTP transports.
  - `configure` publishes `config/mcp.ts` via the new `config/mcp.stub`.

  The published `dist` ships `./mcp` and `./mcp_provider` export maps (mirroring `./agent_provider`).

## 0.18.0

### Minor Changes

- [`634c2df`](https://github.com/DavideCarvalho/adonis-agent/commit/634c2df384e90df85014d0ddb8e9c2215bb4c7b1) - **Security fix**: the cross-actor `/agent/governance/*` read-model is no longer mounted when no `governanceAuthorize` gate is configured.

  Previously these routes mounted whenever the governance read-model resolved — which happens **by default** whenever the main store is Lucid — and the `governanceAuthorize` gate was optional. With no gate, the gate evaluated to "allow", so **every authenticated actor could read the platform-wide governance data: every actor's spend, token usage, thread activity, run traces and pending HITL approvals.** Apps that never configured a gate got this by taking the default; the library only printed a boot warning, which is not a control. If your app has ordinary end users (not just trusted staff) as resolved actors, assume this data was readable by any of them.

  The cross-actor routes now mount **only when `governanceAuthorize` is set**. Without a gate they do not exist and return `404`. Affected routes:

  `GET /agent/governance/spend/model`, `spend/actor`, `usage/trend`, `tool-calls/recent`, `threads/recent`, `runs`, `runs/:id`, `approvals/pending`, `tools/stats`, `reliability`.

  **`GET /agent/approvals/mine` is unaffected.** It keeps mounting whenever the governance read-model resolves, gate or no gate — it is always scoped to the calling actor's own pending approvals, and non-admin surfaces (e.g. a chat page polling for its own suspended tool calls) depend on it.

  Two migration paths, both in `config/agent.ts`:

  ```ts
  // 1. The intended fix — mount the routes gated (typically an ADMIN check):
  governanceAuthorize: (actor) => actor.roles?.includes('ADMIN') ?? false,

  // 2. Deliberately keep the old open behaviour — explicit, greppable, reviewable:
  governanceAuthorize: () => true,
  ```

  Boot still succeeds without a gate: the provider warns (it does not throw) and names both paths.

- [`38106a9`](https://github.com/DavideCarvalho/adonis-agent/commit/38106a9d981b770dd755a2779810e27aa2a890f6) Thanks [@claude](https://github.com/claude)! - Three RAG capabilities: metadata that can be corrected without re-embedding, enumeration and bulk deletion that don't walk the corpus document-by-document, and a chunker that can be told where the records are.

  **`updateMetadata(documentId, patch)` — change a document's metadata without paying to re-embed it.** Optional on `VectorStore`, implemented by all three shipped stores, resolving to the number of chunks written. Until now the only way to change a chunk's metadata was `upsert`, which needs the text and a fresh embedding — so a consumer whose documents get re-classified had to choose between re-embedding a whole document to change one label, or not stamping the mutable dimension onto chunks at all and resolving it at query time instead, which turns a filter the index could apply into a join the caller has to do. The second is the one people actually pick, and it is what makes an actor-derived retrieval filter unaffordable: such a filter only pays off if the dimensions it filters on are _on_ the chunks and can be corrected when they change. `patch` is a **shallow JSON Merge Patch** — `null` deletes a key (said in those words on `MetadataPatch`, because "patch" alone does not tell you whether `null` deletes or stores a null), values replaced wholesale, `undefined` ignored, absent keys left alone. Text and embeddings are untouched; on pgvector the merge happens in SQL so `SET` structurally cannot name the embedding column, and on Qdrant it goes through `set_payload`, which has no vector field at all. Verified against Postgres 17 + pgvector 0.8.5 and Qdrant 1.18 asserting the stored vector is byte-identical afterwards.

  **`listDocumentIds(filter?)` and `removeWhere(filter)` — enumerate and drop in bulk, without a document-by-document walk.** Both optional on `VectorStore`, both on all three stores. Dropping a collection used to mean `listDocuments()` — which fetches and JSON-parses a metadata blob _per chunk_ only to collapse it to one entry per document — followed by one `remove()` per document: N+1 round trips where one filtered delete would do. (The Qdrant adapter had already grown a defensive page cap on that `listDocuments` scroll, which is the tell that an enumeration API was carrying work it is not shaped for.) `listDocumentIds` skips the per-chunk metadata entirely — a `SELECT DISTINCT` on pgvector, a one-key scroll on Qdrant. `removeWhere` deletes in one filtered statement and reports how many chunks went.

  Because `removeWhere` is the only call here that destroys data, it removes **exactly what a `search` carrying the same filter could reach, and never more**: every store builds the delete predicate with the very same filter builder its `search` uses, so the two cannot drift. The empty-array deny is honoured and means "delete nothing", not "no filter". And `removeWhere({})` throws `UnsafeRemovalError` instead of wiping the store, because an empty object is far more likely to be a filter that got built wrong than a deliberate request to delete everything — deliberate mass deletion stays explicit via `remove` over `listDocumentIds()`.

  **`chunkText(text, { separator })` — cut on the record boundary instead of guessing one.** The chunker breaks on the latest paragraph/sentence/word boundary in its window, which is right for prose and wrong for text whose boundaries _mean_ something: a spreadsheet flattened to one field-labelled record per line gets cut mid-record, so the half holding the row identifier lands in a different chunk from the half holding the value and neither can answer a question about that row. Pass `separator` and it becomes the only boundary the chunker may cut on. Two consequences, documented on the option: a record longer than `chunkSize` is emitted **whole** as its own over-size chunk rather than being cut (`chunkSize` becomes a target, not a cap — falling back to a mid-record cut would defeat the point, and an over-size chunk is visible where a mangled record is not), and `overlap` becomes a character _budget_ spent on whole trailing records, never a partial one. Reaches `ingestDocuments` for free.

  Nothing changes for existing callers: omit `separator` and the prose path is byte-for-byte what it was — guarded by frozen boundary cases and confirmed by a differential run over 20,000 random input × option combinations, because a shifted chunk boundary silently invalidates stored embeddings and is not something a minor release may do. All three store operations are **optional** on the `VectorStore` interface, so a host-written store that implements none of them still compiles.

- [`6d0d746`](https://github.com/DavideCarvalho/adonis-agent/commit/6d0d746ebe88da5f7931059ea544a5d2b63b7679) - **Security-relevant feature**: inject-mode RAG retrieval can now be scoped per actor via the new `retrievalFilter` config option — and **without it, retrieval remains unscoped**.

  Inject-mode RAG (setting `retriever` in `config/agent.ts`) retrieves passages for the user's message and folds them into the system prompt on every turn, but had no seam through which a host could supply a filter: `retriever.retrieve(text, { topK })` was called with no `filter` and no actor, so a host could not scope it even by wrapping the retriever. Any deployment that turns on `retriever` and shares one corpus across tenants was leaking passages across tenants into the system prompt, on every turn, for every user — the write side (`rag-media` ingestion tagging `tenantRef`/`ownerId`) and the store-level `filter` support (`pgvector`/Qdrant, both correct) already existed; nothing ever populated `filter`.

  `retrievalFilter?: (actor: Actor) => Record<string, unknown>` closes that gap: it derives the same `audience`-style ACL filter documented for manual/agentic retrieval, but from the run's actor, and applies it automatically inside the existing `hooks.step('retrieve', …)` (so durable replay determinism is unaffected). With no hook configured, the retriever receives options with no `filter` key at all (not `filter: undefined`) — existing single-tenant deployments are byte-identical. A hook that throws fails the turn rather than falling back to unfiltered retrieval.

  **Action for existing multi-tenant deployments using inject mode**: set `retrievalFilter` in `config/agent.ts`. Without it, you may have been retrieving across your entire corpus regardless of who is asking. See `docs/retrieval/rag.mdx`.

  Deliberately out of scope: the `Retriever` SPI is unchanged (third-party retrievers still satisfy it unmodified), and retrieved passages are still folded into the system prompt without fencing as untrusted data — the second half of this finding, tracked separately.

### Patch Changes

- [`63b9b08`](https://github.com/DavideCarvalho/adonis-agent/commit/63b9b08caa19a092965a465612215254fbb14997) - **No published version of either package is affected.** This is a repo-tooling fix with no runtime change — nothing in `src/` moved. Checked rather than assumed: the live tarballs for `@adonis-agora/agent@0.17.0` and `@adonis-agora/agent-dashboard@0.3.2` contain 105 and 13 `.js` files respectively, exactly what a full local build emits. The release workflow publishes from a cold `actions/checkout`, which has no `dist/` and no `.tsbuildinfo` to go stale, so the defect below could not reach npm. It could reach a contributor's working copy, and did.

  `pnpm build` could exit `0` having emitted no JavaScript. `tsc` ran with `incremental: true` against a `.tsbuildinfo` that records what it already wrote to `dist/`; delete `dist/` and leave the buildinfo behind and `tsc` concludes every output is current and emits nothing. In `@adonis-agora/agent`, `copy:stubs` is a plain `cp` and ran anyway, so `dist/` came out holding four stub files and zero `.js`. Turbo then cached that empty directory as a _successful_ `build` and replayed it onto clean trees — a later `pnpm build` on a freshly wiped checkout restored the vacuum as `FULL TURBO` in 32ms. Downstream, `packages/dashboard` failed with `TS2307: Cannot find module '@adonis-agora/agent'` against the package that had just "built".

  Both packages are fixed the same way:

  - `build` removes `dist/` up front and compiles through a new `tsconfig.build.json` with `incremental: false`, so an emit is always a full emit and no state survives to disagree with `dist/`.
  - A new `scripts/assert-build-output.mjs` runs as the last step of `build` and fails it if `dist/` holds no JavaScript or is missing the package entrypoint. It runs inside the build, so it also covers `prepack` — which never goes through turbo, and is the path a manual `pnpm publish` would take.
  - `build` and `typecheck` no longer share a buildinfo. `typecheck` keeps `.typecheck.tsbuildinfo`; `build` keeps none at all. `turbo.json` is unchanged.

  If you have a checkout in the broken state, the guard now prints the way out — and the command it prints works, which took a second pass to get right: the buildinfo files are dotfiles and a shell `*` does not match those.

  ```
  rm -rf dist .*tsbuildinfo *.tsbuildinfo
  pnpm run build
  ```

  The dashboard's exposure needed a different guard. Its `build` is `vite build && tsc`, and vite keeps populating `dist/spa/` whatever `tsc` does — a `dist/` with no provider in it still holds a dozen `.js` files. Counting JavaScript would have passed it, so `check:dist` there asserts the entrypoint by name.

  Neither a count nor a named entrypoint is enough on its own. A _partial_ emit was observed during this fix: `dist/` came out holding exactly one `.js`, `src/index.js`, which satisfies both checks — and because `index.d.ts` was there too, the dashboard compiled against it without a single `TS2307`. Every subpath export (`@adonis-agora/agent/rag-media`, `/durable`, `/testing`, …) pointed at a file that did not exist, and the first thing to notice would have been a consumer's failed import. So the guard also walks `package.json`'s `exports` and requires every target it declares. That list is the package's real publish contract, and it maintains itself — adding an export adds a post-condition, with nobody having to remember. It also covers `@adonis-agora/agent-dashboard/client`, which the by-name check never looked at.

- [`fa39b5f`](https://github.com/DavideCarvalho/adonis-agent/commit/fa39b5faef317fb47cf1fbb8fe29cec448270d21) - **If your governance console suddenly 404s, or every panel in it is failing: set `governanceAuthorize` in `config/agent.ts`.**

  ```ts
  // config/agent.ts
  export default defineConfig({
    // ...
    governanceAuthorize: (actor) => actor.roles?.includes("ADMIN") ?? false,
  });
  ```

  That one line brings both the console and its data back. If you deliberately want the old behaviour where any authenticated actor could read the platform-wide governance data, say so explicitly with `governanceAuthorize: () => true` — same effect, but greppable and reviewable.

  **Why.** The cross-actor `/agent/governance/*` read routes stopped mounting without a `governanceAuthorize` gate (see the previous `@adonis-agora/agent` release). Ten of the console's eleven read endpoints are those routes, and the SPA calls them **from the browser** — so an app with the dashboard installed and no gate got a console that loaded fine and then failed on every panel except Quota, with nothing in the logs explaining it.

  **What changed.** `@adonis-agora/agent-dashboard` now refuses to mount when the agent config has no `governanceAuthorize`, and logs a boot warning naming both fixes above. The console URL returns `404` instead of serving a shell that cannot work. Nothing that still worked is broken by this: every affected app already had a console dead in six of its seven views.

  Unaffected:

  - Apps that already set `governanceAuthorize` — no change whatsoever.
  - `dashboard: { enabled: false }` — still off, still silent, no warning.
  - `dashboard.authorize` — still an optional EXTRA gate on the SPA shell, unchanged. It is deliberately not what decides whether the console mounts: it gates the shell, not the data, so an app could set it and still have a console with nothing to render.
  - `GET /agent/approvals/mine` — never behind the governance gate; still mounted and still scoped to the calling actor.

  The `@adonis-agora/agent` half of this release is documentation only: the `governanceAuthorize` JSDoc and the `governance-gate.ts` comments still described the old open-by-default behaviour they no longer have. `evaluateGovernanceGate`'s behaviour is unchanged.

- [`58177f7`](https://github.com/DavideCarvalho/adonis-agent/commit/58177f718477ecdda362b6870b25225cff391759) - **Security fix**: `agent`-kind delegate tool calls now go through the same role/ability check and allow-list filter as every other tool call, instead of executing unconditionally.

  Previously, when the model emitted a tool call for an `agent`-kind (delegation) tool, the loop called `hooks.runAgent` directly at the loop level — it never went through `ToolRegistry.invoke`, so the `policy.can(actor, spec)` re-check, the Zod input validation, and the persona/agent allow-list filter (only applied when building the offered-tools set) were all skipped. A model steered by injected content — delegate tool names are advertised in sibling delegate descriptions — could name a delegate tool it was never offered and run it regardless of the actor's role or the agent's configured allow-list. The synthesized delegate specs carry no `roles` and no `ability`, so they were meant to be unreachable by a non-privileged actor; the loop ran them anyway.

  The delegation branch now: (1) fails closed if the delegate's spec cannot be resolved; (2) verifies the tool name is in the set actually offered to the model (the same persona/agent allow-list intersection used to build the offer); (3) re-checks `rolesPolicy.can(actor, spec)`. All three checks run _before_ the tool call is persisted and before the `agent.delegated` event is published, so a denied delegation is recorded `failed` — never `auto_executed`, even transiently.

  **Behaviour change for hosts using `AuthzToolAuthorizer`**: delegate tools carry no `ability` by design. Under an authz posture, a tool with no `ability` is _always_ denied — so after this fix, delegation will be denied for any actor unless the host explicitly declares an `ability` on its delegate tools. This is not a regression: it is what an authz-backed configuration with no `ability` on these tools always meant. Hosts that rely on delegation under `AuthzToolAuthorizer` need to declare an `ability` for their delegate tools (or otherwise grant it through their policy) to keep delegation working.

- [`3627aec`](https://github.com/DavideCarvalho/adonis-agent/commit/3627aece5817f93518154133b07a29fb4068e1ff) - `node ace add @adonis-agora/agent` now actually registers the provider and publishes the config and migration stubs, instead of silently warning "the module does not export the configure hook" and doing nothing. AdonisJS resolves the configure hook by importing the package's main entry and reading `configure` off the module namespace — it never reads the `./configure` subpath. The package main now re-exports `configure` from the package root so `node ace configure` finds it.

- [`f4f3fb1`](https://github.com/DavideCarvalho/adonis-agent/commit/f4f3fb1cdd0117f5a748a3088d4fdc032d6fa7fc) - **Security fix**: `dataTool`'s tenant scoping no longer treats a tenant predicate found under an `OR` as coverage.

  `TenantScopeRewriter.collectTenantPredicates` recursed into `OR` branches exactly as it did into `AND` branches, with no record of which boolean context it was in. Any tenant predicate found anywhere in a query's `WHERE` tree — including inside an `OR` — marked that table's alias "already scoped", so the rewriter added no constraint at all. A model-authored query of the form `... WHERE base_id = '<own tenant>' OR 1 = 1` (or any other disjunctive shape naming the caller's own tenant) passed through unconstrained and returned every tenant's rows from an allow-listed table.

  Coverage is now computed from the top-level `AND` spine only (`collectConjunctiveTenantPredicates`): a predicate under an `OR`, `NOT`, or any non-conjunctive operator no longer suppresses the AND-ed tenant constraint. The **mismatch rejection** is unchanged and deliberately still walks the _whole_ tree (`collectAllTenantPredicates`): a query naming a foreign tenant anywhere — even inside an `OR` — still throws `tenant scope: tenant mismatch`, rather than being silently AND-ed down to zero rows.

  **Behaviour change**: queries that previously passed through unconstrained because of an `OR`-side tenant predicate (e.g. `WHERE base_id = 'mine' OR 1 = 1`, `WHERE (base_id = 'mine' AND x) OR y`) are now correctly constrained — the emitted SQL gains an additional `AND <tenantColumn> = '<tenantRef>'`. A query whose tenant predicate is already on the top-level `AND` spine is unaffected (no duplicate predicate is added).

  A second, adjacent bug was found and fixed while implementing this: `andCondition` built the AND-tenant-predicate AST node without marking the pre-existing (possibly `OR`-rooted) `WHERE` as parenthesized. `node-sql-parser`'s printer only wraps a subexpression in `(...)` when a `parentheses` flag is explicitly set on it — without it, `AND`/`OR` print at the same precedence, left-to-right, so a real database (which applies standard SQL precedence, `AND` binding tighter than `OR`) would have misread the emitted text and applied the tenant constraint to only the last disjunct, silently re-opening the same bypass this fix closes. `andCondition` now always parenthesizes the existing WHERE before AND-ing.

- [`258e322`](https://github.com/DavideCarvalho/adonis-agent/commit/258e322c8454020f52d110b328514ff5478c1a60) - Delegation now applies the input-schema gate, closing the last of the three gates `ToolRegistry.invoke` applies.

  `invoke` gates every tool call on (1) the role/ability check, (2) input validation against `spec.inputSchema`, then (3) execution. `agent`-kind (delegate) calls are handled at the loop level and deliberately bypass `invoke` — the durable runner maps them to `ctx.child`, a ctx-level suspend point. The previous fix re-applied the role and allow-list gates to that branch but not the input gate, so a malformed delegate input was silently coerced instead of rejected: `extractTask` fell back to `JSON.stringify(input)`, and a model emitting `{ task: { nested: 1 } }` or `{ tsak: '...' }` delegated a JSON blob as the task string. Every other tool kind rejects that with `ToolInputInvalidError`.

  The delegation branch now validates `call.input` against the delegate spec's `inputSchema` and throws the same `ToolInputInvalidError`, after the role and allow-list checks so the ordering matches `invoke` (authorization first, then shape). The task handed to the target agent is derived from the validated value rather than the raw input. A rejected input lands in the existing `try/catch`, so it is recorded `failed` and never emits `agent.delegated`.

  This only rejects inputs that were previously mis-coerced; no public signature changes.

- [`c78c0f4`](https://github.com/DavideCarvalho/adonis-agent/commit/c78c0f4a1897f7aab5caf3ceb7857927dde934a6) - The optional `@adonis-agora/*` peer ranges (`authz`, `diagnostics`, `durable`, `telescope`) no longer point at a single already-superseded minor. On a `0.x` package `^0.x.y` means "this exact minor only," so every sibling minor bump silently made these ranges unsatisfiable against what's published on npm — a consumer installing any current sibling version got an `ERESOLVE`/warning wall. Ranges now use `>=<floor> <1.0.0`, matching the pattern already used by `agent-dashboard`'s peer on `agent` and `authz-react`'s peer on `authz`. The floor for each is the version this package was actually verified against (the one the dev install had resolved), not the current published version:

  - `@adonis-agora/authz`: `>=0.4.2 <1.0.0`
  - `@adonis-agora/diagnostics`: `>=0.1.0 <1.0.0`
  - `@adonis-agora/durable`: `>=0.8.0 <1.0.0`
  - `@adonis-agora/telescope`: `>=0.4.0 <1.0.0`

  The matching devDependencies were bumped to the current published versions (durable 0.20.0, telescope 0.6.0, authz 0.10.1, diagnostics 0.2.5) so this repo's typecheck and test suite actually run against current sibling APIs instead of many minors behind. No source changes were required — the integration code under `durable/`, `telescope/`, `authz/` and `diagnostics.ts` typechecked and passed its tests unchanged against the newer siblings.

## 0.17.0

### Minor Changes

- [#36](https://github.com/DavideCarvalho/adonis-agent/pull/36) [`0c3c1c0`](https://github.com/DavideCarvalho/adonis-agent/commit/0c3c1c01e52d588c9aaaae8d2467999937233687) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `QdrantStore.upsert` agora fatia os pontos em lotes (novo `upsertBatchSize`, default 100) em vez de um único request. Fontes grandes viram muitos chunks (ex.: PDF de ~200 páginas → ~700 pontos); enviar tudo num request só estourava o timeout default de 300s do `@qdrant/js-client-rest` (`QdrantClientTimeoutError: This operation was aborted`). Batchar mantém cada request pequeno e previsível — ingestão robusta pra qualquer tamanho de fonte.

## 0.16.0

### Minor Changes

- [#34](https://github.com/DavideCarvalho/adonis-agent/pull/34) [`5afc7e5`](https://github.com/DavideCarvalho/adonis-agent/commit/5afc7e5cab6de57abc8662e70fc4c72476015c96) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Adiciona um backend Qdrant (`QdrantStore implements VectorStore`) ao lado do pgvector, com a factory `retrievers.qdrant({ embedder, url, apiKey, collection, dimension, metric })`. O `@qdrant/js-client-rest` é peer dependency opcional (import lazy). Contratos `Passage`/`VectorStore` inalterados; uma collection só com filtro de payload (a mesma semântica de ACL por token do pgvector), id de chunk mapeado para UUIDv5 no ponto.

## 0.15.0

### Minor Changes

- Tool discovery now runs after `app.booted()` instead of during the provider's `boot()`. This lets `app/agent_tools` files use ordinary top-level imports of Adonis service singletons (e.g. `@adonisjs/lucid/services/db`) without the import throwing during boot (which, in a pruned production build, surfaced as `Cannot read properties of undefined (reading 'booted')` and left the tool missing). The tool registry is populated before the HTTP server accepts traffic, so no behavior changes for consumers.

## 0.14.0

### Minor Changes

- Add `RetrieveOptions.minScore` — a relevance floor applied to vector-store retrieval (passages with `score < minScore` are dropped before the top-K cut), enabling strict-grounding RAG. Also add per-agent `AgentDefinition.actorResolver`, letting an individual agent resolve its request actor differently from the global `config.actorResolver` (the per-agent resolver is preferred when present, falling back to the global otherwise).

## 0.13.3

### Patch Changes

- [`22b207e`](https://github.com/DavideCarvalho/adonis-agent/commit/22b207ed263192e8a34922b08d04821f3fa61d8d) - Tool discovery no longer aborts the whole scan when one tool file fails to import.

  The `app/agent_tools` readdir scan imported each file with no per-file guard, so a single tool whose module throws at import time (e.g. a top-level `@adonisjs/*/services/*` singleton resolving `app` as `undefined` during boot) took down the entire scan and left the agent with ZERO tools — which surfaces as the model "narrating" tool calls as text (it was never given any tools) rather than any visible error. Each import is now wrapped: a failing file is logged loudly (`app.logger`, else `console.error`) and skipped, so the other tools still register and the failure is diagnosable.

## 0.13.2

### Patch Changes

- [`88f70d8`](https://github.com/DavideCarvalho/adonis-agent/commit/88f70d851070767a70b1b1c7278a1a1e01f578f2) - Fix `tokenSinks.redis()` crashing at boot with "Cannot read properties of undefined (reading 'booted')".

  The Redis sink factory built its client by importing `@adonisjs/redis/services/main`, whose module-level `app` is `undefined` when the sink is resolved during `AgentProvider.boot` — so the sink threw at boot and, under `durable: true`, the first frame write hung (runs stuck at step 0). The sink factory now receives the app context (like store/quota factories) and resolves Redis via `app.container.make('redis')` with the live application, so it builds correctly. `SinkFactory` / `TokenSinkFactory` now take a `{ app }` context argument (a no-arg factory stays assignable, so existing custom sink factories keep working).

## 0.13.1

### Patch Changes

- [`293843c`](https://github.com/DavideCarvalho/adonis-agent/commit/293843c7fc6082453b80ab4b5272ca3cd31da887) - Redis token-stream sink: expire a run's replay keys instead of leaking them.

  The framework never calls the sink's `close()`, so the Redis multi-replica sink's per-run `chunks`/`state` keys accumulated forever. They now get a TTL (default **1h**, sliding window refreshed on every write — so a long run stays alive and a crashed run that never `end`s still expires). Configurable via `tokenSinks.redis({ ttlSeconds })`; set `0` to keep the previous retain-forever behaviour. Adds an optional `expire(key, seconds)` to the `RedisStreamClient` interface (the `@adonisjs/redis` adapter implements it; a bring-your-own client that omits it keeps working, just without the TTL).

## 0.13.0

### Minor Changes

- [`b684986`](https://github.com/DavideCarvalho/adonis-agent/commit/b68498606a02e82dc92d01a7aa139eb6ba752bee) - Add a framework-agnostic browser client and a React hook for the chat SSE endpoints.

  Consuming the agent's SSE envelope (`POST /agent/chat` → `event: meta` / `data: {delta}` / `event: component` / `event: done`) and reconnecting a dropped stream used to be re-implemented by hand in every app. Two new entry points move that logic into the package, next to the server that emits the envelope:

  - **`@adonis-agora/agent/client`** — zero-dependency, isomorphic. `createAgentChatClient({ basePath, fetch, getHeaders, resume })` returns `send()` / `resume()` that post a turn, parse the envelope, capture the run id, and — when the connection drops before `done` — re-attach to `GET /agent/chat/:runId/stream` (which replays the whole stream from the start and follows live) with backoff, until the run finishes or the retry budget is exhausted. The run is durable and keeps executing server-side across the drop, so no tokens are lost. Also exports the parsing primitives (`parseSseEvent`, `decodeFrame`, `foldPart`, `readSseStream`) and `AgentChatDisconnectedError` (which carries the partial parts).
  - **`@adonis-agora/agent/react`** — `useAgentChat({ ...clientOptions, buildBody })` returning `{ messages, status, error, send, cancel }`, a thin state wrapper over the client. `react` is a new optional peer dependency.

## 0.12.0

### Minor Changes

- [`0998975`](https://github.com/DavideCarvalho/adonis-agent/commit/0998975ca76b88c84b5e428139af0f363f28abbb) - Generative UI: typed stream frames (`text`|`component`), `AiToolCtx.emitComponent`, and `event: component` in the SSE provider. Backward compatible for text-only consumers.

### Patch Changes

- [#29](https://github.com/DavideCarvalho/adonis-agent/pull/29) [`fd77544`](https://github.com/DavideCarvalho/adonis-agent/commit/fd77544040bdf8d95c532f3f70c6bd7673cec4ca) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix agent tool-loop dropping tool results. `mapMessages` in the AI SDK adapter skipped `toolResults` on `role: 'user'` messages (early `continue`), but `agent-loop` feeds tool output back as a synthetic `{ role: 'user', content: '', toolResults }` carrier — so the results were silently dropped and the follow-up model call threw `AI_MissingToolResultsError`. The user branch now emits the `tool` result message (via a shared `pushToolResults` helper) and skips the empty user turn so the tool result stays adjacent to the assistant tool-call. Multi-step tool-calling now completes for OpenAI-compatible providers.

## 0.11.0

### Minor Changes

- [#31](https://github.com/DavideCarvalho/adonis-agent/pull/31) [`315eb41`](https://github.com/DavideCarvalho/adonis-agent/commit/315eb41839bff2903e96481e7ca98881accdd8cd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Tools de classe agora são instanciados pelo **container do Adonis**, então `@inject` no construtor funciona — o app deixa de fazer service-locator (`app.container.make(...)`) dentro do `execute()`.

  ```ts
  @inject()
  export default class ReatribuirPesquisa extends ActionTool<Input, Result> {
    constructor(private allocation: CoordinatorAllocationService) {
      super();
    }
    static tool = {
      name: "reatribuir_pesquisa",
      description: "…",
      input,
      ability,
    };
    async execute(input, ctx) {
      return this.allocation.reassign({
        ...input,
        coordinatorId: ctx.actor.id,
      });
    }
  }
  ```

  A resolução é **lazy** (no primeiro `execute`) e cacheada: a descoberta roda no `boot()` do provider, antes do app estar totalmente booted, então um `container.make()` eager poderia falhar resolvendo um peer service — o mesmo motivo pelo qual a store factory do Lucid resolve lazy. Tools sem dependências continuam funcionando iguais.

  `discoverTools`, `registerToolsFromBarrel` e `registerToolExport` aceitam um `app?: ApplicationService` opcional (o provider passa `this.app`); sem ele, o comportamento pré-DI (`new Ctor()`) é preservado. `registerToolExport` continua síncrono.

## 0.10.1

### Patch Changes

- [#29](https://github.com/DavideCarvalho/adonis-agent/pull/29) [`6f0465d`](https://github.com/DavideCarvalho/adonis-agent/commit/6f0465d0fcedd3f826687154f60317d180e56651) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix agent tool-loop dropping tool results. `mapMessages` in the AI SDK adapter skipped `toolResults` on `role: 'user'` messages (early `continue`), but `agent-loop` feeds tool output back as a synthetic `{ role: 'user', content: '', toolResults }` carrier — so the results were silently dropped and the follow-up model call threw `AI_MissingToolResultsError`. The user branch now emits the `tool` result message (via a shared `pushToolResults` helper) and skips the empty user turn so the tool result stays adjacent to the assistant tool-call. Multi-step tool-calling now completes for OpenAI-compatible providers.

## 0.10.0

### Minor Changes

- [#27](https://github.com/DavideCarvalho/adonis-agent/pull/27) [`426b504`](https://github.com/DavideCarvalho/adonis-agent/commit/426b5040203fae41bb6a6fcc79ac5dbc0e9bc0ad) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Novas bases kind-específicas `ReadTool` e `ActionTool` (além do `BaseTool`): fixam o `kind` no base, então a subclasse escreve `static tool = { name, description, input, ability }` **truly bare** — sem `satisfies AiToolOptions` e sem a anotação `: AiToolOptions`. Antes o `kind: 'read' | 'action'` do `BaseTool`/`AiToolOptions` forçava um dos dois (a estática herdada não dá contextual-typing, então o literal alargaria `kind` para `string`). A descoberta lê o `kind` da estática do base. Exporta também `BaseToolOptions` (= `Omit<AiToolOptions, 'kind'>`).

## 0.9.0

### Minor Changes

- [#25](https://github.com/DavideCarvalho/adonis-agent/pull/25) [`e726f1f`](https://github.com/DavideCarvalho/adonis-agent/commit/e726f1fdcc13e479ffc10c150dc4148bc18efdfb) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Novo `BaseTool` (classe base opcional para a forma de classe de um tool) — o análogo do `BaseWorkflow` do durable. Declarar `static tool = { … }` numa subclasse de `BaseTool` é type-checado pela estática herdada (`static tool?: AiToolOptions`), sem precisar de `satisfies AiToolOptions`. `ToolHandler<I, O = unknown>` e `defineTool<I, O>` passam a tipar o retorno do `execute` (antes `Promise<unknown>`), então o compilador confere o corpo contra o que o tool promete. Ambos non-breaking (defaults preservam o comportamento anterior).

## 0.8.0

### Minor Changes

- [#23](https://github.com/DavideCarvalho/adonis-agent/pull/23) [`19c9ffd`](https://github.com/DavideCarvalho/adonis-agent/commit/19c9ffd9c285c7cab4e487c8bda73f7ce668be9e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `authzActorResolver` (exported from `@adonis-agora/agent/authz`) — resolve the agent `Actor` from the Agora context populated by authkit (`userRef`, `tenantId`) plus authz `effectiveRoles` (the union global ∪ app ∪ store). Structural, zero hard dependency; authkit+authz apps can drop hand-written actor resolvers. Fail-closed: no identity in context → 401.

## 0.7.1

### Patch Changes

- [#21](https://github.com/DavideCarvalho/adonis-agent/pull/21) [`d02b26b`](https://github.com/DavideCarvalho/adonis-agent/commit/d02b26bea2acd8d6f7daac166116a6813d321a02) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Internal: simplify `readAiToolMeta` metadata resolution

  Refactor the tool-metadata lookup so the two authoring mechanisms (`@AiTool`
  decorator and `static tool`) and the two subjects (the value, its constructor)
  are composed explicitly — `metaOn(target) ?? metaOn(ctor)` — instead of a flat
  four-way fallback chain. No behavior or API change; discovery of both forms is
  unchanged (mutation-proven).

## 0.7.0

### Minor Changes

- [#19](https://github.com/DavideCarvalho/adonis-agent/pull/19) [`c3d7b14`](https://github.com/DavideCarvalho/adonis-agent/commit/c3d7b140cdf32ef4324e18d84a13860ff0eb1a7c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add a decorator-free `static tool` authoring form for class tools

  A tool class can now declare its metadata with a `static tool = { name, kind, description, input, … }`
  config instead of the `@AiTool({ … })` decorator — the same shape, mirroring
  `@adonis-agora/durable`'s `static workflow`. Discovery, registration, and execution are identical;
  `readAiToolMeta` now reads the static config when no decorator is present.

  ```ts
  import type {
    AiToolCtx,
    AiToolOptions,
    ToolHandler,
  } from "@adonis-agora/agent";
  import { z } from "zod";

  export default class GetWeather implements ToolHandler<{ city: string }> {
    static tool = {
      name: "getWeather",
      kind: "read",
      description: "Get the weather",
      input: z.object({ city: z.string() }),
    } satisfies AiToolOptions;

    async execute(input: { city: string }, ctx: AiToolCtx) {
      return { tempC: 21 };
    }
  }
  ```

  The `@AiTool` decorator and the functional `defineTool(...)` forms are unchanged.

## 0.6.0

### Minor Changes

- [#17](https://github.com/DavideCarvalho/adonis-agent/pull/17) [`ea6122f`](https://github.com/DavideCarvalho/adonis-agent/commit/ea6122f468f5308d3506461fb2bd2d7fc3159ef5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Owner-scope the per-actor run/thread routes (object-level authorization)

  Follows up `0.5.0` (which authenticated these routes) by adding the ownership check: authentication
  alone let any authenticated caller act on ANOTHER actor's run/thread by id. Now a caller may act only
  on runs/threads it OWNS, unless it is governance-privileged.

  - **Run routes** — `GET /agent/chat/:runId/stream`, `POST /agent/chat/:runId/cancel`,
    `POST /agent/tool-call/approve`, `POST /agent/tool-call/reject` — now assert the resolved actor owns
    the run (the run's `actor_ref`, recorded as the loop's first step). A non-owner gets `403`; an
    unknown run gets `404` (so an id the caller doesn't own is never confirmed).
  - **Thread routes** — `GET /agent/threads/:id`, `DELETE /agent/threads/:id`,
    `POST /agent/threads/:id/fork-from/:messageId`, and `POST /agent/chat` when it continues an existing
    thread (`body.threadId`) — now assert the actor owns the thread. The chat case is the important one:
    without it an authenticated caller could pass another actor's `threadId` to load that thread's full
    history into the model (and read it back over SSE) and append its own turn into the victim's thread.
  - **Cross-actor override.** A caller that passes `governanceAuthorize` (the app's "may act across
    actors" seam, typically an ADMIN check) may act on any run/thread. With no `governanceAuthorize`
    configured, ownership is strict — no cross-actor access.

  New `AgentStore` SPI methods back the checks: **`getRunActorRef(runId)`** and
  **`getThreadActorRef(threadId)`** (both return the owning `actor_ref` or `null`), implemented on the
  Lucid and in-memory stores. A custom `AgentStore` implementation must add them. Also exposes the
  router-free `evaluateOwnership` helper and the `OwnershipVerdict` type, and `AgentService.runOwner` /
  `AgentService.threadOwner` passthroughs.

## 0.5.0

### Minor Changes

- [#14](https://github.com/DavideCarvalho/adonis-agent/pull/14) [`5de6247`](https://github.com/DavideCarvalho/adonis-agent/commit/5de6247c95a1f92fc92ba89bd1eaa2e89d0ba4ba) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Authenticate the mutation/lifecycle routes and gate the cross-actor governance read-model

  Closes a privilege gap surfaced the first time the routes were mounted behind a real app's
  auth. Previously several `/agent/*` routes were reachable without resolving an actor, and the
  `/agent/governance/*` read-model was readable by any authenticated caller regardless of role.

  - **Every `/agent/*` route now resolves the actor (401 on failure).** `chat/:runId/stream`,
    `chat/:runId/cancel`, `tool-call/approve`, `tool-call/reject`, `threads/personas/catalog`,
    `threads/:id` (GET/DELETE), and `threads/:id/fork-from/:messageId` previously ran with no
    actor resolution — an anonymous same-origin request could re-attach a run's token stream,
    cancel a run, or deliver a HITL approve/reject decision. They now go through the same resolver
    (and 401) as `chat`/`threads`/`quota`. The stream route authenticates via the request's
    session/cookies, so an `EventSource` re-attach still works. Apps that configured an
    `actorResolver` (the norm) are unaffected on legitimate calls; an app with no resolver now
    correctly 401s these routes instead of serving them anonymously.

  - **New `governanceAuthorize?: (actor, ctx) => boolean | Promise<boolean>` config option.** When
    set, each `/agent/governance/*` route runs it after resolving the actor and replies `403` on
    deny (fail-closed if it throws) — so the platform-wide spend/usage/threads/approvals read-model
    can be restricted (typically ADMIN-only). Omitted, governance stays readable by any resolved
    actor (the historical behavior). Mirrors `@adonis-agora/agent-dashboard`'s `authorize` hook so
    the JSON routes and the console SPA can be gated with the same predicate. Exposed as
    `evaluateGovernanceGate` (a router-free, unit-tested helper) and the `AgentGovernanceAuthorize`
    / `GovernanceGateVerdict` types.

  - **New `GET /agent/approvals/mine` route.** Returns the calling actor's OWN pending HITL
    approvals (`pendingApprovals({ actor })`, filtered by the owning run's `actor_ref`). It is
    mounted with the governance read-model but is NOT behind `governanceAuthorize`, so a non-admin
    surface (e.g. a coordinator's chat) can poll its own suspended tool calls even while the
    cross-actor `governance/approvals/pending` inbox is ADMIN-only.

## 0.4.1

### Patch Changes

- [#8](https://github.com/DavideCarvalho/adonis-agent/pull/8) [`8763c29`](https://github.com/DavideCarvalho/adonis-agent/commit/8763c29c43c4f766bc3f80e25d6e19f4e0c8aa6e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix `app/agent_tools` discovery registering nothing in a dev/TypeScript app

  The `app/agent_tools` scanner picked which module extension to import from
  `extname(import.meta.url)` — the extension of the SCANNER's own file. Since the
  package ships compiled (`.js`), that was always `.js`, so an app running from
  TypeScript source under a loader (`app/agent_tools/*.ts`, no build barrel wired)
  had its directory scanned for `.js` files, matched none, and registered zero
  tools — the agent silently ran with an empty `ToolRegistry`.

  The extension is now derived from what the scanned directory actually holds
  (`.ts` when it has any non-declaration `.ts` file, else `.js`). At runtime an app
  runs from EITHER its source or its build — never both in one directory — so this
  still guarantees a built `.js` and a dev `.ts` of the same module never
  double-register. `.d.ts` declarations are still skipped.

## 0.4.0

### Minor Changes

- [#6](https://github.com/DavideCarvalho/adonis-agent/pull/6) [`363382b`](https://github.com/DavideCarvalho/adonis-agent/commit/363382b5bd182f8de6184cd1c509209113710111) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `pricingStore` and `governanceQueries` now default to mirroring the main `store`.

  When `store` is a `stores.lucid()` store, the agent now defaults the pricing store and the governance read-model to a Lucid store on the **same connection** (tables auto-created) with no extra config — so cost tracking and the `/agent/governance/*` routes work out of the box. Previously both were opt-in and omitting them left cost `null` and the governance routes unmounted.

  - Override by passing a factory/instance as before (e.g. a different connection, or `pricingStores.memory()` for tests).
  - Set `pricingStore: false` / `governanceQueries: false` to disable (cost stays `null`; governance routes not mounted).
  - When the main store is not Lucid, both stay off unless set explicitly.

  Adds `lucidStoreConnection(factory)` to read a `stores.lucid()` factory's connection (used internally for the mirroring). The `@adonis-agora/agent` peer range on `@adonis-agora/agent-dashboard` widens to `^0.4.0`.

## 0.3.1

### Patch Changes

- [#4](https://github.com/DavideCarvalho/adonis-agent/pull/4) [`487ad72`](https://github.com/DavideCarvalho/adonis-agent/commit/487ad7265d512ab27b67a5b25802591f8719923c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix an app-boot crash when configuring the Lucid store, pricing store, or governance read-model via the factory helpers.

  `stores.lucid()`, `pricingStores.lucid()`, `governanceQueries.lucid()`, and the pgvector retriever resolved the Lucid `Database` from `@adonisjs/lucid/services/db`'s default export. AdonisJS assigns that default only inside `app.booted()` — after every provider's `boot()` — but the agent provider builds these stores eagerly during its own `boot()`, so the default was still `undefined` and `db.connection(...)` threw a `TypeError`, failing the whole app boot. They now resolve the `Database` from the container via the `'lucid.db'` alias (registered in the database provider's `register()`, so it is available during boot) — the same binding `services/db` itself resolves. No public API change.

## 0.3.0

### Minor Changes

- [#2](https://github.com/DavideCarvalho/adonis-agent/pull/2) [`3ed796f`](https://github.com/DavideCarvalho/adonis-agent/commit/3ed796f5106416726526651088fb98c1d2495172) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `autoCreateTables` now defaults to **`true`** for the Lucid stores — the agent lib manages its own
  schema by default, completing the ecosystem convention (mirrors `@adonis-agora/durable` and
  `@adonis-agora/authz`). On first use a store provisions the six shared agent tables with `CREATE
TABLE IF NOT EXISTS`; set `autoCreateTables: false` (on `stores.lucid`, `pricingStores.lucid`, or
  `governanceQueries.lucid`) to opt out and run the published migration instead.

  Crucially, provisioning is no longer the agent store's job alone: the **pricing store** and the
  **governance read-model** also auto-provision on first use, sharing one memoized `CREATE TABLE` pass
  per db client (new exported `ensureAgentTables`). This closes two real gaps — seeding model prices
  before the first agent run, and opening the governance dashboard on a fresh deploy — that the
  store-only auto-create left broken.

  The dashboard's peer range is bumped to `@adonis-agora/agent@^0.3.0`.

## 0.2.0

### Minor Changes

- [`f1fea00`](https://github.com/DavideCarvalho/adonis-agent/commit/f1fea00e165ef6d106fa67ed9ceda6e03ddbca3b) - Suporta `@adonis-agora/durable` 0.8.x (o peer passa de `^0.7.0` para `^0.8.0`).

  O durable 0.8.0 removeu o decorator `@Workflow`, que o `AgentRunWorkflow` usava, em favor de
  `BaseWorkflow` + `static workflow = { name, version }`. Instalar agent 0.1.0 ao lado de durable
  0.8.0 derrubava o modo durable inteiro — `TypeError: (0 , Workflow) is not a function` ao carregar
  o módulo, com o provider caindo silenciosamente no runner inline. O `^0.7.0` barrava a combinação,
  então ninguém instalou os dois juntos; o preço era ficar preso ao durable 0.7.

  O `AgentRunWorkflow` agora estende `BaseWorkflow` e declara `static workflow`. O resto da
  integração (`WorkflowEngine.start/signal/cancel`, `registerWorkflowClass`, `WorkflowSuspended`,
  `ContinueAsNew`, `WorkflowCtx`) não mudou.

  O bug nasceu de um vão de teste: o `durable` não era devDependency, então o lockfile resolvia
  0.7.0 e a suíte exercitava o runner durable contra a versão antiga — verde e cega para o 0.8.0.
  Agora é devDependency em `^0.8.0`, e os testes rodam contra a mesma versão que o peer promete.
