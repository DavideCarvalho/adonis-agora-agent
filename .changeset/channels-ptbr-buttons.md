---
"@adonis-agora/agent": minor
---

Text channels: Brazilian Portuguese texts, self-sufficient buttons, and LID chats replied to by phone.

- `ptBrChannelTexts` (and `ptBrChannelQuestionTexts`) ship next to `DEFAULT_CHANNEL_TEXTS`. When the agent's `actionProposalText` is `ptBrActionProposalText` (its vocabulary now carries `language: 'pt-BR'`), `channels.handle` starts from the Portuguese texts, so the reply words ("sim"/"não") and what the channel says agree; `texts` overrides that base part by part. `channelTextsFor(vocabulary)` returns the set picked.
- A buttons message now carries the text reply instruction (`OutboundMessage.instruction`); `evolutionApi` puts it in the buttons description, so a phone that shows no buttons can still answer by text.
- New `whatsmiau()` adapter, exported next to `evolutionApi`: the same Evolution-format implementation for [Whatsmiau](https://github.com/verbeux-ai/whatsmiau) (built on whatsmeow), with reply buttons on by default (they render; Evolution's Baileys `nativeFlow` buttons were not shown at all on the phone in testing with 2.3.7) and the `/v1` route prefix added to a host-only `url` (a url already ending in `/v1`, `/v2`… is kept). `evolutionApi` keeps buttons off by default.
- `evolutionApi` LID chats: with `key.remoteJidAlt` (or `senderPn`) present, `conversation` is now the phone jid instead of the `@lid` jid, so replies are sent to the phone number and a chat keeps one conversation id whether it arrives addressed by phone or by LID. Conversation → thread mappings stored under a `@lid` jid start a new thread.
