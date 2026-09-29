---
'@adonis-agora/agent': minor
---

Typed elicitation inputs, matching `@dudousxd/nestjs-agent`: a question can ask for a value with `input: { type: 'text' | 'textarea' | 'number' | 'boolean' | 'date' | 'email' | 'url' | 'select', placeholder?, required?, min?, max?, pattern? }` and a `description`; `options` is optional for a typed question and `defaults` only required when there is a sensible pre-pick. Answers stay `string[]` in one canonical form. `POST /agent/tool-call/answer` refuses a value a question's rules refuse, or a `required` question left empty, with `400` `answers["<id>"] <reason>` (via the new optional `AgentStore.toolCallInput`, implemented by the Lucid and in-memory stores); the loop drops the same values from whatever reaches it. `validateElicitationValue`, `validateElicitationAnswer`, `readElicitationQuestions` and friends are exported.
