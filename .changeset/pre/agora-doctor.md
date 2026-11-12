---
"@adonis-agora/agent": minor
---

`node ace agora:doctor` (and `agent:doctor`). The agent now has a commands barrel (`@adonis-agora/agent/commands`, which `node ace configure @adonis-agora/agent` adds to `adonisrc.ts`; existing apps add `commands: [() => import('@adonis-agora/agent/commands')]` by hand). It ships the shared Agora health check and registers its checks into the `'agora.doctor'` registry: `agent.console-gate`, `agent.actor-resolver`, `agent.mcp-open`, `agent.mcp-execute`, `agent.mcp-csrf`, `agent.dev-tools-gate` and `agent.tenancy-store`. The new `@adonis-agora/agent/doctor` entry serves `--no-boot`.
