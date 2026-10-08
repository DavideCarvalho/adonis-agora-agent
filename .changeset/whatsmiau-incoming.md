---
"@adonis-agora/agent": patch
---

channels: `whatsmiau()` / `evolutionApi()` read Whatsmiau's incoming messages, which carry no `fromMe` (Go `omitempty`) — a message without `fromMe` counts as incoming only with `status: 'received'`; `fromMe: true` and any other status stay ignored. `key.remoteLid` is recognized as the chat's LID alias. The handler now logs a webhook that parsed to no message (event and reason, no content; `warn` when it looked like a person's message, else `debug`), with the reason from the new optional `ChannelAdapter.ignored(body)`.

`whatsmiau()` no longer appends the text reply instruction to the buttons message (its buttons render); `evolutionApi({ buttons: true })` still does, and the text fallback (a 4xx, or buttons off) keeps the full instruction.

A Whatsmiau button press arrives without its id (`buttonsResponseMessage` with only the label): the adapter marks it `buttonWithoutId`, and the handler maps the label to the one still-pending proposal card it sent to that conversation (remembered in the channel store); with several, it falls back to the text decision. The outcome message admitted to the thread leads with the tool's presentation text and no longer includes the proposal id (`Action "x" completed. Result: …`). Warmer pt-BR replies in `ptBrActionProposalText` ("Confirmado! Já estou cuidando disso.", "Tudo bem, cancelado. Nada foi feito.", "Esse pedido expirou; nada foi feito.").
