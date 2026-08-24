---
'@adonis-agora/agent': patch
'@adonis-agora/agent-dashboard': patch
---

Add TanStack Intent agent skills. Both packages now ship a `skills/` directory
(five skills under @adonis-agora/agent: setup, tools, governance, personas &
multi-agent delegation, offline testing; one under @adonis-agora/agent-dashboard:
the governance console client) that coding agents can load as structured,
verified documentation. The directories are included in each package's `files`
allowlist, and `@tanstack/intent` is added as a devDependency so CI can enforce
skill validity via `intent validate`.
