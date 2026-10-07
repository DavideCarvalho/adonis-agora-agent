---
"@adonis-agora/agent": minor
---

Text channels: Brazilian Portuguese texts, self-sufficient buttons, and LID chats replied to by phone.

- `ptBrChannelTexts` (and `ptBrChannelQuestionTexts`) ship next to `DEFAULT_CHANNEL_TEXTS`. When the agent's `actionProposalText` is `ptBrActionProposalText` (its vocabulary now carries `language: 'pt-BR'`), `channels.handle` starts from the Portuguese texts, so the reply words ("sim"/"não") and what the channel says agree; `texts` overrides that base part by part. `channelTextsFor(vocabulary)` returns the set picked.
- A buttons message now carries the text reply instruction (`OutboundMessage.instruction`); `evolutionApi` puts it in the buttons description, so a phone that shows no buttons can still answer by text.
- `evolutionApi({ provider: 'evolution' | 'whatsmiau' })`: buttons default on for Whatsmiau (whatsmeow renders them) and stay off for Evolution, whose Baileys `nativeFlow` buttons were not shown at all on the phone in testing with 2.3.7.
- `evolutionApi` LID chats: with `key.remoteJidAlt` (or `senderPn`) present, `conversation` is now the phone jid instead of the `@lid` jid, so replies are sent to the phone number and a chat keeps one conversation id whether it arrives addressed by phone or by LID. Conversation → thread mappings stored under a `@lid` jid start a new thread.
