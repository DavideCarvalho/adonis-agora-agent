---
'@adonis-agora/agent': minor
---

Guardrails, and processors you can actually configure

- **`@adonis-agora/agent/guardrails`** — PII (Luhn-validated cards, CPF/CNPJ, SSN, IBAN, phones, emails, IPv4), secret (provider key formats, JWT, PEM, entropy-gated assignments), prompt-injection (EN / PT-BR / ES, hidden Unicode, encoded payloads) and tool-poisoning detectors; a rule engine with `allow`/`log`/`redact`/`approve`/`block`, fail modes and reversible redaction (`Vault`); and `createGuardrails(options)`, which runs it on the loop's processor seams — `guardrails.input` / `guardrails.output`, `wrapTool` for tool arguments, `screenTool` for tool definitions — with per-call rule resolution (per tenant) and an audit hook. A port of `@dudousxd/nestjs-agent-core/guardrails`.
- **`inputProcessors` / `outputProcessors` in `config/agent.ts`.** The loop has taken processors since they were ported, but nothing between the config and the loop carried them, so an app using the provider could not register one. They now reach every agent's turn, inline and durable.
- **`mcpServers[].screen`** — inspect each listed tool definition before it is imported, and skip the ones it refuses (a screen that throws skips the tool too).
