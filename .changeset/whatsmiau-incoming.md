---
"@adonis-agora/agent": patch
---

channels: `whatsmiau()` / `evolutionApi()` read Whatsmiau's incoming messages, which carry no `fromMe` (Go `omitempty`) — a message without `fromMe` counts as incoming only with `status: 'received'`; `fromMe: true` and any other status stay ignored. `key.remoteLid` is recognized as the chat's LID alias. The handler now logs a webhook that parsed to no message (event and reason, no content; `warn` when it looked like a person's message, else `debug`), with the reason from the new optional `ChannelAdapter.ignored(body)`.

`whatsmiau()` no longer appends the text reply instruction to the buttons message (its buttons render); `evolutionApi({ buttons: true })` still does, and the text fallback (a 4xx, or buttons off) keeps the full instruction.
