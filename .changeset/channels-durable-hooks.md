---
'@adonis-agora/agent': minor
---

Text channels: durable processing, scoped decisions and hooks.

- **Durable processing.** With the agent on `@adonis-agora/durable` (`durable: true`), each inbound message is persisted as an `agora.channel.job` run before the webhook's `200`, handled one at a time per conversation (a singleton per channel conversation), in checkpointed, retried phases, and resumed after a crash — the turn is never started twice and the reply of a turn that finished while the process was down is still sent, once. Every outgoing message takes a slot in the channel store, so nothing is sent twice when work runs again. Without an engine the same pipeline runs in-process (ordered per conversation, retried, nothing survives a restart). New options `durable` and `retry`; `handler.handleRequest(request)`.
- **Scoped text decisions.** "yes", "no #ID" and button labels only decide proposals whose card was delivered to that channel conversation; anything else gets `texts.noPendingConfirmation`. The channel starts turns with the new `AgentService.send(params, { textDecisions: false })`.
- **Hooks:** `unknownSender`, `beforeTurn`, `canDeliver`, `texts` as a function of the actor/message, `onTurnStarted`, `uiCapabilities` + `renderComponent` (components as files), `mediaLimits` / `prepareMedia` / `transformInbound`, `formatOutcome` (outcome plus raw follow-ups, relayed once, in order), `texts.footer` for cards, `allowRemember: false`, and `onWebhook` (accepted / duplicate / ignored / unauthorized / failed).
- **Outbound files** (`OutboundMessage.media`, `capabilities.media`) in `evolutionApi` / `whatsmiau` (`sendMedia`), `whatsappCloud` (link or upload) and `telegram` (`sendPhoto` / `sendDocument` / …), and card footers on the providers that have them.
