---
'@adonis-agora/agent': minor
---

**Experimental** — a reference Personal Agent for the Personal Agent Protocol ("Poppy", Draft 0.1): the library at `@adonis-agora/agent/poppy-client` and the `poppy-agent` CLI (a `bin` of this package). Discovery, agent identity (`private_key_jwt`), DPoP Sessions, Direct/Device/Mediated sign-in, Account Tokens, OpenAPI/MCP APIs, conversations (SSE + long-poll), browser sessions and an LLM `ask` mode — to test Poppy companies end to end, with `--insecure-dev` for a local http app. The module tree is framework-agnostic (no AdonisJS imports; a test enforces it). Moved from the unpublished `@adonis-agora/poppy-agent` package. Tracks Draft 0.1 and will change as the spec evolves.
